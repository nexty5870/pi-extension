import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DeliveryState } from "./types.ts";

export type ContextLevel = "normal" | "warning" | "critical" | "unknown";
export function contextLevel(percent: number | undefined): ContextLevel {
  if (percent === undefined) return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "normal";
}
export interface TeamUiSnapshot { contextPercent?: number; initiativeState?: string; delivery?: DeliveryState }
export function actionCount(snapshot: TeamUiSnapshot): number { return snapshot.delivery?.actions.length ?? (snapshot.initiativeState === "review" ? 1 : 0); }

export function renderTeamFooter(width: number, theme: Theme, model: string, branch: string | null, statuses: ReadonlyMap<string, string>, snapshot: TeamUiSnapshot): string[] {
  const percent = snapshot.contextPercent === undefined ? "ctx ?" : `ctx ${snapshot.contextPercent}%`;
  const level = contextLevel(snapshot.contextPercent);
  const color = level === "critical" ? "error" : level === "warning" ? "warning" : level === "normal" ? "success" : "dim";
  const workers = Object.values(snapshot.delivery?.workers ?? {}).filter((worker) => worker?.phase === "running").length;
  const left = theme.fg(color, percent) + theme.fg("dim", ` · ${snapshot.initiativeState ?? "idle"} · workers ${workers} · actions ${actionCount(snapshot)}`);
  const unrelated = [...statuses.entries()].filter(([key]) => !["team-context", "team-orchestration"].includes(key)).map(([, value]) => value).join(" · ");
  const rightText = `${unrelated ? `${unrelated} · ` : ""}${model || "no-model"}${branch ? ` (${branch})` : ""}`;
  const right = theme.fg("dim", rightText);
  if (width < 45) return [truncateToWidth(`${left} ${right}`, Math.max(1, width))];
  const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
  return [truncateToWidth(left + pad + right, width)];
}

export function workerLines(state: DeliveryState | undefined): string[] {
  if (!state) return ["No delivery run."];
  const elapsed = Math.max(0, Date.now() - Date.parse(state.startedAt));
  return [
    `Run ${state.runId} · ${state.phase} · ${Math.floor(elapsed / 1000)}s`,
    `Worktree: ${state.worktreePath ?? "pending"}`,
    ...(["implementer", "reviewer"] as const).map((role) => {
      const worker = state.workers[role];
      const usage = worker?.usage ? ` · ${worker.usage.input} in/${worker.usage.output} out/$${worker.usage.cost.toFixed(4)}` : "";
      return worker ? `${role}: ${worker.phase} · ${worker.task}${usage}${worker.failure ? ` · ${worker.failure}` : ""}` : `${role}: idle`;
    }),
    `Checks: ${state.checks.filter((check) => check.exitCode === 0).length}/${state.checks.length} passed · review ${state.reviewPass}/3`,
    ...state.actions.map((action) => `${action.severity.toUpperCase()}: ${action.message}`),
  ];
}
