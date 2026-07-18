import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { LeadCoordinator, summarizeTasks, workerLabel } from "./coordinator.ts";
import { deliveredLeadEventIds, isActionableWorkerState, pendingLeadEvents, workerEventMessage } from "./events.ts";
import type { CommandExecutor } from "./git.ts";
import {
  LINEAR_START_TOOLS,
  linearLifecycleAfterStatuses,
  linearLifecycleAfterToolResult,
  linearLifecycleIsActionable,
  linearLifecycleMutationSafetyReason,
  linearStartInstruction,
  normalizeLinearIssueReference,
  parseLinearIssueSnapshot,
  parseLinearWorkflowStates,
  linearStatusFilterTeamId,
} from "./linear-lifecycle.ts";
import { LEAD_SYSTEM_PROMPT } from "./prompt.ts";
import {
  classifyBashRisk,
  isDestructiveLinearTool,
  isLinearMutationTool,
  readOnlyWorkerCommandReason,
  riskDescription,
  sensitiveCommandReason,
  sensitiveCommandResolvedPathReason,
  sensitiveResolvedPathReason,
} from "./safety.ts";
import { defaultLeadStateDir, LeadStore } from "./store.ts";
import type { TaskRecord, WorkerRole } from "./types.ts";

declare const __filename: string;

const STATUS_KEY = "lead-workers";
const WIDGET_KEY = "lead-workers";
const DASHBOARD_INTERVAL_MS = 2_500;
const CI_INTERVAL_MS = 30_000;

const RoleSchema = StringEnum(["implementation", "review", "research"] as const, {
  description: "Worker role. Review requires parentTaskId and shares that implementation worktree.",
});
const WorkerStatusSchema = StringEnum([
  "running",
  "blocked",
  "pr-ready-ci-pending",
  "pr-ready-ci-green",
  "completed",
  "failed",
  "stopped",
] as const, {
  description: "Worker-reported state. Starting is coordinator-owned; merged is GitHub-authoritative.",
});
const ManualStatusSchema = StringEnum(["running", "blocked", "completed", "failed", "stopped"] as const, {
  description: "Manual reconciliation state. PR and merge states come from worker/GitHub evidence.",
});
const CheckSchema = Type.Object({
  name: Type.String(),
  status: StringEnum(["passed", "failed", "pending", "skipped"] as const),
  details: Type.Optional(Type.String()),
});
const AcceptanceSchema = Type.Object({
  criterion: Type.String(),
  status: StringEnum(["met", "not-met", "unclear"] as const),
  evidence: Type.String(),
});

function modelName(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function taskLine(task: TaskRecord): string {
  const icon = task.status === "pr-ready-ci-green" || task.status === "completed" || task.status === "merged"
    ? "✓"
    : task.status === "blocked" || task.status === "failed"
      ? "!"
      : "•";
  return `${icon} ${task.id.slice(0, 8)} ${task.status} · ${task.brief.title}`;
}

function shouldResetLegacyUi(ctx: ExtensionContext): boolean {
  let legacy = false;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "lead-v2:legacy-ui-reset") return false;
    if (entry.type === "custom" && entry.customType.startsWith("team-orchestration")) legacy = true;
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName.startsWith("team_")) legacy = true;
  }
  return legacy;
}

function workerRolePrompt(taskId: string, role: string): string {
  return `You are the visible ${role} worker for Lead task ${taskId}. Your assignment is in the appended system prompt. Use normal Pi tools within that scope. Keep the Lead informed with lead_worker_report. Never merge, deploy, force-push, expose credentials, or mutate unrelated external resources without separate direct operator authorization.`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part !== null && typeof part === "object" ? part as Record<string, unknown> : undefined)
    .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
}

