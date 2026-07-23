import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LegacyV2Descriptor, V4ProjectState, V4SupervisorConfig } from "./types.ts";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export const DEFAULT_V4_CONFIG: V4SupervisorConfig = Object.freeze({
  maxConcurrentLeads: 3,
  maxConcurrentWorkerProcesses: 4,
  attachmentLeaseSeconds: 20,
  processHeartbeatSeconds: 20,
  digestLimit: 50,
  automaticWorkerSurfaceRetirement: false,
});

function now(): string {
  return new Date().toISOString();
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

export function effectiveV4Config(value?: Partial<V4SupervisorConfig>): V4SupervisorConfig {
  return {
    ...DEFAULT_V4_CONFIG,
    ...value,
    maxConcurrentLeads: bounded(value?.maxConcurrentLeads, DEFAULT_V4_CONFIG.maxConcurrentLeads, 1, 32),
    maxConcurrentWorkerProcesses: bounded(value?.maxConcurrentWorkerProcesses, DEFAULT_V4_CONFIG.maxConcurrentWorkerProcesses, 1, 128),
    attachmentLeaseSeconds: bounded(value?.attachmentLeaseSeconds, DEFAULT_V4_CONFIG.attachmentLeaseSeconds, 5, 600),
    processHeartbeatSeconds: bounded(value?.processHeartbeatSeconds, DEFAULT_V4_CONFIG.processHeartbeatSeconds, 5, 600),
    digestLimit: bounded(value?.digestLimit, DEFAULT_V4_CONFIG.digestLimit, 1, 200),
    automaticWorkerSurfaceRetirement: value?.automaticWorkerSurfaceRetirement === true,
  };
}

export function v4ProjectId(projectRoot: string): string {
  return `project-${createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16)}`;
}

export function defaultV4StateDir(environment: NodeJS.ProcessEnv = process.env): string {
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

function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const started = Date.now();
  while (true) {
    try {
      await privateDirectory(dirname(lock));
      const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [info, ownerText] = await Promise.all([
        stat(lock).catch(() => undefined),
        readFile(lock, "utf8").catch(() => ""),
      ]);
      const ownerValid = /^\d+$/.test(ownerText.trim());
      const ownerPid = ownerValid ? Number(ownerText.trim()) : 0;
      const staleUnknownOwner = info && Date.now() - info.mtimeMs > LOCK_STALE_MS && !ownerValid;
      if ((ownerValid && ownerPid > 0 && !livePid(ownerPid)) || staleUnknownOwner) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for V4 state lock: ${path}`);
      await pause(25);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { force: true });
  }
}

async function readLegacyDescriptors(projectDirectory: string): Promise<LegacyV2Descriptor[]> {
  const tasksDirectory = join(projectDirectory, "tasks");
  const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const importedAt = now();
  const descriptors = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const taskPath = join(tasksDirectory, entry.name, "task.json");
    try {
      const source = await readFile(taskPath, "utf8");
      const task = JSON.parse(source) as {
        schemaVersion?: number;
        id?: string;
        status?: string;
        worktreePath?: string;
        surface?: { surfaceId?: string };
      };
      if (task.schemaVersion !== 2 || !task.id) return undefined;
      return {
        taskId: task.id,
        status: task.status,
        worktreePath: task.worktreePath,
        surfaceId: task.surface?.surfaceId,
        importedAt,
        sourceHash: createHash("sha256").update(source).digest("hex"),
        resumeAllowed: false as const,
      };
    } catch {
      return undefined;
    }
  }));
  return descriptors.flatMap((value) => value ? [{
    taskId: value.taskId,
    ...(value.status ? { status: value.status } : {}),
    ...(value.worktreePath ? { worktreePath: value.worktreePath } : {}),
    ...(value.surfaceId ? { surfaceId: value.surfaceId } : {}),
    importedAt: value.importedAt,
    sourceHash: value.sourceHash,
    resumeAllowed: false as const,
  }] : []);
}

export class V4Store {
  readonly root: string;
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly v4Directory: string;
  readonly statePath: string;
  readonly socketPath: string;
  readonly instancePath: string;

  constructor(stateDir: string, projectRoot: string) {
    this.root = resolve(stateDir);
    this.projectId = v4ProjectId(projectRoot);
    this.projectDirectory = join(this.root, "projects", this.projectId);
    this.v4Directory = join(this.projectDirectory, "v4");
    this.statePath = join(this.v4Directory, "state.json");
    this.socketPath = join(this.v4Directory, "supervisor.sock");
    this.instancePath = join(this.v4Directory, "supervisor.instance.json");
  }

  async initialize(projectRoot: string, projectName: string, config?: Partial<V4SupervisorConfig>): Promise<V4ProjectState> {
    await privateDirectory(this.root);
    await privateDirectory(this.projectDirectory);
    await privateDirectory(this.v4Directory);
    return withLock(this.statePath, async () => {
      const existing = await this.read().catch(() => undefined);
      const at = now();
      const state: V4ProjectState = existing?.schemaVersion === 4 ? {
        ...existing,
        projectRoot: resolve(projectRoot),
        projectName,
        config: effectiveV4Config({ ...existing.config, ...config }),
        features: Object.fromEntries(Object.values(existing.features).map((feature) => [feature.id, {
          ...feature,
          leadLaunchGeneration: feature.leadLaunchGeneration ?? (
            Object.values(existing.attachments).some((attachment) => attachment.featureId === feature.id) ? 1 : feature.leadLaunchState === "attached" ? 0 : 1
          ),
        }])),
        legacyV2: existing.legacyV2 ?? [],
        operations: existing.operations ?? {},
        updatedAt: at,
      } : {
        schemaVersion: 4,
        projectId: this.projectId,
        projectRoot: resolve(projectRoot),
        projectName,
        supervisorGeneration: 0,
        supervisorStartedAt: at,
        config: effectiveV4Config(config),
        attachments: {},
        features: {},
        tasks: {},
        events: [],
        operations: {},
        nextEventSequence: 1,
        legacyV2: await readLegacyDescriptors(this.projectDirectory),
        createdAt: at,
        updatedAt: at,
      };
      await atomicJson(this.statePath, state);
      return state;
    });
  }

  async read(): Promise<V4ProjectState> {
    return JSON.parse(await readFile(this.statePath, "utf8")) as V4ProjectState;
  }

  async update(operation: (current: V4ProjectState) => V4ProjectState | Promise<V4ProjectState>): Promise<V4ProjectState> {
    return withLock(this.statePath, async () => {
      const current = await this.read();
      const next = { ...(await operation(current)), updatedAt: now() };
      await atomicJson(this.statePath, next);
      return next;
    });
  }

  async beginSupervisorGeneration(): Promise<V4ProjectState> {
    return this.update((current) => ({
      ...current,
      supervisorGeneration: current.supervisorGeneration + 1,
      supervisorStartedAt: now(),
    }));
  }

  async writeInstance(value: unknown): Promise<void> {
    await atomicJson(this.instancePath, value);
  }
}
