import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InitiativeState, ProjectContext, UsageRecord } from "./types.ts";

export const DEFAULT_ORCHESTRATION_DIR = join(homedir(), ".pi", "team-orchestration");

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export function projectIdForRoot(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `project-${digest}`;
}

export class OrchestrationStore {
  constructor(readonly rootDir = DEFAULT_ORCHESTRATION_DIR) {}

  configPath(): string {
    return join(this.rootDir, "mcp.json");
  }

  async registerProject(project: ProjectContext): Promise<void> {
    const path = join(this.rootDir, "projects", safeSegment(project.projectId), "project.json");
    await atomicWrite(path, `${JSON.stringify({ ...project, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }

  async listProjects(): Promise<Array<ProjectContext & { updatedAt: string }>> {
    const directory = join(this.rootDir, "projects");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects = await Promise.all(entries.map(async (projectId) => {
      try {
        return JSON.parse(await readFile(join(directory, projectId, "project.json"), "utf8")) as ProjectContext & { updatedAt: string };
      } catch {
        return undefined;
      }
    }));
    return projects.filter((item): item is ProjectContext & { updatedAt: string } => item !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  initiativeDir(state: Pick<InitiativeState, "projectId" | "initiativeId">): string {
    return join(
      this.rootDir,
      "projects",
      safeSegment(state.projectId),
      "initiatives",
      safeSegment(state.initiativeId),
    );
  }

  initiativePath(state: Pick<InitiativeState, "projectId" | "initiativeId">): string {
    return join(this.initiativeDir(state), "state.json");
  }

  contractPath(state: Pick<InitiativeState, "projectId" | "initiativeId">): string {
    return join(this.initiativeDir(state), "contract.md");
  }

  async writeInitiative(state: InitiativeState): Promise<void> {
    await atomicWrite(this.initiativePath(state), `${JSON.stringify(state, null, 2)}\n`);
  }

  async writeContract(state: InitiativeState, markdown: string): Promise<string> {
    const path = this.contractPath(state);
    await atomicWrite(path, markdown, 0o600);
    return path;
  }

  async readInitiative(projectId: string, initiativeId: string): Promise<InitiativeState | undefined> {
    const path = this.initiativePath({ projectId, initiativeId });
    try {
      return JSON.parse(await readFile(path, "utf8")) as InitiativeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readContract(state: Pick<InitiativeState, "projectId" | "initiativeId">): Promise<string> {
    return readFile(this.contractPath(state), "utf8");
  }

  async listInitiatives(projectId: string): Promise<InitiativeState[]> {
    const directory = join(this.rootDir, "projects", safeSegment(projectId), "initiatives");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const states = await Promise.all(entries.map((initiativeId) => this.readInitiative(projectId, initiativeId)));
    return states.filter((state): state is InitiativeState => state !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async writeUsage(record: UsageRecord): Promise<string> {
    const fileName = `${record.timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
    const path = join(
      this.rootDir,
      "projects",
      safeSegment(record.projectId),
      "usage",
      fileName,
    );
    await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
  }

  async listUsage(projectId: string): Promise<UsageRecord[]> {
    const directory = join(this.rootDir, "projects", safeSegment(projectId), "usage");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      try {
        return JSON.parse(await readFile(join(directory, entry), "utf8")) as UsageRecord;
      } catch {
        return undefined;
      }
    }));
    return records.filter((record): record is UsageRecord => record !== undefined)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async writeEvent(
    state: Pick<InitiativeState, "projectId" | "initiativeId">,
    type: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const timestamp = new Date().toISOString();
    const fileName = `${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
    const path = join(this.initiativeDir(state), "events", fileName);
    await atomicWrite(
      path,
      `${JSON.stringify({ schemaVersion: 1, timestamp, type, data }, null, 2)}\n`,
    );
    return path;
  }
}