export default function leadExtension(pi: ExtensionAPI) {
  const workerTaskId = process.env.PI_LEAD_TASK_ID;
  const workerProjectId = process.env.PI_LEAD_PROJECT_ID;
  const workerRole = process.env.PI_LEAD_ROLE as WorkerRole | undefined;
  const isWorker = Boolean(workerTaskId && workerProjectId);
  const store = new LeadStore(defaultLeadStateDir(process.env));
  const execute: CommandExecutor = async (command, args, options) => {
    const result = await pi.exec(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
  };
  const extensionPath = typeof __filename === "string" ? __filename : undefined;
  const coordinator = new LeadCoordinator(store, execute, undefined, extensionPath);
  let dashboardTimer: ReturnType<typeof setInterval> | undefined;
  let leadWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let linearWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let ciTimer: ReturnType<typeof setInterval> | undefined;
  let dashboardProjectId: string | undefined;
  let dashboardContext: ExtensionContext | undefined;
  let dashboardUpdateRunning = false;
  let ciRefreshRunning = false;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;
  let inboxContext: ExtensionContext | undefined;
  let inboxRunning = false;
  const linearPromptsInFlight = new Set<string>();
  const linearStatesByTeam = new Map<string, { states: ReturnType<typeof parseLinearWorkflowStates>; observedAt: number }>();

  const queueLinearLifecycle = async (task: TaskRecord, deliverAs: "steer" | "followUp"): Promise<{ task: TaskRecord; note: string }> => {
    if (!linearLifecycleIsActionable(task) || linearPromptsInFlight.has(task.id)) return { task, note: "" };
    linearPromptsInFlight.add(task.id);
    let claimId: string | undefined;
    try {
      const claimed = await coordinator.claimLinearLifecyclePrompt(task.projectId, task.id);
      if (!claimed?.linear?.promptClaimId) return { task, note: " Linear lifecycle sync is already queued by another Lead session." };
      task = claimed;
      claimId = claimed.linear.promptClaimId;
      const activeTools = new Set(pi.getActiveTools());
      const missing = LINEAR_START_TOOLS.filter((tool) => !activeTools.has(tool));
      if (missing.length > 0) {
        const updated = await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) => ({
          ...current,
          status: "unavailable",
          promptClaimId: current.promptClaimId === claimId ? undefined : current.promptClaimId,
          promptClaimedAt: current.promptClaimId === claimId ? undefined : current.promptClaimedAt,
          lastError: `Required pi-linear tools are disabled: ${missing.join(", ")}`,
          updatedAt: new Date().toISOString(),
        }));
        return {
          task: updated,
          note: ` Linear lifecycle was not changed because required pi-linear tools are disabled (${missing.join(", ")}); worker startup continues.`,
        };
      }
      pi.sendMessage({
        customType: "lead:linear-lifecycle",
        content: linearStartInstruction(task),
        display: true,
        details: { taskId: task.id, issueIdentifier: task.linear!.issueIdentifier, claimId },
      }, { deliverAs, triggerTurn: true });
      const now = new Date().toISOString();
      const updated = await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) => ({
        ...current,
        status: current.status === "verifying" ? "verifying" : "pending",
        issueId: current.status === "verifying" ? current.issueId : undefined,
        teamId: current.status === "verifying" ? current.teamId : undefined,
        issueObservedAt: current.status === "verifying" ? current.issueObservedAt : undefined,
        candidateStateId: current.status === "verifying" ? current.candidateStateId : undefined,
        candidateStateName: current.status === "verifying" ? current.candidateStateName : undefined,
        candidateTeamId: current.status === "verifying" ? current.candidateTeamId : undefined,
        candidateObservedAt: current.status === "verifying" ? current.candidateObservedAt : undefined,
        promptedAt: now,
        promptCount: (current.promptCount ?? 0) + 1,
        promptClaimId: current.promptClaimId === claimId ? undefined : current.promptClaimId,
        promptClaimedAt: current.promptClaimId === claimId ? undefined : current.promptClaimedAt,
        lastError: undefined,
        updatedAt: now,
      }));
      return {
        task: updated,
        note: ` Linear lifecycle sync for ${updated.linear?.issueIdentifier} is queued and requires verified pi-linear readback.`,
      };
    } catch (error) {
      const updated = await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) => ({
        ...current,
        status: current.status === "verifying" ? "verifying" : "pending",
        promptClaimId: current.promptClaimId === claimId ? undefined : current.promptClaimId,
        promptClaimedAt: current.promptClaimId === claimId ? undefined : current.promptClaimedAt,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }));
      return { task: updated, note: " Linear lifecycle sync remains pending; worker startup is not blocked." };
    } finally {
      linearPromptsInFlight.delete(task.id);
    }
  };

  const resumePendingLinearLifecycle = async () => {
    if (!dashboardProjectId) return;
    const tasks = await coordinator.list(dashboardProjectId);
    for (const task of tasks.filter((candidate) => {
      if (!linearLifecycleIsActionable(candidate)) return false;
      const prompted = Date.parse(candidate.linear?.promptedAt ?? "");
      return !Number.isFinite(prompted) || Date.now() - prompted > 1_000;
    })) {
      await queueLinearLifecycle(task, "followUp");
    }
  };

  const updateDashboard = async (emitEvents = false) => {
    if (dashboardUpdateRunning || !dashboardContext || !dashboardProjectId) return;
    dashboardUpdateRunning = true;
    try {
      const tasks = await coordinator.list(dashboardProjectId).catch(() => []);
      const active = tasks.filter((task) => !["completed", "failed", "stopped", "merged"].includes(task.status));
      const running = active.filter((task) => task.status === "running" || task.status === "starting").length;
      const blocked = active.filter((task) => task.status === "blocked").length;
      const green = active.filter((task) => task.status === "pr-ready-ci-green").length;
      dashboardContext.ui.setStatus(
        STATUS_KEY,
        `Lead · ${active.length} active${running ? ` · ${running} running` : ""}${blocked ? ` · ${blocked} blocked` : ""}${green ? ` · ${green} green` : ""}`,
      );
      dashboardContext.ui.setWidget(
        WIDGET_KEY,
        active.length > 0 ? ["Lead workers", ...active.slice(0, 6).map(taskLine)] : undefined,
        { placement: "aboveEditor" },
      );

      const unobserved = tasks.filter((task) => task.leadObservedStatus !== task.status);
      let actionable = pendingLeadEvents(tasks);
      const delivered = deliveredLeadEventIds(dashboardContext.sessionManager.getEntries());
      const recovered = actionable.filter(({ event }) => delivered.has(event.id));
      for (const { task, event } of recovered) {
        await coordinator.markLeadEventsObserved(dashboardProjectId, task.id, [event.id]);
      }
      actionable = actionable.filter(({ event }) => !delivered.has(event.id));
      for (const task of unobserved.filter((candidate) => !isActionableWorkerState(candidate.status))) {
        await coordinator.markLeadObserved(dashboardProjectId, task.id, task.status);
      }

      if (emitEvents && actionable.length > 0 && dashboardContext.isIdle()) {
        const batch = actionable.slice(0, 1);
        for (const { task, event } of batch) {
          dashboardContext.ui.notify(
            `${task.brief.title}: ${event.status}${event.blockedReason ? ` — ${event.blockedReason}` : ""}`,
            event.status === "blocked" || event.status === "failed" ? "warning" : "info",
          );
        }
        const eventIds = batch.map(({ event }) => event.id);
        pi.sendMessage({
          customType: "lead:worker-event",
          content: workerEventMessage(batch),
          display: true,
          details: { eventIds, taskIds: [...new Set(batch.map(({ task }) => task.id))] },
        }, { deliverAs: "followUp", triggerTurn: true });
        const eventsByTask = new Map<string, string[]>();
        for (const { task, event } of batch) {
          eventsByTask.set(task.id, [...(eventsByTask.get(task.id) ?? []), event.id]);
        }
        for (const [taskId, ids] of eventsByTask) {
          await coordinator.markLeadEventsObserved(dashboardProjectId, taskId, ids);
        }
      }
    } finally {
      dashboardUpdateRunning = false;
    }
  };

  const refreshPendingPullRequests = async () => {
    if (ciRefreshRunning || !dashboardProjectId) return;
    ciRefreshRunning = true;
    try {
      const tasks = await coordinator.list(dashboardProjectId);
      for (const task of tasks.filter((candidate) => candidate.status === "pr-ready-ci-pending" && candidate.pullRequest?.url)) {
        await coordinator.refreshPullRequest(dashboardProjectId, task.id).catch(() => undefined);
      }
      await updateDashboard(true);
    } finally {
      ciRefreshRunning = false;
    }
  };

  const drainInbox = async () => {
    if (inboxRunning || !inboxContext || !workerProjectId || !workerTaskId) return;
    inboxRunning = true;
    try {
      const messages = await coordinator.claimMessages(workerProjectId, workerTaskId);
      for (const message of messages) {
        try {
          if (inboxContext.isIdle()) pi.sendUserMessage(message.text);
          else pi.sendUserMessage(message.text, { deliverAs: "steer" });
          await coordinator.acknowledgeMessage(workerProjectId, workerTaskId, message.id);
        } catch (error) {
          await coordinator.releaseMessage(workerProjectId, workerTaskId, message.id);
          inboxContext.ui.notify(`Could not deliver Lead message: ${error instanceof Error ? error.message : String(error)}`, "warning");
          break;
        }
      }
    } finally {
      inboxRunning = false;
    }
  };

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${isWorker && workerTaskId ? workerRolePrompt(workerTaskId, workerRole ?? "implementation") : LEAD_SYSTEM_PROMPT}`,
  }));

  pi.on("session_start", async (_event, ctx) => {
    await store.initialize();
    if (!isWorker && shouldResetLegacyUi(ctx)) {
      ctx.ui.setStatus("team-orchestration", undefined);
      ctx.ui.setStatus("team-context", undefined);
      if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
      pi.appendEntry("lead-v2:legacy-ui-reset", { resetAt: new Date().toISOString() });
    }
    if (isWorker && workerTaskId && workerProjectId) {
      const task = await store.readTask(workerProjectId, workerTaskId);
      if (task) {
        if (!pi.getSessionName()) pi.setSessionName(workerLabel(task));
        ctx.ui.setTitle(`${task.role === "review" ? "Review" : "Worker"} · ${task.brief.title}`);
        ctx.ui.setStatus(STATUS_KEY, `${task.role} · ${task.status}`);
        ctx.ui.setWidget(WIDGET_KEY, [taskLine(task), `Lead task ${task.id.slice(0, 8)}`], { placement: "aboveEditor" });
        inboxContext = ctx;
        inboxTimer = setInterval(() => void drainInbox(), 1_000);
        inboxTimer.unref();
        void drainInbox();
      }
      return;
    }

    const context = await coordinator.project({
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      cmuxWorkspaceId: process.env.CMUX_WORKSPACE_ID,
      cmuxSurfaceId: process.env.CMUX_SURFACE_ID,
    }).catch(() => undefined);
    if (!context) {
      ctx.ui.setStatus(STATUS_KEY, "Lead · no Git repository");
      return;
    }
    if (!pi.getSessionName()) pi.setSessionName(`Lead · ${context.git.name}`);
    ctx.ui.setTitle(`Lead · ${context.git.name}`);
    dashboardProjectId = context.record.projectId;
    dashboardContext = ctx;
    await updateDashboard(false);
    leadWakeTimer = setTimeout(() => void updateDashboard(true), 250);
    leadWakeTimer.unref();
    linearWakeTimer = setTimeout(() => void resumePendingLinearLifecycle(), 500);
    linearWakeTimer.unref();
    dashboardTimer = setInterval(() => void updateDashboard(true), DASHBOARD_INTERVAL_MS);
    ciTimer = setInterval(() => void refreshPendingPullRequests(), CI_INTERVAL_MS);
    dashboardTimer.unref();
    ciTimer.unref();
  });

  pi.on("session_shutdown", () => {
    if (dashboardTimer) clearInterval(dashboardTimer);
    if (leadWakeTimer) clearTimeout(leadWakeTimer);
    if (linearWakeTimer) clearTimeout(linearWakeTimer);
    if (ciTimer) clearInterval(ciTimer);
    if (inboxTimer) clearInterval(inboxTimer);
    dashboardTimer = undefined;
    leadWakeTimer = undefined;
    linearWakeTimer = undefined;
    ciTimer = undefined;
    inboxTimer = undefined;
    dashboardContext = undefined;
    inboxContext = undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (isWorker || !dashboardProjectId || !LINEAR_START_TOOLS.includes(event.toolName as typeof LINEAR_START_TOOLS[number])) return;
    const tasks = await coordinator.list(dashboardProjectId);
    if (event.toolName === "linear_list_issue_statuses") {
      if (event.isError) return;
      const filterTeamId = linearStatusFilterTeamId(event.input);
      if (!filterTeamId) return;
      const states = parseLinearWorkflowStates(event.details, event.content)
        .filter((state) => state.team?.id === filterTeamId);
      if (states.length === 0) return;
      linearStatesByTeam.set(filterTeamId, { states, observedAt: Date.now() });
      for (const task of tasks.filter((candidate) =>
        candidate.linear?.status !== "in-progress" && candidate.linear?.teamId === filterTeamId)) {
        await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) =>
          linearLifecycleAfterStatuses(current, states));
      }
      return;
    }
    const input = event.input as { issue?: unknown };
    const inputIdentifier = normalizeLinearIssueReference(typeof input.issue === "string" ? input.issue : undefined);
    const snapshot = parseLinearIssueSnapshot(event.details, event.content);
    const identifier = snapshot?.identifier ?? inputIdentifier;
    if (!identifier) return;
    for (const task of tasks.filter((candidate) =>
      candidate.linear?.issueIdentifier === identifier && candidate.linear.status !== "in-progress")) {
      const before = task.linear!;
      let updated = await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) =>
        linearLifecycleAfterToolResult(current, event.toolName, snapshot, event.isError, resultText(event.content)));
      const teamId = updated.linear?.teamId;
      const cachedStates = teamId ? linearStatesByTeam.get(teamId) : undefined;
      if (event.toolName === "linear_get_issue" && !event.isError && updated.linear?.status !== "in-progress"
        && cachedStates && Date.now() - cachedStates.observedAt < 5 * 60_000) {
        updated = await coordinator.updateLinearLifecycle(task.projectId, task.id, (current) =>
          linearLifecycleAfterStatuses(current, cachedStates.states));
      }
      if (before.status !== updated.linear?.status && updated.linear?.status === "in-progress") {
        ctx.ui.notify(`${identifier} is verified In Progress in Linear`, "info");
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isDestructiveLinearTool(event.toolName)) {
      return { block: true, reason: "Destructive Linear operations and workspace switching are outside the Lead workflow boundary." };
    }
    if (isWorker && isLinearMutationTool(event.toolName)) {
      return { block: true, reason: "Worker sessions cannot mutate Linear; report the requested tracking change to the Lead." };
    }
    if (!isWorker && dashboardProjectId && isLinearMutationTool(event.toolName)) {
      const tasks = await coordinator.list(dashboardProjectId);
      const reason = linearLifecycleMutationSafetyReason(
        tasks,
        event.toolName,
        event.input as Record<string, unknown>,
      );
      if (reason) return { block: true, reason };
    }
    if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
      const input = event.input as { path?: unknown; file_path?: unknown };
      const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
      if (path) {
        const reason = await sensitiveResolvedPathReason(path.startsWith("~/") ? path : resolve(ctx.cwd, path));
        if (reason) return { block: true, reason };
      }
      if ((workerRole === "review" || workerRole === "research") && (event.toolName === "write" || event.toolName === "edit")) {
        return { block: true, reason: `${workerRole} workers are read-only; send implementation changes to an implementation worker.` };
      }
    }
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const secretReason = sensitiveCommandReason(command)
      ?? await sensitiveCommandResolvedPathReason(command, ctx.cwd);
    if (secretReason) return { block: true, reason: secretReason };
    if (workerRole === "review" || workerRole === "research") {
      const reason = readOnlyWorkerCommandReason(command);
      if (reason) return { block: true, reason: `${workerRole} worker bash is read-only: ${reason}.` };
    }
    const risk = classifyBashRisk(command);
    if (!risk) return;
    if (risk === "force-push") return { block: true, reason: riskDescription(risk) };
    if (!ctx.hasUI) return { block: true, reason: `${riskDescription(risk)} No interactive operator is available to authorize it.` };
    const confirmed = await ctx.ui.confirm("Separate authorization required", `${riskDescription(risk)}\n\n${command}\n\nAllow this one command?`);
    if (!confirmed) return { block: true, reason: `Operator did not authorize ${risk}.` };
  });

  if (!isWorker) {
    pi.registerTool({
      name: "lead_delegate",
      label: "Delegate Worker",
      description: "Open a real visible Pi worker session in cmux. Implementation workers get isolated Git worktrees and full shell/edit tools. Review workers share a parent implementation worktree and receive its issue, acceptance criteria, diff, and validation evidence. No contract or approval phrase is required.",
      promptSnippet: "Delegate implementation, research, or independent review to a visible Pi worker",
      promptGuidelines: [
        "Use lead_delegate when a separate visible Pi context will help; include issue context and concrete acceptance criteria for issue-backed work.",
        "When implementation is tied to Linear, pass linearIssue so the Lead updates it to the team's canonical started/In Progress state with pi-linear and verifies readback.",
        "Use a lead_delegate review worker with parentTaskId before accepting implementation work.",
      ],
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        task: Type.String({ minLength: 1, maxLength: 30_000 }),
        role: Type.Optional(RoleSchema),
        issue: Type.Optional(Type.String({ description: "Actual issue identifier, URL, title, and relevant description. Include enough context for an independent reviewer." })),
        linearIssue: Type.Optional(Type.String({ description: "Exact Linear identifier (ENG-123) or linear.app issue URL when this implementation is Linear-backed. Omit for local/GitHub-only work." })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        baseBranch: Type.Optional(Type.String()),
        parentTaskId: Type.Optional(Type.String({ description: "Required for review workers; implementation task ID or unique prefix." })),
        model: Type.Optional(Type.String({ description: "Optional Pi model pattern for this worker. Defaults to the Lead model." })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        let task = await coordinator.delegate(params, {
          cwd: ctx.cwd,
          sessionFile: ctx.sessionManager.getSessionFile(),
          cmuxWorkspaceId: process.env.CMUX_WORKSPACE_ID,
          cmuxSurfaceId: process.env.CMUX_SURFACE_ID,
          model: modelName(ctx),
          thinking: pi.getThinkingLevel(),
          signal,
          onStage: (stage) => onUpdate?.(textResult(stage)),
        });
        let linearNote = "";
        if (task.linear) {
          const queued = await queueLinearLifecycle(task, "steer");
          task = queued.task;
          linearNote = queued.note;
        }
        await updateDashboard(false);
        return textResult(
          `Visible ${task.role} worker ${task.id.slice(0, 8)} is running in ${task.surface?.surfaceId}. The operator can inspect or type in that Pi session directly.${linearNote}`,
          { task },
        );
      },
      renderCall(args, theme) {
        return new Text(`${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", args.role ?? "implementation")} · ${args.title}`, 0, 0);
      },
    });

    pi.registerTool({
      name: "lead_workers",
      label: "Lead Workers",
      description: "List durable worker states, worktrees, surfaces, PRs, blockers, and handoffs for this project.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const context = await coordinator.project({
          cwd: ctx.cwd,
          sessionFile: ctx.sessionManager.getSessionFile(),
          cmuxWorkspaceId: process.env.CMUX_WORKSPACE_ID,
          cmuxSurfaceId: process.env.CMUX_SURFACE_ID,
          signal,
        });
        const tasks = await coordinator.list(context.record.projectId);
        return textResult(summarizeTasks(tasks), { tasks });
      },
    });

    pi.registerTool({
      name: "lead_message_worker",
      label: "Message Worker",
      description: "Send a steering message to an existing visible worker Pi session without changing focus.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Full worker ID or unique prefix." }),
        message: Type.String({ minLength: 1, maxLength: 10_000 }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const context = await coordinator.project({ cwd: ctx.cwd, signal });
        const task = await coordinator.message(context.record.projectId, params.taskId, params.message, signal);
        return textResult(`Message queued for ${task.id.slice(0, 8)}. Its live Pi session will receive it without terminal keystroke injection.`, { taskId: task.id });
      },
    });

    pi.registerTool({
      name: "lead_update_worker",
      label: "Update Worker State",
      description: "Update a durable worker state after direct operator intervention or process exit. This does not send terminal input, merge, deploy, or delete the worktree.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Full worker ID or unique prefix." }),
        status: ManualStatusSchema,
        reason: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const context = await coordinator.project({ cwd: ctx.cwd, signal });
        const task = await coordinator.store.requireTask(context.record.projectId, params.taskId);
        const updated = await coordinator.report(context.record.projectId, task.id, {
          status: params.status,
          blockedReason: params.reason,
          summary: params.summary ?? params.reason,
        }, signal);
        await updateDashboard(false);
        return textResult(`${updated.id.slice(0, 8)}: ${updated.status}`, { task: updated });
      },
    });

    pi.registerTool({
      name: "lead_refresh_pr",
      label: "Refresh Worker PR",
      description: "Read authoritative GitHub PR/check state and classify it as pending, green, failed/blocked, or merged. This never merges.",
      parameters: Type.Object({ taskId: Type.String({ description: "Full implementation worker ID or unique prefix." }) }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const context = await coordinator.project({ cwd: ctx.cwd, signal });
        const task = await coordinator.refreshPullRequest(context.record.projectId, params.taskId, signal);
        await updateDashboard(false);
        return textResult(`${task.id.slice(0, 8)}: ${task.status}${task.blockedReason ? ` — ${task.blockedReason}` : ""}`, { task });
      },
    });
  } else {
    pi.registerTool({
      name: "lead_worker_report",
      label: "Report to Lead",
      description: "Persist this visible worker's status, validation, PR, blocker, handoff, or review acceptance matrix for the Lead. Call it proactively at meaningful transitions.",
      promptSnippet: "Report worker progress, blockers, validation, PR/CI state, and review evidence to the Lead",
      promptGuidelines: ["Use lead_worker_report before a worker stops, whenever it is blocked, and whenever PR or CI state changes."],
      parameters: Type.Object({
        status: Type.Optional(WorkerStatusSchema),
        summary: Type.Optional(Type.String()),
        blockedReason: Type.Optional(Type.String()),
        handoff: Type.Optional(Type.String()),
        prUrl: Type.Optional(Type.String()),
        commitSha: Type.Optional(Type.String()),
        checks: Type.Optional(Type.Array(CheckSchema, { maxItems: 100 })),
        reviewVerdict: Type.Optional(StringEnum(["approved", "changes-requested"] as const)),
        acceptance: Type.Optional(Type.Array(AcceptanceSchema, { maxItems: 100 })),
        findings: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (!workerProjectId || !workerTaskId) throw new Error("Worker identity is unavailable");
        const task = await coordinator.report(workerProjectId, workerTaskId, params, signal);
        ctx.ui.setStatus(STATUS_KEY, `${task.role} · ${task.status}`);
        ctx.ui.setWidget(WIDGET_KEY, [taskLine(task), `Lead task ${task.id.slice(0, 8)}`], { placement: "aboveEditor" });
        return textResult(`Lead updated: ${task.status}.`, { task });
      },
    });
  }

  pi.registerCommand("workers", {
    description: "Show visible Lead workers and durable status",
    handler: async (_args, ctx) => {
      const projectId = workerProjectId ?? (await coordinator.project({ cwd: ctx.cwd }).catch(() => undefined))?.record.projectId;
      if (!projectId) {
        ctx.ui.notify("No Lead project is active in this directory", "warning");
        return;
      }
      ctx.ui.notify(summarizeTasks(await coordinator.list(projectId)), "info");
    },
  });

  if (!isWorker) {
    pi.registerCommand("worker-message", {
      description: "Send a message to a worker: /worker-message <id> <message>",
      handler: async (args, ctx) => {
        const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) {
          ctx.ui.notify("Usage: /worker-message <id> <message>", "warning");
          return;
        }
        const context = await coordinator.project({ cwd: ctx.cwd });
        const task = await coordinator.message(context.record.projectId, match[1], match[2]);
        ctx.ui.notify(`Message queued for ${task.id.slice(0, 8)}`, "info");
      },
    });

    pi.registerCommand("lead-doctor", {
      description: "Check Git, Pi, cmux, and visible-worker readiness",
      handler: async (_args, ctx) => {
        const context = await coordinator.project({
          cwd: ctx.cwd,
          sessionFile: ctx.sessionManager.getSessionFile(),
          cmuxWorkspaceId: process.env.CMUX_WORKSPACE_ID,
          cmuxSurfaceId: process.env.CMUX_SURFACE_ID,
        }).catch((error: Error) => {
          ctx.ui.notify(`Lead doctor: ${error.message}`, "error");
          return undefined;
        });
        if (!context) return;
        const cmux = await execute("cmux", ["identify", "--json"], { cwd: context.git.root, timeout: 15_000 });
        const version = await execute("pi", ["--version"], { cwd: context.git.root, timeout: 15_000 });
        const lines = [
          `Git: ${context.git.root} (base ${context.git.defaultBaseBranch})`,
          `Pi: ${version.code === 0 ? version.stdout.trim() : "not available in PATH"}`,
          `cmux: ${cmux.code === 0 ? "ready" : "not reachable"}`,
          `Caller workspace: ${process.env.CMUX_WORKSPACE_ID || "missing"}`,
          `Caller surface: ${process.env.CMUX_SURFACE_ID || "missing"}`,
          `Worker extension: ${extensionPath || "package discovery"}`,
          `State: ${store.root}`,
        ];
        ctx.ui.notify(lines.join("\n"), cmux.code === 0 && version.code === 0 ? "info" : "warning");
      },
    });
  }
}
