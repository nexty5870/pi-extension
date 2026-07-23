import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  classifyBashRisk,
  isDestructiveLinearTool,
  isLinearMutationTool,
  normalizePiToolPath,
  readOnlyWorkerCommandReason,
  riskDescription,
  sensitiveCommandReason,
  sensitiveCommandResolvedPathReason,
  sensitiveResolvedPathReason,
} from "../lead/safety.ts";
import { defaultV4StateDir } from "./store.ts";
import { V4TransportClient } from "./transport.ts";
import type { DigestBatch, LeadAttachment, StableCmuxIdentity, V4StatusSnapshot, V4ThinkingLevel, WorkerTaskV4 } from "./types.ts";

declare const __filename: string;

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const RoleSchema = StringEnum(["implementation", "research", "review"] as const);
const StatusSchema = StringEnum(["running", "blocked", "pr-ready-ci-pending", "completed", "failed", "stopped"] as const);
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

interface ClientSession {
  projectRoot: string;
  projectName: string;
  identity: StableCmuxIdentity;
  sessionId: string;
  sessionGeneration: number;
  clientIncarnation: string;
  attachment?: LeadAttachment;
  processIncarnation?: string;
}

function redactPrivate<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactPrivate(item)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["ownershipToken", "token", "sessionFile"].includes(key))
    .map(([key, nested]) => [key, redactPrivate(nested)])) as T;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: redactPrivate(details) };
}

