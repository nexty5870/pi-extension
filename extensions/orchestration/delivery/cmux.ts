import type { ProjectContext } from "../types.ts";
import type { CommandRunner } from "./command.ts";
import { checked } from "./command.ts";
import type { DeliveryState, WorkerRole } from "./types.ts";

function firstRef(output: string, kind: "pane" | "surface"): string {
  const match = output.match(new RegExp(`${kind}:[A-Za-z0-9-]+`));
  if (!match) throw new Error(`cmux did not return a ${kind} reference`);
  return match[0];
}

export class CmuxAdapter {
  private lastStatus = "";
  private topology?: NonNullable<DeliveryState["cmux"]>;
  constructor(private readonly runner: CommandRunner, private readonly project: ProjectContext) {}
  private async cmux(args: string[]): Promise<string> {
    if (!this.project.cmuxWorkspaceId || !this.project.cmuxSurfaceId) throw new Error("Delivery requires caller cmux workspace and surface context");
    return checked(this.runner, "cmux", args, this.project.projectRoot, 30_000);
  }
  async ensureTopology(existing?: DeliveryState["cmux"]): Promise<NonNullable<DeliveryState["cmux"]>> {
    if (existing?.paneId && existing.implementerSurfaceId && existing.reviewerSurfaceId) { this.topology = existing; return existing; }
    const workspace = this.project.cmuxWorkspaceId!;
    const paneOut = await this.cmux(["new-pane", "--type", "terminal", "--direction", "right", "--workspace", workspace, "--focus", "false"]);
    const paneId = firstRef(paneOut, "pane");
    const listed = paneOut.match(/surface:[A-Za-z0-9-]+/)?.[0]
      ? paneOut
      : await this.cmux(["list-pane-surfaces", "--workspace", workspace, "--pane", paneId]);
    const initialSurface = listed.match(/surface:[A-Za-z0-9-]+/)?.[0];
    const implementer = initialSurface ? undefined : await this.cmux(["new-surface", "--type", "terminal", "--pane", paneId, "--workspace", workspace, "--focus", "false"]);
    const reviewer = await this.cmux(["new-surface", "--type", "terminal", "--pane", paneId, "--workspace", workspace, "--focus", "false"]);
    const implementerSurfaceId = initialSurface ?? firstRef(implementer!, "surface");
    const reviewerSurfaceId = firstRef(reviewer, "surface");
    await this.cmux(["rename-tab", "--workspace", workspace, "--surface", implementerSurfaceId, "Implementer"]);
    await this.cmux(["rename-tab", "--workspace", workspace, "--surface", reviewerSurfaceId, "Reviewer"]);
    this.topology = { paneId, implementerSurfaceId, reviewerSurfaceId };
    return this.topology;
  }
  async attachLogs(topology: NonNullable<DeliveryState["cmux"]>, implementerLog: string, reviewerLog: string): Promise<void> {
    const workspace = this.project.cmuxWorkspaceId!;
    const safe = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
    for (const [surface, path] of [[topology.implementerSurfaceId!, implementerLog], [topology.reviewerSurfaceId!, reviewerLog]]) {
      await this.cmux(["send", "--workspace", workspace, "--surface", surface, `tail -n 200 -F ${safe(path)}`]);
      await this.cmux(["send-key", "--workspace", workspace, "--surface", surface, "enter"]);
    }
  }
  async update(state: DeliveryState): Promise<void> {
    const value = `${state.phase}:${state.reviewPass}:${state.actions.length}`;
    if (value === this.lastStatus) return; this.lastStatus = value;
    const workspace = this.project.cmuxWorkspaceId!;
    await this.cmux(["set-status", "team-delivery", state.phase, "--workspace", workspace, "--icon", "hammer"]);
    const progress: Record<string, number> = { preflight: .05, worktree: .1, implementing: .25, reviewing: .45, checking: .6, committing: .72, pushing: .8, "pull-request": .88, ci: .95, completed: 1 };
    if (progress[state.phase] !== undefined) await this.cmux(["set-progress", String(progress[state.phase]), "--label", state.phase, "--workspace", workspace]);
  }
  async flash(role: WorkerRole): Promise<void> {
    const surface = role === "implementer" ? this.topology?.implementerSurfaceId : this.topology?.reviewerSurfaceId;
    await this.cmux(["trigger-flash", "--workspace", this.project.cmuxWorkspaceId!, ...(surface ? ["--surface", surface] : [])]);
  }
}

export function cmuxCommandsAreFocusNeutral(args: string[][]): boolean {
  return args.every((argv) => !argv.some((arg) => /^(?:select-workspace|focus-pane|focus-panel)$/.test(arg)) &&
    (!argv.some((arg) => /^(?:new-pane|new-surface|new-split)$/.test(arg)) || argv.includes("false")));
}
