import { isTerminalTaskStatus, type TaskRecord } from "./types.ts";

export const TRIAGE_ACTION_MESSAGE = "Message worker";
export const TRIAGE_ACTION_STOP = "Mark stopped";
export const TRIAGE_ACTION_DISMISS = "Dismiss events";
export const TRIAGE_ACTION_BACK = "Back";

export function truncateLine(value: string, limit = 72): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  return `${line.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function workerBlockedReason(task: TaskRecord): string | undefined {
  if (task.status !== "blocked" && task.status !== "failed") return undefined;
  return task.blockedReason || task.failure;
}

export function taskLine(task: TaskRecord): string {
  const icon = task.status === "pr-ready-ci-green" || task.status === "completed" || task.status === "merged"
    ? "✓"
    : task.status === "blocked" || task.status === "failed"
      ? "!"
      : "•";
  const reason = workerBlockedReason(task);
  return `${icon} ${task.id.slice(0, 8)} ${task.status} · ${task.brief.title}${reason ? ` — ${truncateLine(reason)}` : ""}`;
}

export function leadStatusSummary(tasks: TaskRecord[], pendingEvents: number): string {
  const active = tasks.filter((task) => !isTerminalTaskStatus(task.status));
  const running = active.filter((task) => task.status === "running" || task.status === "starting").length;
  const blocked = active.filter((task) => task.status === "blocked").length;
  const green = active.filter((task) => task.status === "pr-ready-ci-green").length;
  return `Lead · ${active.length} active${running ? ` · ${running} running` : ""}${blocked ? ` · ${blocked} blocked` : ""}${green ? ` · ${green} green` : ""}${pendingEvents ? ` · ${pendingEvents} event${pendingEvents === 1 ? "" : "s"} pending` : ""}`;
}

export function triageDetail(task: TaskRecord): string {
  const reason = workerBlockedReason(task);
  return [
    `${task.id.slice(0, 8)} · ${task.role} · ${task.status}`,
    task.brief.title,
    reason ? `Blocked: ${truncateLine(reason, 240)}` : undefined,
    task.summary ? `Summary: ${truncateLine(task.summary, 240)}` : undefined,
    task.handoff ? `Handoff: ${truncateLine(task.handoff, 240)}` : undefined,
    task.pullRequest?.url ? `PR: ${task.pullRequest.url}` : undefined,
    task.surface ? `Surface: ${task.surface.surfaceId}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function triageActions(task: TaskRecord): string[] {
  return [
    TRIAGE_ACTION_MESSAGE,
    ...(isTerminalTaskStatus(task.status) ? [] : [TRIAGE_ACTION_STOP]),
    TRIAGE_ACTION_DISMISS,
    TRIAGE_ACTION_BACK,
  ];
}
