import type { TaskRecord, TaskStatus } from "./types.ts";

const ACTIONABLE_WORKER_STATES = new Set<TaskStatus>([
  "blocked",
  "pr-ready-ci-pending",
  "pr-ready-ci-green",
  "completed",
  "failed",
  "stopped",
  "merged",
]);

function clip(value: string | undefined, limit = 6_000): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[…truncated]`;
}

export function pendingLeadEvents(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((task) => task.leadObservedStatus !== task.status && ACTIONABLE_WORKER_STATES.has(task.status));
}

export function isActionableWorkerState(status: TaskStatus): boolean {
  return ACTIONABLE_WORKER_STATES.has(status);
}

export function workerEventMessage(tasks: TaskRecord[]): string {
  const sections = tasks.map((task) => {
    const summary = clip(task.summary);
    const handoff = clip(task.handoff);
    return [
      `## ${task.id.slice(0, 8)} · ${task.role} · ${task.status}`,
      `**${task.brief.title}**`,
      task.blockedReason ? `Blocked: ${task.blockedReason}` : undefined,
      summary ? `Summary:\n${summary}` : undefined,
      handoff ? `Handoff:\n${handoff}` : undefined,
      task.review ? `Review: ${task.review.verdict}${task.review.findings.length ? `\n${task.review.findings.map((finding) => `- ${finding}`).join("\n")}` : ""}` : undefined,
      task.pullRequest?.url ? `PR: ${task.pullRequest.url}` : undefined,
      task.linear ? `Linear ${task.linear.issueIdentifier}: ${task.linear.status}${task.linear.stateName ? ` (${task.linear.stateName})` : ""}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n\n");
  });
  const message = [
    "# Delegated worker event",
    "",
    ...sections,
    "",
    "Continue the operator's existing request now. Use the handoff, delegate the next implementation or review step when appropriate, and update/steer existing workers instead of waiting for another user prompt. Ask the operator only when a genuine product decision or separate merge/deployment/production authorization is required.",
  ].join("\n");
  return clip(message, 24_000) ?? message;
}
