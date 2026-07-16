import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectRecord, TaskRecord } from "./types.ts";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function now(): string {
  return new Date().toISOString();
}

export function projectIdForRoot(projectRoot: string): string {
  return `project-${createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16)}`;
}

export function defaultLeadStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.PI_LEAD_STATE_DIR || join(homedir(), ".pi", "lead-orchestration"));
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function withFileLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const started = Date.now();
  while (true) {
    try {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${targetPath}`);
      await pause(LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export class LeadStore {
  readonly root: string;

  constructor(stateDir = defaultLeadStateDir()) {
    this.root = resolve(stateDir);
  }

  projectDirectory(projectId: string): string {
    return join(this.root, "projects", projectId);
  }

  worktreeDirectory(projectId: string, taskId: string): string {
    return join(this.root, "worktrees", projectId, taskId);
  }

  taskArtifactDirectory(projectId: string, taskId: string): string {
    return join(this.projectDirectory(projectId), "tasks", taskId);
  }

  private projectPath(projectId: string): string {
    return join(this.projectDirectory(projectId), "project.json");
  }

  private taskPath(projectId: string, taskId: string): string {
    return join(this.taskArtifactDirectory(projectId, taskId), "task.json");
  }

  async initialize(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "projects"));
    await privateDirectory(join(this.root, "worktrees"));
  }

  async readProject(projectId: string): Promise<ProjectRecord | undefined> {
    return readJson<ProjectRecord>(this.projectPath(projectId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  async saveProject(record: ProjectRecord): Promise<ProjectRecord> {
    const updated = { ...record, updatedAt: now() };
    await withFileLock(this.projectPath(record.projectId), () => atomicJson(this.projectPath(record.projectId), updated));
    return updated;
  }

  async ensureProject(input: {
    projectRoot: string;
    projectName: string;
    leadSessionFile?: string;
    cmuxWorkspaceId?: string;
    cmuxSurfaceId?: string;
  }): Promise<ProjectRecord> {
    await this.initialize();
    const projectId = projectIdForRoot(input.projectRoot);
    const path = this.projectPath(projectId);
    return withFileLock(path, async () => {
      const existing = await this.readProject(projectId);
      const timestamp = now();
      const cmux = input.cmuxWorkspaceId && input.cmuxSurfaceId
        ? {
            workspaceId: input.cmuxWorkspaceId,
            callerSurfaceId: input.cmuxSurfaceId,
            helperPaneId: existing?.cmux?.workspaceId === input.cmuxWorkspaceId
              ? existing.cmux.helperPaneId
              : undefined,
          }
        : existing?.cmux;
      const project: ProjectRecord = {
        schemaVersion: 2,
        projectId,
        projectRoot: resolve(input.projectRoot),
        projectName: input.projectName,
        leadSessionFile: input.leadSessionFile ?? existing?.leadSessionFile,
        cmux,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await atomicJson(path, project);
      return project;
    });
  }

  async createTask(task: TaskRecord): Promise<void> {
    const path = this.taskPath(task.projectId, task.id);
    await privateDirectory(this.taskArtifactDirectory(task.projectId, task.id));
    await access(path).then(
      () => { throw new Error(`Task already exists: ${task.id}`); },
      () => undefined,
    );
    await atomicJson(path, task);
  }

  async readTask(projectId: string, taskId: string): Promise<TaskRecord | undefined> {
    return readJson<TaskRecord>(this.taskPath(projectId, taskId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  async requireTask(projectId: string, taskIdOrPrefix: string): Promise<TaskRecord> {
    const exact = await this.readTask(projectId, taskIdOrPrefix);
    if (exact) return exact;
    const matches = (await this.listTasks(projectId)).filter((task) => task.id.startsWith(taskIdOrPrefix));
    if (matches.length === 0) throw new Error(`Unknown worker task: ${taskIdOrPrefix}`);
    if (matches.length > 1) throw new Error(`Ambiguous worker task prefix: ${taskIdOrPrefix}`);
    return matches[0];
  }

  async updateTask(
    projectId: string,
    taskId: string,
    update: (current: TaskRecord) => TaskRecord | Promise<TaskRecord>,
  ): Promise<TaskRecord> {
    const path = this.taskPath(projectId, taskId);
    return withFileLock(path, async () => {
      const current = await readJson<TaskRecord>(path);
      const next = { ...(await update(current)), updatedAt: now() };
      await atomicJson(path, next);
      return next;
    });
  }

  async listTasks(projectId: string): Promise<TaskRecord[]> {
    const tasksDirectory = join(this.projectDirectory(projectId), "tasks");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const tasks = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readTask(projectId, entry.name)));
    return tasks
      .filter((task): task is TaskRecord => task !== undefined && task.schemaVersion === 2)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export function createTaskId(): string {
  return randomUUID();
}
