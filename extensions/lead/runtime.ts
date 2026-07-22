import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveWorkerPolicy } from "./policy.ts";
import { LeadStore } from "./store.ts";
import { isTerminalTaskStatus, type ProjectRecord, type TaskRecord } from "./types.ts";

export const LEAD_RUNTIME_VERSION = "2.1";

function now(): string {
  return new Date().toISOString();
}

export class WorkerRuntimeController {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  private context?: ExtensionContext;
  private stopped = true;

  constructor(
    private readonly store: LeadStore,
    private readonly projectId: string,
    private readonly taskId: string,
    private readonly sendFollowUp: (message: string) => void,
  ) {}

  async start(ctx: ExtensionContext): Promise<void> {
    this.stopTimers();
    this.stopped = false;
    this.context = ctx;
    const project = await this.store.readProject(this.projectId);
    const policy = effectiveWorkerPolicy(project?.workers);
    const at = now();
    const task = await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      state: "idle",
      loadedRuntimeVersion: LEAD_RUNTIME_VERSION,
      lastHeartbeatAt: at,
      lastActivityAt: runtime.lastActivityAt ?? at,
      surfaceHealth: runtime.surfaceHealth ?? "healthy",
      shutdownReason: undefined,
    }));
    if (task.runtime?.reportNudgeState === "scheduled") this.scheduleNudge(task, project, ctx);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), policy.heartbeatSeconds * 1_000);
    this.heartbeatTimer.unref();
    await this.captureContext(ctx);
  }

  async agentStart(ctx: ExtensionContext): Promise<void> {
    const at = now();
    await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      state: "busy",
      lastHeartbeatAt: at,
      lastActivityAt: at,
      reportBaselineAt: runtime.lastReportAt,
      attentionReason: runtime.state === "stale" ? undefined : runtime.attentionReason,
    }));
    await this.captureContext(ctx);
  }

  async activity(ctx: ExtensionContext): Promise<void> {
    const at = now();
    await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      lastHeartbeatAt: at,
      lastActivityAt: at,
    }));
    await this.captureContext(ctx);
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    const at = now();
    let task = await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      state: runtime.state === "needs-attention" ? runtime.state : "idle",
      lastHeartbeatAt: at,
      lastActivityAt: at,
      lastAgentSettledAt: at,
    }));
    await this.captureContext(ctx);
    task = await this.store.requireTask(this.projectId, this.taskId);
    if (task.runtime?.shutdownRequestedAt && ctx.isIdle()) {
      ctx.shutdown();
      return;
    }
    const reportAt = Date.parse(task.runtime?.lastReportAt ?? "");
    const baselineAt = Date.parse(task.runtime?.reportBaselineAt ?? "");
    const reportedThisRun = Number.isFinite(reportAt) && (!Number.isFinite(baselineAt) || reportAt > baselineAt);
    if (reportedThisRun) {
      this.clearNudgeTimer();
      await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
        ...runtime,
        reportNudgeState: undefined,
        reportNudgeAt: undefined,
      }));
      return;
    }
    if (task.runtime?.reportNudgeState === "sent") {
      this.clearNudgeTimer();
      const reason = "Worker settled again after the one automatic report nudge without a durable lead_worker_report";
      await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({ ...runtime, reportNudgeState: "attention" }));
      await this.store.runtimeAttention(this.projectId, this.taskId, `reportless:${task.runtime.reportNudgeAt ?? task.workerStartedAt}`, reason);
      return;
    }
    if (task.runtime?.reportNudgeState === "attention" || task.runtime?.reportNudgeState === "scheduled") return;
    task = await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      reportNudgeState: "scheduled",
      reportNudgeAt: at,
    }));
    this.scheduleNudge(task, await this.store.readProject(this.projectId), ctx);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTimers();
    const task = await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      state: "offline",
      lastHeartbeatAt: now(),
      shutdownReason: reason,
    })).catch(() => undefined);
    if (task && reason === "quit" && !isTerminalTaskStatus(task.status)) {
      await this.store.runtimeAttention(this.projectId, this.taskId, `offline:${task.workerStartedAt ?? task.createdAt}`, "Worker session shut down without a terminal handoff", "offline");
    }
    this.context = undefined;
  }

  private scheduleNudge(task: TaskRecord, project: ProjectRecord | undefined, ctx: ExtensionContext): void {
    if (this.nudgeTimer || task.runtime?.reportNudgeState !== "scheduled") return;
    const grace = effectiveWorkerPolicy(project?.workers).idleReportGraceSeconds * 1_000;
    const elapsed = Date.now() - Date.parse(task.runtime.reportNudgeAt ?? now());
    this.nudgeTimer = setTimeout(() => void this.sendReportNudge(ctx), Math.max(0, grace - Math.max(0, elapsed)));
    this.nudgeTimer.unref();
  }

  private async sendReportNudge(ctx: ExtensionContext): Promise<void> {
    this.nudgeTimer = undefined;
    if (this.stopped) return;
    const task = await this.store.requireTask(this.projectId, this.taskId);
    if (task.runtime?.reportNudgeState !== "scheduled") return;
    await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({ ...runtime, reportNudgeState: "sent" }));
    this.sendFollowUp("Runtime supervisor: this run settled without a durable report. Call lead_worker_report once now with completed, blocked, or running status and a concrete handoff. Do not infer completion.");
    ctx.ui.notify("A durable worker report is required", "warning");
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.context) return;
    const task = await this.store.requireTask(this.projectId, this.taskId).catch(() => undefined);
    if (!task) return;
    const at = now();
    await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      lastHeartbeatAt: at,
      state: runtime.state === "stale" ? "idle" : runtime.state,
      attentionReason: runtime.state === "stale" ? undefined : runtime.attentionReason,
    }));
    await this.captureContext(this.context);
    const refreshed = await this.store.requireTask(this.projectId, this.taskId);
    if (refreshed.runtime?.shutdownRequestedAt && this.context.isIdle()) this.context.shutdown();
  }

  private async captureContext(ctx: ExtensionContext): Promise<void> {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return;
    const project = await this.store.readProject(this.projectId);
    const policy = effectiveWorkerPolicy(project?.workers);
    const before = await this.store.requireTask(this.projectId, this.taskId);
    const firstWarning = usage.percent >= policy.contextWarnPercent && !before.runtime?.contextWarnedAt;
    const firstHandoff = usage.percent >= policy.contextHandoffPercent && !before.runtime?.contextHandoffRequestedAt;
    await this.store.updateRuntime(this.projectId, this.taskId, (runtime) => ({
      ...runtime,
      contextTokens: usage.tokens ?? undefined,
      contextWindow: usage.contextWindow,
      contextPercent: Math.round((usage.percent ?? 0) * 10) / 10,
      contextWarnedAt: firstWarning ? now() : runtime.contextWarnedAt,
      contextHandoffRequestedAt: firstHandoff ? now() : runtime.contextHandoffRequestedAt,
    }));
    if (firstWarning) ctx.ui.notify(`Worker context is ${Math.round(usage.percent)}% full`, usage.percent >= policy.contextHandoffPercent ? "warning" : "info");
    if (firstHandoff) {
      // Persist before injection so reload/retry cannot create a prompt loop.
      this.sendFollowUp("Runtime supervisor: context usage reached the handoff threshold. Persist a concise lead_worker_report handoff now; do not claim semantic completion unless the work is actually complete.");
    }
  }

  private clearNudgeTimer(): void {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearNudgeTimer();
  }
}