function modelName(ctx: ExtensionContext): string {
  if (!ctx.model) throw new Error("V4 requires an explicit active provider/model; no fallback is permitted");
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function cmuxIdentity(payload: Record<string, unknown>): StableCmuxIdentity {
  const caller = record(payload.caller);
  if (!caller) throw new Error("cmux identify omitted the stable caller identity");
  const identity = {
    windowUuid: string(caller.window_id) ?? "",
    workspaceUuid: string(caller.workspace_id) ?? "",
    paneUuid: string(caller.pane_id) ?? "",
    surfaceUuid: string(caller.surface_id) ?? "",
    windowRef: string(caller.window_ref),
    workspaceRef: string(caller.workspace_ref),
    paneRef: string(caller.pane_ref),
    surfaceRef: string(caller.surface_ref),
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![identity.windowUuid, identity.workspaceUuid, identity.paneUuid, identity.surfaceUuid].every((value) => uuid.test(value))) {
    throw new Error("cmux caller identity is incomplete or uses short refs; V4 requires stable UUIDs");
  }
  return identity;
}

function summarize(snapshot: V4StatusSnapshot): string {
  const attached = snapshot.attachments.filter((attachment) => attachment.state === "attached").length;
  const active = snapshot.tasks.filter((task) => ["launching", "running", "unknown", "quarantined"].includes(task.processState)).length;
  const lines = [
    `V4 supervisor generation ${snapshot.supervisorGeneration} · ${attached} Lead${attached === 1 ? "" : "s"} · ${snapshot.features.length} feature${snapshot.features.length === 1 ? "" : "s"} · ${active}/${snapshot.config.maxConcurrentWorkerProcesses} worker processes`,
    `Agents workspace: ${snapshot.agentsWorkspace?.workspaceUuid ?? "not created"} · automatic retirement ${snapshot.config.automaticWorkerSurfaceRetirement ? "ON" : "off"}`,
    ...snapshot.features.map((feature) => {
      const tasks = snapshot.tasks.filter((task) => task.featureId === feature.id);
      return `${feature.id.slice(0, 8)} ${feature.title} · owner ${feature.ownerAttachmentId?.slice(0, 8) ?? "unowned"}/g${feature.ownerGeneration} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
    }),
    ...snapshot.tasks.map((task) => `  ${task.id.slice(0, 8)} ${task.role} · ${task.status}/${task.processState} · ${task.resolved.requestedModel}/${task.resolved.requestedThinking}${task.blockedReason ? ` — ${task.blockedReason}` : ""}`),
  ];
  return lines.join("\n");
}

export default function leadV4Extension(pi: ExtensionAPI) {
  const isWorker = Boolean(process.env.PI_LEAD_V4_TASK_ID);
  const taskId = process.env.PI_LEAD_V4_TASK_ID;
  const taskToken = process.env.PI_LEAD_V4_TASK_TOKEN;
  const workerRole = process.env.PI_LEAD_V4_ROLE;
  const featureId = process.env.PI_LEAD_V4_FEATURE_ID;
  const featureToken = process.env.PI_LEAD_V4_FEATURE_TOKEN;
  const sessionGeneration = Number(process.env.PI_LEAD_V4_SESSION_GENERATION ?? "1");
  const instanceGeneration = randomUUID();
  const runtimeScript = join(dirname(__filename), "runtime", "supervisor.mjs");
  const extensionPath = join(dirname(__filename), "..", "lead", "index.ts");
  const transport = new V4TransportClient({
    runtimeScript,
    stateDir: defaultV4StateDir(process.env),
    extensionPath,
  });
  let active = true;
  let session: ClientSession | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let digestTimer: ReturnType<typeof setInterval> | undefined;
  let callbackRunning = false;
  let workerRecord: WorkerTaskV4 | undefined;
  const pendingDigestAcks: DigestBatch[] = [];

  const projectParams = () => {
    if (!session) throw new Error("V4 client is not attached yet");
    return { projectRoot: session.projectRoot, projectName: session.projectName, cmuxSocketPath: process.env.CMUX_SOCKET_PATH };
  };

  const rpc = <T>(method: string, params: Record<string, unknown> = {}) => transport.request<T>(method, { ...projectParams(), ...params });

  const current = (ctx: ExtensionContext): boolean => Boolean(
    active
    && session
    && instanceGeneration
    && session.sessionId === ctx.sessionManager.getSessionId(),
  );

  const identify = async (ctx: ExtensionContext): Promise<StableCmuxIdentity> => {
    const result = await pi.exec("cmux", ["--json", "--id-format", "both", "identify"], { cwd: ctx.cwd, timeout: 15_000 });
    if (result.code !== 0) throw new Error(`cmux identify failed: ${result.stderr || result.stdout}`);
    return cmuxIdentity(JSON.parse(result.stdout) as Record<string, unknown>);
  };

  const gitRoot = async (ctx: ExtensionContext): Promise<string> => {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 15_000 });
    if (result.code !== 0) throw new Error("V4 Lead supervision requires a Git repository");
    return result.stdout.trim();
  };

  const flushDigestAcks = async (ctx: ExtensionContext): Promise<void> => {
    const currentSession = session;
    const attachment = currentSession?.attachment;
    if (!current(ctx) || !attachment) return;
    const receipts = new Set(ctx.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== "lead-v4:digest") return [];
      const batchId = record(entry.details)?.batchId;
      return typeof batchId === "string" ? [batchId] : [];
    }));
    for (const batch of [...pendingDigestAcks]) {
      if (!receipts.has(batch.id)) continue;
      await rpc("acknowledgeDigest", {
        input: { attachmentId: attachment.id, ownershipToken: attachment.ownershipToken, batchId: batch.id, eventIds: batch.eventIds },
      });
      pendingDigestAcks.splice(pendingDigestAcks.indexOf(batch), 1);
    }
  };

  const deliverDigest = async (ctx: ExtensionContext, includeTelemetry: boolean, triggerTurn: boolean): Promise<void> => {
    const currentSession = session;
    if (!current(ctx) || isWorker || !currentSession?.attachment) return;
    await flushDigestAcks(ctx);
    if (pendingDigestAcks.length > 0) return;
    const attachment = currentSession.attachment;
    const batch = await rpc<DigestBatch | undefined>("claimDigest", {
      input: { attachmentId: attachment.id, ownershipToken: attachment.ownershipToken, includeTelemetry },
    });
    if (!batch || !current(ctx)) return;
    pi.sendMessage({
      customType: "lead-v4:digest",
      content: `${batch.content}\n\nContinue the existing operator request if action is needed. Routine telemetry requires no LLM action.`,
      display: true,
      details: { batchId: batch.id, eventIds: batch.eventIds, attachmentId: attachment.id },
    }, { deliverAs: "followUp", triggerTurn: triggerTurn && batch.actionable });
    // Acknowledge only on a later callback after the exact batch receipt is
    // visible in the Pi session tree. A Lead killed at claim/send/ack boundaries
    // therefore gets safe at-least-once replay instead of silent loss.
    pendingDigestAcks.push(batch);
  };

  const refreshStatus = async (ctx: ExtensionContext): Promise<V4StatusSnapshot | undefined> => {
    if (!current(ctx) || callbackRunning) return undefined;
    callbackRunning = true;
    try {
      const snapshot = await rpc<V4StatusSnapshot>("status");
      if (!current(ctx)) return undefined;
      ctx.ui.setStatus("lead-v4", `V4 · ${snapshot.features.length} tracks · ${snapshot.pendingActionable} action · ${snapshot.tasks.filter((task) => ["launching", "running", "unknown", "quarantined"].includes(task.processState)).length}/${snapshot.config.maxConcurrentWorkerProcesses} processes`);
      ctx.ui.setWidget("lead-v4", snapshot.features.length ? snapshot.features.slice(0, 6).map((feature) => {
        const tasks = snapshot.tasks.filter((task) => task.featureId === feature.id);
        return `${feature.ownerAttachmentId ? "●" : "!"} ${feature.title} · ${tasks.map((task) => `${task.role}:${task.status}/${task.processState}`).join(", ") || "no tasks"}`;
      }) : undefined, { placement: "aboveEditor" });
      if (isWorker && taskId) {
        const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
        if (task?.status === "stopped" && current(ctx)) ctx.shutdown();
      }
      return snapshot;
    } finally {
      callbackRunning = false;
    }
  };

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${isWorker
      ? "You are a V4 worker attached to a durable supervisor. Use lead_worker_report_v4 for handoff. Do not change Pi sessions or silently change model/thinking."
      : "You are a thin V4 Lead client. The durable local supervisor owns tracks, scheduling, worker processes, and event routing. Use the lead_v4_* tools for plain-language feature, Lead, worker, model, stop, status, and inspection actions. Never treat a Lead surface as a worker cleanup target."}`,
  }));

  pi.on("session_start", async (_event, ctx) => {
    const projectRoot = process.env.PI_LEAD_PROJECT_ROOT || await gitRoot(ctx);
    const identity = await identify(ctx);
    session = {
      projectRoot,
      projectName: basename(projectRoot),
      identity,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionGeneration,
      clientIncarnation: instanceGeneration,
      processIncarnation: isWorker ? randomUUID() : undefined,
    };
    await transport.ensure();
    await rpc("initializeProject");
    const availableModels = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    if (isWorker) {
      if (!taskId || !taskToken || !session.processIncarnation) throw new Error("V4 worker launch identity is incomplete");
      if (taskId !== session.sessionId) {
        ctx.ui.notify(`V4 worker session mismatch: expected ${taskId}, actual ${session.sessionId}. Generation quarantined.`, "error");
        return;
      }
      workerRecord = await rpc<WorkerTaskV4>("workerHello", { input: {
        taskId,
        ownershipToken: taskToken,
        sessionGeneration,
        sessionId: session.sessionId,
        processIncarnation: session.processIncarnation,
        pid: process.pid,
        cmux: identity,
        actualModel: modelName(ctx),
        actualThinking: pi.getThinkingLevel(),
      } });
      heartbeatTimer = setInterval(() => {
        const captured = instanceGeneration;
        if (!active || captured !== instanceGeneration || !session?.processIncarnation) return;
        void rpc("workerHeartbeat", { input: {
          taskId,
          ownershipToken: taskToken,
          sessionGeneration,
          sessionId: session.sessionId,
          processIncarnation: session.processIncarnation,
          pid: process.pid,
          cmux: session.identity,
        } }).catch(() => undefined);
      }, 5_000);
      heartbeatTimer.unref();
    } else {
      const attached = await rpc<{ attachment: LeadAttachment; snapshot: V4StatusSnapshot }>("attach", { input: {
        sessionId: session.sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        clientIncarnation: session.clientIncarnation,
        sessionGeneration,
        pid: process.pid,
        cmux: identity,
        model: modelName(ctx),
        thinking: pi.getThinkingLevel(),
        availableModels,
        featureId,
        featureOwnershipToken: featureToken,
        inherited: { model: modelName(ctx), thinking: pi.getThinkingLevel() },
      } });
      session.attachment = attached.attachment;
      if (!pi.getSessionName()) pi.setSessionName(featureId ? `Lead · ${attached.snapshot.features.find((feature) => feature.id === featureId)?.title ?? "feature"}` : `Lead V4 · ${session.projectName}`);
      ctx.ui.setTitle(featureId ? `Lead · ${attached.snapshot.features.find((feature) => feature.id === featureId)?.title ?? "feature"}` : `Lead V4 · ${session.projectName}`);
      heartbeatTimer = setInterval(() => {
        const captured = instanceGeneration;
        const attachment = session?.attachment;
        if (!active || captured !== instanceGeneration || !attachment || !session) return;
        void rpc("heartbeat", { input: {
          attachmentId: attachment.id,
          ownershipToken: attachment.ownershipToken,
          sessionId: session.sessionId,
          sessionGeneration: session.sessionGeneration,
          cmux: session.identity,
        } }).catch(() => undefined);
      }, 5_000);
      heartbeatTimer.unref();
      digestTimer = setInterval(() => {
        if (active && current(ctx) && ctx.isIdle()) void deliverDigest(ctx, false, true).catch(() => undefined);
      }, 2_000);
      digestTimer.unref();
      await deliverDigest(ctx, true, false);
    }
    statusTimer = setInterval(() => void refreshStatus(ctx).catch(() => undefined), 2_500);
    statusTimer.unref();
    await refreshStatus(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (isWorker && current(ctx) && taskId && taskToken) {
      await rpc("workerAgentStart", { input: { taskId, ownershipToken: taskToken, sessionGeneration } });
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const currentSession = session;
    if (!current(ctx) || !currentSession) return;
    const actualModel = `${event.model.provider}/${event.model.id}`;
    if (isWorker && taskId && taskToken) {
      const actualThinking = pi.getThinkingLevel();
      if (workerRecord && actualModel === workerRecord.resolved.actualModel && actualThinking === workerRecord.resolved.actualThinking) return;
      await rpc("quarantineWorkerModel", { input: { taskId, ownershipToken: taskToken, sessionGeneration, actualModel, actualThinking } });
      ctx.ui.notify("Worker model changed. This generation is quarantined; provide a durable handoff and start a visible new generation.", "error");
      return;
    }
    // Lead model changes are persisted by a fresh attach of the same Pi session
    // identity and client incarnation; workers are never silently rewritten.
    const attachment = currentSession.attachment;
    const attached = await rpc<{ attachment: LeadAttachment }>("attach", { input: {
      attachmentId: attachment?.id,
      attachmentOwnershipToken: attachment?.ownershipToken,
      sessionId: currentSession.sessionId,
      sessionFile: ctx.sessionManager.getSessionFile(),
      clientIncarnation: currentSession.clientIncarnation,
      sessionGeneration: currentSession.sessionGeneration,
      pid: process.pid,
      cmux: currentSession.identity,
      model: actualModel,
      thinking: pi.getThinkingLevel(),
      availableModels: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
      featureId,
      featureOwnershipToken: featureToken,
      inherited: { model: actualModel, thinking: pi.getThinkingLevel() },
    } });
    currentSession.attachment = attached.attachment;
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    const currentSession = session;
    if (!current(ctx) || !currentSession) return;
    const actualModel = modelName(ctx);
    if (isWorker) {
      if (!taskId || !taskToken) return;
      if (workerRecord && actualModel === workerRecord.resolved.actualModel && event.level === workerRecord.resolved.actualThinking) return;
      await rpc("quarantineWorkerModel", { input: { taskId, ownershipToken: taskToken, sessionGeneration, actualModel, actualThinking: event.level } });
      ctx.ui.notify("Worker thinking changed. This generation is quarantined; create a new generation after handoff.", "error");
      return;
    }
    const attachment = currentSession.attachment;
    const attached = await rpc<{ attachment: LeadAttachment }>("attach", { input: {
      attachmentId: attachment?.id,
      attachmentOwnershipToken: attachment?.ownershipToken,
      sessionId: currentSession.sessionId,
      sessionFile: ctx.sessionManager.getSessionFile(),
      clientIncarnation: currentSession.clientIncarnation,
      sessionGeneration: currentSession.sessionGeneration,
      pid: process.pid,
      cmux: currentSession.identity,
      model: actualModel,
      thinking: event.level,
      availableModels: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
      featureId,
      featureOwnershipToken: featureToken,
      inherited: { model: actualModel, thinking: event.level },
    } });
    currentSession.attachment = attached.attachment;
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (!isWorker) return;
    ctx.ui.notify("V4 workers cannot /new or /resume in-place because the session ID is generation-fenced. Stop and create a new worker generation.", "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    if (!isWorker) return;
    ctx.ui.notify("V4 workers cannot fork/clone in-place because the session ID is generation-fenced.", "warning");
    return { cancel: true };
  });

  pi.on("session_shutdown", async () => {
    active = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (statusTimer) clearInterval(statusTimer);
    if (digestTimer) clearInterval(digestTimer);
    const captured = session;
    if (!captured) return;
    if (isWorker && taskId && taskToken && captured.processIncarnation) {
      await transport.request("workerExited", { projectRoot: captured.projectRoot, projectName: captured.projectName, input: {
        taskId,
        ownershipToken: taskToken,
        sessionGeneration,
        processIncarnation: captured.processIncarnation,
      } }).catch(() => undefined);
    } else if (captured.attachment) {
      // Detach only. V4 never calls ctx.shutdown for a Lead and never targets
      // this Lead's cmux UUID tuple from any cleanup path.
      await transport.request("detach", { projectRoot: captured.projectRoot, projectName: captured.projectName, attachmentId: captured.attachment.id, ownershipToken: captured.attachment.ownershipToken }).catch(() => undefined);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isDestructiveLinearTool(event.toolName)) return { block: true, reason: "Destructive Linear operations and workspace switching remain outside V4." };
    if (isWorker && isLinearMutationTool(event.toolName)) return { block: true, reason: "V4 workers cannot mutate Linear; report the requested tracking action to the owning Lead." };
    if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
      const input = event.input as { path?: unknown; file_path?: unknown };
      const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
      if (path) {
        const reason = await sensitiveResolvedPathReason(normalizePiToolPath(path, ctx.cwd));
        if (reason) return { block: true, reason };
      }
      if ((workerRole === "review" || workerRole === "research") && (event.toolName === "write" || event.toolName === "edit")) {
        return { block: true, reason: `${workerRole} workers are read-only.` };
      }
    }
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const secretReason = sensitiveCommandReason(command) ?? await sensitiveCommandResolvedPathReason(command, ctx.cwd);
    if (secretReason) return { block: true, reason: secretReason };
    if (workerRole === "review" || workerRole === "research") {
      const reason = readOnlyWorkerCommandReason(command);
      if (reason) return { block: true, reason: `${workerRole} worker bash is read-only: ${reason}.` };
    }
    const risk = classifyBashRisk(command);
    if (!risk) return;
    if (risk === "force-push") return { block: true, reason: riskDescription(risk) };
    if (!ctx.hasUI) return { block: true, reason: `${riskDescription(risk)} No interactive operator is available.` };
    if (!await ctx.ui.confirm("Separate authorization required", `${riskDescription(risk)}\n\n${command}`)) return { block: true, reason: "Operator declined the separate authorization." };
  });

  if (isWorker) {
    pi.registerTool({
      name: "lead_worker_report_v4",
      label: "Report to V4 Supervisor",
      description: "Persist this exact generation's progress, blocker, validation, PR, or review evidence. A terminal report shuts down only this worker Pi process and preserves its surface.",
      promptSnippet: "Report this worker generation to the durable V4 supervisor",
      promptGuidelines: ["Use lead_worker_report_v4 for every meaningful blocker, handoff, validation, PR, or terminal transition."],
      parameters: Type.Object({
        status: Type.Optional(StatusSchema),
        summary: Type.Optional(Type.String()),
        blockedReason: Type.Optional(Type.String()),
        handoff: Type.Optional(Type.String()),
        prUrl: Type.Optional(Type.String()),
        checks: Type.Optional(Type.Array(CheckSchema, { maxItems: 100 })),
        reviewVerdict: Type.Optional(StringEnum(["approved", "changes-requested"] as const)),
        findings: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        acceptance: Type.Optional(Type.Array(AcceptanceSchema, { maxItems: 100 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!taskId || !taskToken) throw new Error("V4 worker identity is unavailable");
        const task = await rpc<WorkerTaskV4>("report", { input: {
          taskId,
          ownershipToken: taskToken,
          sessionGeneration,
          status: params.status,
          summary: params.summary,
          blockedReason: params.blockedReason,
          handoff: params.handoff,
          prUrl: params.prUrl,
          checks: params.checks,
          review: params.reviewVerdict ? { verdict: params.reviewVerdict, findings: params.findings ?? [], acceptance: params.acceptance ?? [] } : undefined,
        } });
        if (["completed", "failed", "stopped"].includes(task.status)) ctx.shutdown();
        return textResult(`V4 supervisor updated: ${task.status}. The worker surface is retained.`, { task });
      },
    });
  } else {
    const attachment = () => {
      if (!session?.attachment) throw new Error("V4 Lead attachment is unavailable");
      return session.attachment;
    };
    pi.registerTool({
      name: "lead_v4_feature",
      label: "Create or Reuse Feature Track",
      description: "Create an independently owned persisted V4 feature track, or reuse the exact canonical issue track. Natural-language lookalikes require an explicit existing/new choice.",
      promptSnippet: "Create or reuse a durable V4 feature track from a plain-language request",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 160 }),
        task: Type.String({ minLength: 1, maxLength: 30_000 }),
        issue: Type.Optional(Type.String()),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(ThinkingSchema),
        existingFeatureId: Type.Optional(Type.String()),
        createSeparateDespitePossibleMatch: Type.Optional(Type.Boolean()),
      }),
      async execute(toolCallId, params) {
        const lead = attachment();
        const feature = await rpc("createFeature", { input: {
          attachmentId: lead.id,
          ownershipToken: lead.ownershipToken,
          clientOperationId: toolCallId,
          title: params.title,
          task: params.task,
          issue: params.issue,
          acceptanceCriteria: params.acceptanceCriteria,
          preset: params.model || params.thinking ? { model: params.model, thinking: params.thinking } : undefined,
          duplicateChoice: params.createSeparateDespitePossibleMatch ? "new" : params.existingFeatureId ? "existing" : undefined,
          existingFeatureId: params.existingFeatureId,
        } });
        const record = feature as { id: string; ownerAttachmentId?: string };
        return textResult(record.ownerAttachmentId === lead.id
          ? `Feature track ${record.id} is ready and owned by this Lead.`
          : `Reused exact feature track ${record.id}; it remains owned by Lead ${record.ownerAttachmentId ?? "(unowned)"}.`, { feature });
      },
    });

    pi.registerTool({
      name: "lead_v4_spawn_lead",
      label: "Spawn Non-Focused Feature Lead",
      description: "Create a named feature track and launch another thin Lead in a separate non-focused cmux workspace. No slash command is required.",
      promptSnippet: "Spawn a non-focused Lead for an independent named feature",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 160 }),
        task: Type.String({ minLength: 1, maxLength: 30_000 }),
        issue: Type.Optional(Type.String()),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(ThinkingSchema),
      }),
      async execute(toolCallId, params) {
        const lead = attachment();
        const feature = await rpc("createFeature", { input: {
          attachmentId: lead.id,
          ownershipToken: lead.ownershipToken,
          clientOperationId: toolCallId,
          title: params.title,
          task: params.task,
          issue: params.issue,
          acceptanceCriteria: params.acceptanceCriteria,
          spawnLead: true,
          leadSelection: params.model || params.thinking ? { model: params.model, thinking: params.thinking } : undefined,
        } });
        return textResult(`Feature Lead ${(feature as { id: string }).id} is durably queued for non-focused launch.`, { feature });
      },
    });

    pi.registerTool({
      name: "lead_v4_worker",
      label: "Create Feature Worker",
      description: "Create or idempotently reuse an implementation, research, or review worker in the dedicated Agents workspace, with explicit persisted provider/model/thinking resolution.",
      promptSnippet: "Create a feature worker with optional exact model and thinking selection",
      parameters: Type.Object({
        featureId: Type.String(),
        role: RoleSchema,
        title: Type.String({ minLength: 1, maxLength: 160 }),
        task: Type.String({ minLength: 1, maxLength: 30_000 }),
        issue: Type.Optional(Type.String()),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        parentTaskId: Type.Optional(Type.String()),
        newReviewGeneration: Type.Optional(Type.Boolean({ description: "After implementation evidence changes, explicitly create a fresh review generation instead of reusing the exact prior review task." })),
        model: Type.Optional(Type.String({ description: "Exact provider/model ID. Unavailable or ambiguous models fail visibly; no fallback." })),
        thinking: Type.Optional(ThinkingSchema),
      }),
      async execute(toolCallId, params) {
        const lead = attachment();
        const task = await rpc<WorkerTaskV4>("createTask", { input: {
          attachmentId: lead.id,
          ownershipToken: lead.ownershipToken,
          clientOperationId: toolCallId,
          featureId: params.featureId,
          role: params.role,
          title: params.title,
          task: params.task,
          issue: params.issue,
          acceptanceCriteria: params.acceptanceCriteria,
          parentTaskId: params.parentTaskId,
          newGeneration: params.newReviewGeneration,
          selection: params.model || params.thinking ? { model: params.model, thinking: params.thinking } : undefined,
        } });
        return textResult(`${task.role} task ${task.id.slice(0, 8)} is ${task.processState}; supervisor scheduling is fair and process-bounded.`, { task });
      },
    });

    pi.registerTool({
      name: "lead_v4_claim_feature",
      label: "Claim Unowned Feature",
      description: "Claim an unowned feature after its prior owner's fenced lease expired. Existing workers remain unchanged.",
      parameters: Type.Object({ featureId: Type.String(), expectedOwnerGeneration: Type.Integer({ minimum: 1 }) }),
      async execute(_toolCallId, params) {
        const lead = attachment();
        const feature = await rpc("claimFeature", { input: { attachmentId: lead.id, ownershipToken: lead.ownershipToken, featureId: params.featureId, expectedOwnerGeneration: params.expectedOwnerGeneration } });
        return textResult(`Claimed feature ${params.featureId}.`, { feature });
      },
    });

    pi.registerTool({
      name: "lead_v4_status",
      label: "V4 Native Status",
      description: "Inspect Leads, feature ownership, fair scheduling, worker processes, models, and retained events without forcing an LLM turn per event.",
      parameters: Type.Object({}),
      async execute() {
        const snapshot = await rpc<V4StatusSnapshot>("status");
        return textResult(summarize(snapshot), { snapshot });
      },
    });

    pi.registerTool({
      name: "lead_v4_inspect",
      label: "Inspect V4 Record",
      description: "Inspect one exact persisted feature or worker record, including ownership and model resolution sources.",
      parameters: Type.Object({ id: Type.String() }),
      async execute(_toolCallId, params) {
        const snapshot = await rpc<V4StatusSnapshot>("status");
        const matches = [...snapshot.features, ...snapshot.tasks].filter((item) => item.id === params.id || item.id.startsWith(params.id));
        if (matches.length !== 1) throw new Error(`Unknown or non-unique V4 record: ${params.id}`);
        const safe = redactPrivate(matches[0]);
        return textResult(JSON.stringify(safe, null, 2), { item: safe });
      },
    });

    pi.registerTool({
      name: "lead_v4_rollback_check",
      label: "Check V4 Rollback Safety",
      description: "Verify the durable supervisor is quiescent enough to disable V4. Refuses while any worker generation is launching, live, UNKNOWN, or quarantined.",
      parameters: Type.Object({}),
      async execute() {
        const result = await rpc<{ safe: true }>("rollbackCheck");
        return textResult("V4 is quiescent; after all Lead clients detach, a fresh Pi process may be started without PI_LEAD_V4 to use V2.", result);
      },
    });

    pi.registerTool({
      name: "lead_v4_stop",
      label: "Stop Exact Worker Process",
      description: "Request graceful shutdown of one exact worker generation. The worker surface is preserved; Lead attachments can never be targeted.",
      parameters: Type.Object({ taskId: Type.String(), reason: Type.Optional(Type.String()) }),
      async execute(_toolCallId, params) {
        const lead = attachment();
        const task = await rpc<WorkerTaskV4>("stopTask", { input: { attachmentId: lead.id, ownershipToken: lead.ownershipToken, taskId: params.taskId, reason: params.reason ?? "Owning Lead requested a graceful stop" } });
        return textResult(`Stop requested for worker ${task.id}. Its surface remains retained.`, { task });
      },
    });
  }

  pi.registerCommand("workers", {
    description: "Compatibility diagnostic only: show V4 native status; use plain-language lead_v4_* tools for actions",
    handler: async (_args, ctx) => {
      if (!session) return;
      const snapshot = await rpc<V4StatusSnapshot>("status");
      ctx.ui.notify(summarize(snapshot), "info");
    },
  });

  pi.registerCommand("lead-v4-doctor", {
    description: "Diagnose the private V4 supervisor transport and rollback safety",
    handler: async (_args, ctx) => {
      if (!session) return;
      const handshake = await transport.ensure();
      const snapshot = await rpc<V4StatusSnapshot>("status");
      ctx.ui.notify(`V4 supervisor PID ${handshake.pid} · epoch ${handshake.epoch.slice(0, 8)} · generation ${snapshot.supervisorGeneration}\nState: ${defaultV4StateDir(process.env)}\nSocket: ${transport.socketPath}\nAutomatic worker retirement: ${snapshot.config.automaticWorkerSurfaceRetirement ? "ON" : "off"}`, "info");
    },
  });
}
