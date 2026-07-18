import type { CommandExecutor } from "./git.ts";
import type { ProjectRecord, TaskStatus, WorkerSurface } from "./types.ts";

interface PaneList {
  panes?: Array<{ ref?: string; surface_refs?: string[] }>;
}

interface SurfaceList {
  surfaces?: Array<{ ref?: string }>;
}

function reference(output: string, kind: "pane" | "surface"): string | undefined {
  return output.match(new RegExp(`${kind}:[A-Za-z0-9-]+`))?.[0];
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class CmuxWorkers {
  constructor(
    private readonly execute: CommandExecutor,
    private readonly cwd: string,
    private readonly workspaceId: string,
  ) {}

  private async call(args: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
    const result = await this.execute("cmux", args, { cwd: this.cwd, signal, timeout });
    if (result.code !== 0) throw new Error(`cmux ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim();
  }

  private async panes(signal?: AbortSignal): Promise<PaneList["panes"]> {
    const output = await this.call(["list-panes", "--workspace", this.workspaceId, "--json"], signal);
    return parseJson<PaneList>(output)?.panes ?? [];
  }

  private async surfaces(paneId: string, signal?: AbortSignal): Promise<SurfaceList["surfaces"]> {
    const output = await this.call([
      "list-pane-surfaces",
      "--workspace",
      this.workspaceId,
      "--pane",
      paneId,
      "--json",
    ], signal);
    return parseJson<SurfaceList>(output)?.surfaces ?? [];
  }

  async createSurface(
    project: ProjectRecord,
    label: string,
    workingDirectory: string,
    signal?: AbortSignal,
  ): Promise<{ surface: WorkerSurface; helperPaneId: string }> {
    const existingPanes = await this.panes(signal);
    let helperPaneId = project.cmux?.helperPaneId;
    if (helperPaneId && !existingPanes?.some((pane) => pane.ref === helperPaneId)) helperPaneId = undefined;

    let surfaceId: string | undefined;
    if (!helperPaneId) {
      const before = new Set(existingPanes?.map((pane) => pane.ref).filter((value): value is string => Boolean(value)) ?? []);
      const output = await this.call([
        "new-pane",
        "--workspace",
        this.workspaceId,
        "--type",
        "terminal",
        "--direction",
        "right",
        "--focus",
        "false",
      ], signal);
      helperPaneId = reference(output, "pane");
      surfaceId = reference(output, "surface");
      if (!helperPaneId) {
        const after = await this.panes(signal);
        helperPaneId = after?.find((pane) => pane.ref && !before.has(pane.ref))?.ref;
      }
      if (!helperPaneId) throw new Error("cmux did not identify the new worker pane");
      if (!surfaceId) surfaceId = (await this.surfaces(helperPaneId, signal))?.[0]?.ref;
    } else {
      const output = await this.call([
        "new-surface",
        "--workspace",
        this.workspaceId,
        "--pane",
        helperPaneId,
        "--type",
        "terminal",
        "--working-directory",
        workingDirectory,
        "--focus",
        "false",
      ], signal);
      surfaceId = reference(output, "surface");
      if (!surfaceId) {
        const surfaces = await this.surfaces(helperPaneId, signal);
        surfaceId = surfaces?.at(-1)?.ref;
      }
    }
    if (!surfaceId) throw new Error("cmux did not identify the worker surface");

    await this.call([
      "rename-tab",
      "--workspace",
      this.workspaceId,
      "--surface",
      surfaceId,
      label.slice(0, 80),
    ], signal).catch(() => "");

    return {
      helperPaneId,
      surface: { workspaceId: this.workspaceId, paneId: helperPaneId, surfaceId },
    };
  }

  async launch(surfaceId: string, launchScriptPath: string, signal?: AbortSignal): Promise<void> {
    await this.call([
      "send",
      "--workspace",
      this.workspaceId,
      "--surface",
      surfaceId,
      "--",
      `exec ${shellQuote(launchScriptPath)}`,
    ], signal);
    await this.call([
      "send-key",
      "--workspace",
      this.workspaceId,
      "--surface",
      surfaceId,
      "enter",
    ], signal);
  }

  async flash(surfaceId?: string, signal?: AbortSignal): Promise<void> {
    await this.call([
      "trigger-flash",
      "--workspace",
      this.workspaceId,
      ...(surfaceId ? ["--surface", surfaceId] : []),
    ], signal).catch(() => "");
  }

  async setTaskStatus(taskId: string, status: TaskStatus, signal?: AbortSignal): Promise<void> {
    await this.call([
      "set-status",
      `lead-worker-${taskId.slice(0, 8)}`,
      status,
      "--workspace",
      this.workspaceId,
      "--icon",
      status === "blocked" || status === "failed" ? "exclamationmark.triangle" : "hammer",
    ], signal).catch(() => "");
  }
}
