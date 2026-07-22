import { isTerminalTaskStatus, type TaskRecord } from "./types.ts";

export const TRIAGE_ACTION_MESSAGE = "Message/nudge (Pi inbox only)";
export const TRIAGE_ACTION_HANDOFF = "Request handoff (Pi inbox only)";
export const TRIAGE_ACTION_FOCUS = "Open/focus surface (cmux focus)";
export const TRIAGE_ACTION_STOP = "Graceful stop (durable state + Pi shutdown)";
export const TRIAGE_ACTION_RETIRE = "Retire surface (cmux only; keeps session/worktree)";
export const TRIAGE_ACTION_RESUME = "Resume session (fresh cmux surface; keeps worktree)";
export const TRIAGE_ACTION_CLOSE_ELIGIBLE = "Close eligible completed surfaces (cmux only)";
export const TRIAGE_ACTION_DISMISS = "Dismiss events (Lead outbox only)";
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

export function runtimeLabel(task: TaskRecord): string {
  if (task.launchState === "queued") return "queued";
  const runtime = task.runtime;
  if (!runtime) return task.status === "starting" ? "starting" : "unknown";
  const context = runtime.contextPercent === undefined ? "" : ` · ctx ${Math.round(runtime.contextPercent)}%`;
  return `${runtime.state}${context}`;
}

export function taskLine(task: TaskRecord): string {
  const state = task.runtime?.state;
  const icon = state === "needs-attention" || state === "stale" || state === "detached" || state === "offline" || task.status === "blocked" || task.status === "failed"
    ? "!"
    : state === "busy"
      ? "●"
      : isTerminalTaskStatus(task.status)
        ? "✓"
        : "◌";
  const reason = task.runtime?.attentionReason ?? workerBlockedReason(task);
  const selection = task.resolvedWorker?.model
    ? ` · ${task.resolvedWorker.model}${task.resolvedWorker.thinking ? `/${task.resolvedWorker.thinking}` : ""}`
    : task.resolvedWorker?.thinking
      ? ` · thinking ${task.resolvedWorker.thinking}`
      : "";
  return `${icon} ${task.id.slice(0, 8)} ${task.role} · ${runtimeLabel(task)}${selection} · ${task.brief.title}${reason ? ` — ${truncateLine(reason)}` : ""}`;
}

export function leadStatusSummary(tasks: TaskRecord[], pendingEvents: number): string {
  const active = tasks.filter((task) => !isTerminalTaskStatus(task.status));
  const busy = active.filter((task) => task.runtime?.state === "busy").length;
  const attention = active.filter((task) => ["stale", "offline", "detached", "needs-attention"].includes(task.runtime?.state ?? "")).length;
  const blocked = active.filter((task) => task.status === "blocked").length;
  const green = active.filter((task) => task.status === "pr-ready-ci-green").length;
  const queued = active.filter((task) => task.launchState === "queued").length;
  return `Lead · ${active.length} active${busy ? ` · ${busy} busy` : ""}${attention ? ` · ${attention} attention` : ""}${queued ? ` · ${queued} queued` : ""}${blocked ? ` · ${blocked} blocked` : ""}${green ? ` · ${green} green` : ""}${pendingEvents ? ` · ${pendingEvents} event${pendingEvents === 1 ? "" : "s"} pending` : ""}`;
}

export function triageDetail(task: TaskRecord): string {
  const reason = workerBlockedReason(task);
  const runtime = task.runtime;
  return [
    `${task.id.slice(0, 8)} · ${task.role} · semantic ${task.status} · runtime ${runtimeLabel(task)}`,
    task.brief.title,
    reason ? `Blocked: ${truncateLine(reason, 240)}` : undefined,
    runtime?.attentionReason ? `Attention: ${truncateLine(runtime.attentionReason, 240)}` : undefined,
    runtime?.lastHeartbeatAt ? `Heartbeat: ${runtime.lastHeartbeatAt}` : undefined,
    runtime?.lastActivityAt ? `Activity: ${runtime.lastActivityAt}` : undefined,
    runtime?.lastReportAt ? `Report: ${runtime.lastReportAt}` : undefined,
    task.summary ? `Summary: ${truncateLine(task.summary, 240)}` : undefined,
    task.handoff ? `Handoff: ${truncateLine(task.handoff, 240)}` : undefined,
    task.resolvedWorker?.model ? `Model: ${task.resolvedWorker.model}` : undefined,
    task.resolvedWorker?.thinking ? `Thinking: ${task.resolvedWorker.thinking} (Pi capability-clamped)` : undefined,
    task.pullRequest?.url ? `PR: ${task.pullRequest.url}` : undefined,
    task.surface ? `Surface: ${task.surface.surfaceId} (${runtime?.surfaceHealth ?? "unknown"})` : "Surface: none (session/worktree retained)",
    "No action deletes the Pi session file or Git worktree.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function triageActions(task: TaskRecord): string[] {
  const surfaceHealthy = Boolean(task.surface && task.runtime?.surfaceHealth !== "missing" && task.runtime?.surfaceHealth !== "detached");
  const surfaceOffline = surfaceHealthy && task.runtime?.state === "offline";
  return [
    TRIAGE_ACTION_MESSAGE,
    TRIAGE_ACTION_HANDOFF,
    ...(surfaceHealthy && !surfaceOffline ? [TRIAGE_ACTION_FOCUS] : []),
    ...(surfaceOffline ? [TRIAGE_ACTION_RETIRE] : []),
    ...(!surfaceHealthy ? [TRIAGE_ACTION_RESUME] : []),
    ...(!isTerminalTaskStatus(task.status) ? [TRIAGE_ACTION_STOP] : []),
    TRIAGE_ACTION_CLOSE_ELIGIBLE,
    TRIAGE_ACTION_DISMISS,
    TRIAGE_ACTION_BACK,
  ];
}
