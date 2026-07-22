import { LEAD_EVENT_STATUSES, type LeadTaskEvent, type TaskRecord, type TaskStatus } from "./types.ts";

const ACTIONABLE_WORKER_STATES = new Set<TaskStatus>(LEAD_EVENT_STATUSES);

export interface PendingLeadEvent {
  task: TaskRecord;
  event: LeadTaskEvent;
  legacy: boolean;
}

function clip(value: string | undefined, limit = 6_000): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[…truncated]`;
}

export function pendingLeadEvents(tasks: TaskRecord[]): PendingLeadEvent[] {
  const pending: PendingLeadEvent[] = [];
  for (const task of tasks) {
    const persisted = (task.leadEvents ?? []).filter((event) => !event.observedAt);
    if (persisted.length > 0 || (task.leadEvents?.length ?? 0) > 0) {
      pending.push(...persisted.map((event) => ({ task, event, legacy: false })));
      continue;
    }
    if (task.leadObservedStatus === task.status || !ACTIONABLE_WORKER_STATES.has(task.status)) continue;
    pending.push({
      task,
      legacy: true,
      event: {
        id: `legacy:${task.id}:${task.status}:${task.updatedAt}`,
        kind: "status",
        status: task.status,
        createdAt: task.updatedAt,
        blockedReason: task.blockedReason,
        summary: task.summary,
        handoff: task.handoff,
        review: task.review,
        pullRequestUrl: task.pullRequest?.url,
        linear: task.linear ? {
          issueIdentifier: task.linear.issueIdentifier,
          status: task.linear.status,
          stateName: task.linear.stateName,
        } : undefined,
      },
    });
  }
  return pending.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt));
}

export function isActionableWorkerState(status: TaskStatus): boolean {
  return ACTIONABLE_WORKER_STATES.has(status);
}

export function deliveredLeadEventIds(entries: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of entries) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as { type?: unknown; customType?: unknown; details?: unknown };
    if (entry.type !== "custom_message" || entry.customType !== "lead:worker-event" || entry.details === null || typeof entry.details !== "object") continue;
    const eventIds = (entry.details as { eventIds?: unknown }).eventIds;
    if (!Array.isArray(eventIds)) continue;
    for (const id of eventIds) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

export function workerEventMessage(events: PendingLeadEvent[]): string {
  const sections = events.map(({ task, event }) => {
    const summary = event.kind === "runtime" && event.runtimeReason ? undefined : clip(event.summary);
    const handoff = clip(event.handoff);
    return [
      `## ${task.id.slice(0, 8)} · ${task.role} · ${event.kind === "runtime" ? event.runtimeState ?? task.runtime?.state ?? "runtime" : event.status}${event.kind === "review" ? " · review" : ""}`,
      `**${task.brief.title}**`,
      event.blockedReason ? `Blocked: ${event.blockedReason}` : undefined,
      event.kind === "runtime" && event.runtimeReason ? `Runtime: ${event.runtimeReason}` : undefined,
      summary ? `Summary:\n${summary}` : undefined,
      handoff ? `Handoff:\n${handoff}` : undefined,
      event.review ? `Review: ${event.review.verdict}${event.review.findings.length ? `\n${event.review.findings.map((finding) => `- ${finding}`).join("\n")}` : ""}` : undefined,
      event.pullRequestUrl ? `PR: ${event.pullRequestUrl}` : undefined,
      event.linear ? `Linear ${event.linear.issueIdentifier}: ${event.linear.status}${event.linear.stateName ? ` (${event.linear.stateName})` : ""}` : undefined,
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
