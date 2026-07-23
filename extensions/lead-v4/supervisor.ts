import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { resolveModelSelection, attestActualModel } from "./model.ts";
import { activeLeadProcessCount, fairLeadLaunches, fairWorkerLaunches } from "./scheduler.ts";
import type { V4Store } from "./store.ts";
import { assertStableUuid } from "./topology.ts";
import type {
  DigestBatch,
  FeatureTrack,
  LeadAttachment,
  ModelSelection,
  StableCmuxIdentity,
  SupervisorEvent,
  V4ProjectState,
  V4StatusSnapshot,
  V4TaskStatus,
  V4ThinkingLevel,
  V4WorkerRole,
  WorkerTaskV4,
} from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

function token(): string {
  return randomBytes(32).toString("hex");
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function issueKey(value: string | undefined): string | undefined {
  const direct = value?.trim().match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/)?.[1];
  const url = value?.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$|[?#])/i)?.[1];
  return (direct ?? url)?.toUpperCase();
}

function slug(value: string): string {
  return normalizedTitle(value).replaceAll(" ", "-").slice(0, 42) || "feature";
}

function sameIdentity(left: StableCmuxIdentity, right: StableCmuxIdentity): boolean {
  return left.windowUuid === right.windowUuid
    && left.workspaceUuid === right.workspaceUuid
    && left.paneUuid === right.paneUuid
    && left.surfaceUuid === right.surfaceUuid;
}

function assertIdentity(identity: StableCmuxIdentity): void {
  assertStableUuid(identity.windowUuid, "windowUuid");
  assertStableUuid(identity.workspaceUuid, "workspaceUuid");
  assertStableUuid(identity.paneUuid, "paneUuid");
  assertStableUuid(identity.surfaceUuid, "surfaceUuid");
}

function roleProjectSelection(state: V4ProjectState, role: "lead" | V4WorkerRole): ModelSelection {
  return { ...state.config.project, ...state.config.roles?.[role] };
}

function validationHash(task: WorkerTaskV4): string {
  return createHash("sha256").update(JSON.stringify((task.checks ?? [])
    .map((check) => ({ name: check.name.trim(), status: check.status }))
    .sort((left, right) => left.name.localeCompare(right.name)))).digest("hex");
}

function operationKey(attachmentId: string, clientOperationId: string): string {
  return `${attachmentId}:${clientOperationId}`;
}

function appendEvent(
  state: V4ProjectState,
  event: Omit<SupervisorEvent, "id" | "sequence" | "createdAt">,
): V4ProjectState {
  const created: SupervisorEvent = {
    ...event,
    id: randomUUID(),
    sequence: state.nextEventSequence,
    createdAt: now(),
  };
  return { ...state, events: [...state.events, created], nextEventSequence: state.nextEventSequence + 1 };
}

export interface AttachInput {
  attachmentId?: string;
  attachmentOwnershipToken?: string;
  sessionId: string;
  sessionFile?: string;
  clientIncarnation: string;
  sessionGeneration: number;
  pid: number;
  cmux: StableCmuxIdentity;
  model: string;
  thinking: V4ThinkingLevel;
  availableModels: string[];
  featureId?: string;
  featureOwnershipToken?: string;
  featureLaunchGeneration?: number;
  inherited?: ModelSelection;
}

export interface CreateFeatureInput {
  attachmentId: string;
  ownershipToken: string;
  clientOperationId: string;
  title: string;
  task: string;
  issue?: string;
  acceptanceCriteria?: string[];
  preset?: ModelSelection;
  spawnLead?: boolean;
  duplicateChoice?: "new" | "existing";
  existingFeatureId?: string;
  leadSelection?: ModelSelection;
}

export interface CreateTaskInput {
  attachmentId: string;
  ownershipToken: string;
  clientOperationId: string;
  featureId: string;
  role: V4WorkerRole;
  title: string;
  task: string;
  issue?: string;
  acceptanceCriteria?: string[];
  parentTaskId?: string;
  selection?: ModelSelection;
  newGeneration?: boolean;
}

export class V4SupervisorCore {
  constructor(private readonly store: V4Store, private readonly worktreeRoot = store.root) {}

  async attach(input: AttachInput): Promise<{ attachment: LeadAttachment; snapshot: V4StatusSnapshot }> {
    assertIdentity(input.cmux);
    if (!input.sessionId || !input.clientIncarnation) throw new Error("Lead identity requires Pi session ID and client incarnation");
    let attached!: LeadAttachment;
    const state = await this.store.update((current) => {
      const selected = resolveModelSelection({
        explicit: { model: input.model, thinking: input.thinking },
        inheritedLead: input.inherited,
        availableModels: input.availableModels,
      });
      selected.actualModel = input.model;
      selected.actualThinking = input.thinking;
      const id = input.attachmentId ?? randomUUID();
      const previous = current.attachments[id];
      if (previous && (previous.ownershipToken !== input.attachmentOwnershipToken || previous.sessionId !== input.sessionId)) {
        throw new Error("Attachment ID is fenced to another token or Pi session");
      }
      const spawnedFeature = input.featureId ? current.features[input.featureId] : undefined;
      let replacesUnattachedLaunch = false;
      if (input.featureId) {
        if (!spawnedFeature) throw new Error(`Unknown spawned Lead feature ${input.featureId}`);
        if (spawnedFeature.ownershipToken !== input.featureOwnershipToken
          || spawnedFeature.leadLaunchGeneration !== input.featureLaunchGeneration) {
          throw new Error("Spawned Lead feature token/generation is stale");
        }
        const priorOwner = spawnedFeature.ownerAttachmentId ? current.attachments[spawnedFeature.ownerAttachmentId] : undefined;
        if (priorOwner?.state === "attached" && spawnedFeature.ownerAttachmentId !== id) {
          throw new Error(`Feature is already attached to Lead ${priorOwner.id}`);
        }
        const attachableLaunch = spawnedFeature.leadLaunchState === "launching" || spawnedFeature.leadLaunchState === "launched";
        const detachedReload = spawnedFeature.leadLaunchState === "attached" && priorOwner?.state !== "attached";
        if (!attachableLaunch && !detachedReload && spawnedFeature.ownerAttachmentId !== id) {
          throw new Error("Spawned Lead launch is no longer attachable");
        }
        replacesUnattachedLaunch = attachableLaunch && !spawnedFeature.ownerAttachmentId;
      }
      const addsAttachedProcess = previous?.state !== "attached";
      if (addsAttachedProcess
        && !replacesUnattachedLaunch
        && activeLeadProcessCount(current) >= current.config.maxConcurrentLeads) {
        throw new Error(`V4 Lead capacity is full (${current.config.maxConcurrentLeads}); attachment refused`);
      }
      attached = {
        id,
        ownershipToken: previous?.ownershipToken ?? token(),
        sessionGeneration: input.sessionGeneration,
        sessionId: input.sessionId,
        sessionFile: input.sessionFile,
        pid: input.pid,
        attachedAt: previous?.attachedAt ?? now(),
        lastSeenAt: now(),
        state: "attached",
        featureId: input.featureId,
        cmux: input.cmux,
        selected,
        availableModels: [...new Set(input.availableModels)].sort(),
        inherited: input.inherited,
      };
      const attachments = { ...current.attachments, [id]: attached };
      let features = current.features;
      if (spawnedFeature) {
        const priorOwner = spawnedFeature.ownerAttachmentId ? current.attachments[spawnedFeature.ownerAttachmentId] : undefined;
        if (!spawnedFeature.ownerAttachmentId || spawnedFeature.ownerAttachmentId === id || priorOwner?.state === "detached" || priorOwner?.state === "dead") {
          features = {
            ...features,
            [spawnedFeature.id]: {
              ...spawnedFeature,
              ownerAttachmentId: id,
              ownerAssignedAt: now(),
              ownerGeneration: spawnedFeature.ownerGeneration + Number(spawnedFeature.ownerAttachmentId !== id),
              leadLaunchState: "attached",
              leadProcessPid: input.pid,
              leadCmux: input.cmux,
              updatedAt: now(),
            },
          };
        }
      } else {
        // /reload preserves the Pi session ID but creates a fresh extension
        // incarnation. Transfer only tracks whose old attachment already
        // detached and has that exact session ID; /new and unrelated Leads do
        // not inherit ownership.
        for (const feature of Object.values(features)) {
          const priorOwner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : undefined;
          if (priorOwner?.state !== "detached" || priorOwner.sessionId !== input.sessionId) continue;
          features = {
            ...features,
            [feature.id]: { ...feature, ownerAttachmentId: id, ownerGeneration: feature.ownerGeneration + 1, ownerAssignedAt: now(), leadCmux: input.cmux, updatedAt: now() },
          };
        }
      }
      return { ...current, attachments, features };
    });
    return { attachment: attached, snapshot: this.snapshot(state) };
  }

  async heartbeat(input: {
    attachmentId: string;
    ownershipToken: string;
    sessionId: string;
    sessionGeneration: number;
    cmux: StableCmuxIdentity;
  }): Promise<void> {
    assertIdentity(input.cmux);
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      if (attachment.sessionId !== input.sessionId
        || attachment.sessionGeneration !== input.sessionGeneration
        || !sameIdentity(attachment.cmux, input.cmux)) {
        throw new Error("Lead heartbeat identity mismatch; stale or replaced Pi session is fenced");
      }
      return {
        ...current,
        attachments: {
          ...current.attachments,
          [attachment.id]: { ...attachment, lastSeenAt: now(), state: "attached", detachedAt: undefined },
        },
      };
    });
  }

  async detach(attachmentId: string, ownershipToken: string): Promise<void> {
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, attachmentId, ownershipToken);
      return {
        ...current,
        attachments: {
          ...current.attachments,
          [attachment.id]: { ...attachment, state: "detached", detachedAt: now(), lastSeenAt: now() },
        },
      };
    });
  }

  async createFeature(input: CreateFeatureInput): Promise<FeatureTrack> {
    let result!: FeatureTrack;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const opKey = operationKey(attachment.id, input.clientOperationId);
      const prior = current.operations[opKey];
      if (prior) {
        const existing = current.features[prior.resultId];
        if (!existing || prior.kind !== "feature") throw new Error("Idempotency operation record is inconsistent");
        result = existing;
        return current;
      }
      const canonicalIssue = issueKey(input.issue);
      const exact = Object.values(current.features).find((feature) => canonicalIssue && feature.key === `issue:${canonicalIssue}`);
      if (exact) {
        result = exact;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: exact.id, createdAt: now() } },
        };
      }
      if (input.existingFeatureId) {
        const existing = current.features[input.existingFeatureId];
        if (!existing) throw new Error(`Unknown existing feature ${input.existingFeatureId}`);
        result = existing;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: existing.id, createdAt: now() } },
        };
      }
      if (!canonicalIssue) {
        const possible = Object.values(current.features).filter((feature) => normalizedTitle(feature.title) === normalizedTitle(input.title));
        if (possible.length > 0 && input.duplicateChoice !== "new") {
          throw new Error(`Possible existing feature track(s): ${possible.map((feature) => `${feature.id}:${feature.title}`).join(", ")}. Natural-language goals are not auto-deduplicated; choose existingFeatureId or duplicateChoice=new.`);
        }
      }
      const id = randomUUID();
      const inheritedSelection = {
        model: attachment.selected.actualModel ?? attachment.selected.model.value,
        thinking: attachment.selected.actualThinking ?? attachment.selected.thinking.value,
      };
      const leadResolution = resolveModelSelection({
        explicit: input.leadSelection,
        spawningLead: inheritedSelection,
        featurePreset: input.preset,
        roleProject: roleProjectSelection(current, "lead"),
        inheritedLead: attachment.inherited ?? inheritedSelection,
        availableModels: attachment.availableModels,
      });
      const at = now();
      result = {
        id,
        key: canonicalIssue ? `issue:${canonicalIssue}` : `goal:${id}`,
        title: input.title.trim(),
        task: input.task.trim(),
        issue: input.issue?.trim(),
        acceptanceCriteria: [...new Set((input.acceptanceCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean))].slice(0, 100),
        ownershipToken: token(),
        ownerAttachmentId: input.spawnLead ? undefined : attachment.id,
        ownerGeneration: 1,
        ownerAssignedAt: input.spawnLead ? undefined : at,
        preset: input.preset,
        leadResolution,
        leadLaunchState: input.spawnLead ? "queued" : "attached",
        leadLaunchGeneration: input.spawnLead ? 1 : 0,
        leadCmux: input.spawnLead ? undefined : attachment.cmux,
        taskIds: [],
        eventCursors: {},
        schedulerSequence: Object.keys(current.features).length + 1,
        createdAt: at,
        updatedAt: at,
      };
      let next: V4ProjectState = {
        ...current,
        features: { ...current.features, [id]: result },
        operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: id, createdAt: at } },
      };
      next = appendEvent(next, { featureId: id, kind: "ownership", actionable: false, summary: `Feature track created${input.spawnLead ? "; non-focused Lead queued" : ` and owned by Lead ${attachment.id.slice(0, 8)}`}` });
      return next;
    });
    return result;
  }

  async claimFeature(input: { attachmentId: string; ownershipToken: string; featureId: string; expectedOwnerGeneration: number }): Promise<FeatureTrack> {
    let claimed!: FeatureTrack;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const feature = current.features[input.featureId];
      if (!feature) throw new Error(`Unknown feature ${input.featureId}`);
      if (feature.ownerGeneration !== input.expectedOwnerGeneration) throw new Error("Feature owner generation changed; refresh before failover");
      const owner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : undefined;
      if (owner?.state === "attached" && Date.now() - Date.parse(owner.lastSeenAt) <= current.config.attachmentLeaseSeconds * 1_000) {
        throw new Error(`Feature is still owned by attached Lead ${owner.id}`);
      }
      claimed = { ...feature, ownerAttachmentId: attachment.id, ownerGeneration: feature.ownerGeneration + 1, ownerAssignedAt: now(), leadLaunchState: "attached", leadCmux: attachment.cmux, updatedAt: now() };
      return appendEvent({ ...current, features: { ...current.features, [feature.id]: claimed } }, {
        featureId: feature.id,
        kind: "ownership",
        actionable: true,
        summary: `Feature ownership failed over to Lead ${attachment.id.slice(0, 8)} at generation ${claimed.ownerGeneration}`,
      });
    });
    return claimed;
  }

  async createTask(input: CreateTaskInput): Promise<WorkerTaskV4> {
    let result!: WorkerTaskV4;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const feature = current.features[input.featureId];
      if (!feature) throw new Error(`Unknown feature ${input.featureId}`);
      if (feature.ownerAttachmentId !== attachment.id) throw new Error("Only the fenced owning Lead can initiate work for this feature");
      const opKey = operationKey(attachment.id, input.clientOperationId);
      const prior = current.operations[opKey];
      if (prior) {
        const existing = current.tasks[prior.resultId];
        if (!existing || prior.kind !== "task") throw new Error("Idempotency operation record is inconsistent");
        result = existing;
        return current;
      }
      const parent = input.parentTaskId ? current.tasks[input.parentTaskId] : undefined;
      if (input.role === "review" && !parent) throw new Error("Review tasks require an exact parentTaskId in the same feature");
      if (parent && parent.featureId !== feature.id) throw new Error("Review parent belongs to another feature track");
      if (input.newGeneration && input.role !== "review") throw new Error("Only review tasks may request an explicit new generation");
      const canonicalIssue = issueKey(input.issue ?? feature.issue);
      const baseUniqueKey = `${feature.id}:${input.role}:${input.parentTaskId ?? canonicalIssue ?? normalizedTitle(input.title)}`;
      const uniqueKey = input.newGeneration ? `${baseUniqueKey}:generation:${input.clientOperationId}` : baseUniqueKey;
      const duplicate = Object.values(current.tasks).find((task) => task.uniqueKey === uniqueKey);
      if (duplicate) {
        result = duplicate;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "task", resultId: duplicate.id, createdAt: now() } },
        };
      }
      const inheritedSelection = {
        model: attachment.selected.actualModel ?? attachment.selected.model.value,
        thinking: attachment.selected.actualThinking ?? attachment.selected.thinking.value,
      };
      const resolved = resolveModelSelection({
        explicit: input.selection,
        // The attachment invoking this operation is the actual spawning Lead,
        // including a root Lead that directly owns the feature.
        spawningLead: inheritedSelection,
        featurePreset: feature.preset,
        roleProject: roleProjectSelection(current, input.role),
        inheritedLead: attachment.inherited ?? inheritedSelection,
        availableModels: attachment.availableModels,
      });
      const id = randomUUID();
      const at = now();
      const worktreePath = input.role === "review"
        ? parent!.worktreePath
        : input.role === "research"
          ? current.projectRoot
          : join(this.worktreeRoot, "worktrees", current.projectId, id);
      result = {
        id,
        featureId: feature.id,
        uniqueKey,
        role: input.role,
        parentTaskId: parent?.id,
        title: input.title.trim(),
        task: input.task.trim(),
        issue: input.issue?.trim() || feature.issue,
        acceptanceCriteria: [...new Set((input.acceptanceCriteria ?? feature.acceptanceCriteria).map((criterion) => criterion.trim()).filter(Boolean))].slice(0, 100),
        status: "queued",
        processState: "queued",
        baseBranch: parent?.baseBranch,
        baseSha: parent?.baseSha,
        branchName: parent?.branchName ?? (input.role === "implementation" ? `pi/${slug(input.title)}-${id.slice(0, 8)}` : undefined),
        worktreePath,
        sessionId: id,
        resolved,
        runtime: { ownershipToken: token(), sessionGeneration: 1 },
        createdAt: at,
        updatedAt: at,
      };
      const updatedFeature = { ...feature, taskIds: [...feature.taskIds, id], updatedAt: at };
      let next: V4ProjectState = {
        ...current,
        features: { ...current.features, [feature.id]: updatedFeature },
        tasks: { ...current.tasks, [id]: result },
        operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "task", resultId: id, createdAt: at } },
      };
      next = appendEvent(next, { featureId: feature.id, taskId: id, kind: "telemetry", actionable: false, summary: `${input.role} task queued with model ${resolved.requestedModel}/${resolved.requestedThinking}` });
      return next;
    });
    return result;
  }

  async workerHello(input: {
    taskId: string;
    ownershipToken: string;
    sessionGeneration: number;
    sessionId: string;
    processIncarnation: string;
    pid: number;
    cmux: StableCmuxIdentity;
    actualModel: string;
    actualThinking: V4ThinkingLevel;
  }): Promise<WorkerTaskV4> {
    assertIdentity(input.cmux);
    let result!: WorkerTaskV4;
    let mismatch: string | undefined;
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown V4 worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken
        || task.runtime.sessionGeneration !== input.sessionGeneration
        || task.sessionId !== input.sessionId
        || task.status !== "starting"
        || task.processState !== "launching") {
        throw new Error("Worker hello failed launch/generation/token/session fencing; generation is quarantined");
      }
      if (task.cmux && !sameIdentity(task.cmux, input.cmux)) {
        mismatch = "Worker hello cmux UUID tuple differs from the persisted launch result";
      }
      let resolved = task.resolved;
      if (!mismatch) {
        try {
          resolved = attestActualModel(task.resolved, input.actualModel, input.actualThinking);
        } catch (error) {
          mismatch = error instanceof Error ? error.message : String(error);
        }
      }
      if (mismatch) {
        result = {
          ...task,
          status: "blocked",
          processState: "quarantined",
          blockedReason: `${mismatch}; generation is quarantined`,
          resolved: { ...task.resolved, actualModel: input.actualModel, actualThinking: input.actualThinking },
          runtime: { ...task.runtime, pid: input.pid, processIncarnation: input.processIncarnation, lastHeartbeatAt: now() },
          updatedAt: now(),
        };
        return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: result } }, {
          featureId: task.featureId,
          taskId: task.id,
          kind: "runtime",
          actionable: true,
          summary: result.blockedReason!,
        });
      }
      result = {
        ...task,
        cmux: input.cmux,
        resolved,
        status: "running",
        processState: "running",
        runtime: { ...task.runtime, pid: input.pid, processIncarnation: input.processIncarnation, lastHeartbeatAt: now() },
        updatedAt: now(),
      };
      return { ...current, tasks: { ...current.tasks, [task.id]: result } };
    });
    if (mismatch) throw new Error(result.blockedReason);
    return result;
  }

  async workerAgentStart(input: { taskId: string; ownershipToken: string; sessionGeneration: number }): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker agent-start failed ownership fencing");
      }
      return {
        ...current,
        tasks: {
          ...current.tasks,
          [task.id]: { ...task, runtime: { ...task.runtime, reportBaselineAt: task.runtime.lastReportAt } },
        },
      };
    });
  }

  async workerHeartbeat(input: {
    taskId: string;
    ownershipToken: string;
    sessionGeneration: number;
    sessionId: string;
    processIncarnation: string;
    pid: number;
    cmux: StableCmuxIdentity;
  }): Promise<void> {
    assertIdentity(input.cmux);
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken
        || task.runtime.sessionGeneration !== input.sessionGeneration
        || task.sessionId !== input.sessionId
        || task.runtime.processIncarnation !== input.processIncarnation
        || task.runtime.pid !== input.pid
        || !task.cmux
        || !sameIdentity(task.cmux, input.cmux)) {
        throw new Error("Worker heartbeat attestation mismatch; liveness is UNKNOWN and replacement is forbidden");
      }
      return {
        ...current,
        tasks: { ...current.tasks, [task.id]: { ...task, runtime: { ...task.runtime, lastHeartbeatAt: now() } } },
      };
    });
  }

  async quarantineWorkerModel(input: {
    taskId: string;
    ownershipToken: string;
    sessionGeneration: number;
    actualModel: string;
    actualThinking: V4ThinkingLevel;
  }): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker model-change quarantine failed ownership fencing");
      }
      const updated = {
        ...task,
        processState: "quarantined" as const,
        status: "blocked" as const,
        blockedReason: `Worker model/thinking changed to ${input.actualModel}/${input.actualThinking}; start a visible new worker generation with a durable handoff`,
        resolved: { ...task.resolved, actualModel: input.actualModel, actualThinking: input.actualThinking },
        updatedAt: now(),
      };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: updated } }, {
        featureId: task.featureId,
        taskId: task.id,
        kind: "runtime",
        actionable: true,
        summary: updated.blockedReason,
      });
    });
  }

  async report(input: {
    taskId: string;
    ownershipToken: string;
    sessionGeneration: number;
    status?: V4TaskStatus;
    summary?: string;
    blockedReason?: string;
    handoff?: string;
    prUrl?: string;
    checks?: WorkerTaskV4["checks"];
    review?: WorkerTaskV4["review"];
  }): Promise<WorkerTaskV4> {
    let result!: WorkerTaskV4;
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker report failed ownership fencing");
      }
      if (input.status === "blocked" && !input.blockedReason?.trim()) throw new Error("blocked reports require blockedReason");
      if (input.status === "pr-ready-ci-green" || input.status === "merged") throw new Error(`${input.status} is supervisor-observed, not worker-reported`);
      if (input.review) {
        if (task.role !== "review" || !task.parentTaskId || !task.reviewTarget) throw new Error("Only a review worker with a captured target may report a verdict");
        const parent = current.tasks[task.parentTaskId];
        if (!parent) throw new Error("Review parent is missing");
        const rows = input.review.acceptance;
        const missing = parent.acceptanceCriteria.filter((criterion) => !rows.some((row) => normalizedTitle(row.criterion) === normalizedTitle(criterion)));
        if (missing.length > 0) throw new Error(`Review acceptance matrix is missing: ${missing.join("; ")}`);
        if (rows.some((row) => !row.evidence.trim())) throw new Error("Every review acceptance row requires concrete evidence");
        if (input.review.verdict === "approved" && rows.some((row) => row.status !== "met")) throw new Error("Approved reviews require every acceptance criterion to be met");
        if (input.review.verdict === "approved" && (!(parent.checks ?? []).some((check) => check.status === "passed")
          || (parent.checks ?? []).some((check) => check.status === "failed" || check.status === "pending"))) {
          throw new Error("Approved reviews require complete non-failing validation with at least one passing check");
        }
        if (input.review.diffHash !== task.reviewTarget.diffHash
          || input.review.headSha !== task.reviewTarget.headSha
          || input.review.checksHash !== task.reviewTarget.checksHash
          || input.review.checksHash !== validationHash(parent)) {
          throw new Error("Review verdict is not bound to the captured diff/HEAD/check evidence");
        }
      }
      const reportedAt = now();
      const status = input.status ?? (input.review ? "completed" : task.status);
      const terminal = ["completed", "failed", "stopped", "merged"].includes(status);
      result = {
        ...task,
        status,
        processState: task.processState,
        blockedReason: status === "blocked" ? input.blockedReason?.trim() : undefined,
        summary: input.summary?.trim() || task.summary,
        handoff: input.handoff?.trim() || task.handoff,
        prUrl: input.prUrl?.trim() || task.prUrl,
        checks: input.checks ?? task.checks,
        review: input.review ?? task.review,
        runtime: {
          ...task.runtime,
          lastReportAt: reportedAt,
          // V2.1 hotfix: reportBaselineAt belongs to agent-start and must not
          // be overwritten here. A valid running/blocked report therefore
          // suppresses the reportless-settle nudge for that run.
          terminalAt: terminal ? task.runtime.terminalAt ?? reportedAt : task.runtime.terminalAt,
        },
        updatedAt: reportedAt,
      };
      let tasks = { ...current.tasks, [task.id]: result };
      if (input.review && task.parentTaskId) {
        const parent = current.tasks[task.parentTaskId];
        tasks = {
          ...tasks,
          [parent.id]: {
            ...parent,
            review: input.review,
            status: input.review.verdict === "changes-requested" ? "blocked" : parent.status,
            blockedReason: input.review.verdict === "changes-requested" ? `Review requested changes: ${input.review.findings.join("; ")}` : parent.blockedReason,
            updatedAt: reportedAt,
          },
        };
      }
      let next: V4ProjectState = { ...current, tasks };
      const actionable = status === "blocked" || status === "failed" || input.review?.verdict === "changes-requested";
      next = appendEvent(next, {
        featureId: task.featureId,
        taskId: task.id,
        kind: input.review ? "review" : actionable ? "status" : "telemetry",
        actionable,
        summary: `${task.role} ${task.id.slice(0, 8)}: ${status}${input.blockedReason ? ` — ${input.blockedReason}` : input.summary ? ` — ${input.summary}` : ""}`,
      });
      return next;
    });
    return result;
  }

  async recordPullRequestObservation(input: {
    taskId: string;
    status: "pr-ready-ci-pending" | "pr-ready-ci-green" | "blocked" | "merged";
    checks: WorkerTaskV4["checks"];
    summary: string;
    actionable: boolean;
  }): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.role !== "implementation" || !task.prUrl) return current;
      const nextBlockedReason = input.status === "blocked" ? input.summary : undefined;
      if (task.pullRequestChecks !== undefined
        && task.status === input.status
        && JSON.stringify(task.pullRequestChecks) === JSON.stringify(input.checks ?? [])
        && task.pullRequestSummary === input.summary
        && task.blockedReason === nextBlockedReason) return current;
      const updated = {
        ...task,
        status: input.status,
        pullRequestChecks: input.checks,
        pullRequestSummary: input.summary,
        blockedReason: nextBlockedReason,
        updatedAt: now(),
      };
      const duplicate = current.events.some((event) => !event.observedAt && event.taskId === task.id && event.summary === input.summary);
      const next = { ...current, tasks: { ...current.tasks, [task.id]: updated } };
      return duplicate ? next : appendEvent(next, {
        featureId: task.featureId,
        taskId: task.id,
        kind: input.actionable ? "status" : "telemetry",
        actionable: input.actionable,
        summary: input.summary,
      });
    });
  }

  async claimDigest(input: { attachmentId: string; ownershipToken: string; includeTelemetry?: boolean }): Promise<DigestBatch | undefined> {
    let batch: DigestBatch | undefined;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const owned = new Set(Object.values(current.features).filter((feature) => feature.ownerAttachmentId === attachment.id).map((feature) => feature.id));
      const existingClaim = current.events.filter((event) => !event.observedAt && event.claim?.attachmentId === attachment.id);
      const existingIds = new Set(existingClaim.map((event) => event.id));
      const newlyOwned = current.events.filter((event) => {
        if (existingIds.has(event.id) || event.observedAt || !owned.has(event.featureId)) return false;
        if (!input.includeTelemetry && !event.actionable) return false;
        if (!event.claim) return true;
        return Date.now() - Date.parse(event.claim.claimedAt) > 30_000;
      });
      // A replacement claim may add ownership while this attachment already has
      // an in-flight batch. Extend that same batch instead of delaying telemetry
      // until a later acknowledgement/session callback.
      const candidates = [...existingClaim, ...newlyOwned];
      if (candidates.length === 0) return current;
      const batchId = existingClaim[0]?.claim?.batchId ?? randomUUID();
      const claimedAt = now();
      const ids = new Set(candidates.map((event) => event.id));
      const events = current.events.map((event) => ids.has(event.id)
        ? { ...event, claim: { batchId, attachmentId: attachment.id, claimedAt } }
        : event);
      const limit = current.config.digestLimit;
      const visible = candidates.slice(0, limit);
      const omitted = candidates.length - visible.length;
      const lines = visible.map((event) => {
        const summary = event.summary.length <= 2_000 ? event.summary : `${event.summary.slice(0, 2_000)}…`;
        return `- [${event.kind}] ${summary}`;
      });
      if (omitted > 0) lines.push(`- … ${omitted} more event(s) retained in this same claimed batch`);
      batch = {
        id: batchId,
        attachmentId: attachment.id,
        eventIds: candidates.map((event) => event.id),
        actionable: candidates.some((event) => event.actionable),
        content: [`# V4 supervisor digest (${candidates.length} event${candidates.length === 1 ? "" : "s"})`, ...lines].join("\n"),
        truncated: omitted > 0,
        createdAt: claimedAt,
      };
      return { ...current, events };
    });
    return batch;
  }

  async acknowledgeDigest(input: { attachmentId: string; ownershipToken: string; batchId: string; eventIds: string[] }): Promise<void> {
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const ids = new Set(input.eventIds);
      const observedAt = now();
      const acknowledged = current.events.filter((event) => ids.has(event.id)
        && event.claim?.batchId === input.batchId
        && event.claim.attachmentId === attachment.id);
      const features = { ...current.features };
      for (const event of acknowledged) {
        const feature = features[event.featureId];
        if (!feature) continue;
        features[event.featureId] = {
          ...feature,
          eventCursors: {
            ...(feature.eventCursors ?? {}),
            [attachment.id]: Math.max(feature.eventCursors?.[attachment.id] ?? 0, event.sequence),
          },
        };
      }
      return {
        ...current,
        features,
        events: current.events.map((event) => ids.has(event.id)
          && event.claim?.batchId === input.batchId
          && event.claim.attachmentId === attachment.id
          ? { ...event, observedAt, observedBy: attachment.id, claim: undefined }
          : event),
      };
    });
  }

  async workerExited(input: { taskId: string; ownershipToken: string; sessionGeneration: number; processIncarnation: string }): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration || task.runtime.processIncarnation !== input.processIncarnation) {
        throw new Error("Worker exit failed process-incarnation fencing");
      }
      return {
        ...current,
        tasks: {
          ...current.tasks,
          [task.id]: { ...task, processState: "offline", runtime: { ...task.runtime, terminalAt: task.runtime.terminalAt ?? now() }, updatedAt: now() },
        },
      };
    });
  }

  async stopTask(input: { attachmentId: string; ownershipToken: string; taskId: string; reason: string }): Promise<WorkerTaskV4> {
    let stopped!: WorkerTaskV4;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown task ${input.taskId}`);
      const feature = current.features[task.featureId];
      if (feature?.ownerAttachmentId !== attachment.id) throw new Error("Only the feature owner may stop its worker");
      if (task.status === "stopped") {
        stopped = task;
        return current;
      }
      const cancelLaunch = task.processState === "queued" || task.processState === "launching";
      stopped = {
        ...task,
        status: "stopped",
        processState: cancelLaunch ? "stopped" : task.processState,
        summary: input.reason,
        runtime: cancelLaunch
          ? { ...task.runtime, ownershipToken: token(), sessionGeneration: task.runtime.sessionGeneration + 1, terminalAt: now() }
          : { ...task.runtime, terminalAt: now() },
        updatedAt: now(),
      };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: stopped } }, {
        featureId: task.featureId,
        taskId: task.id,
        kind: "telemetry",
        actionable: false,
        summary: cancelLaunch
          ? `Stop atomically cancelled the queued/launching generation for ${task.id.slice(0, 8)}; surface retention remains enabled`
          : `Stop requested for ${task.id.slice(0, 8)}; surface retention remains enabled`,
      });
    });
    return stopped;
  }

  async tick(): Promise<{ leads: FeatureTrack[]; workers: WorkerTaskV4[] }> {
    let leads: FeatureTrack[] = [];
    let workers: WorkerTaskV4[] = [];
    await this.store.update((current) => {
      const cutoff = Date.now() - current.config.attachmentLeaseSeconds * 1_000;
      let attachments = current.attachments;
      for (const attachment of Object.values(current.attachments)) {
        if (attachment.state === "attached" && Date.parse(attachment.lastSeenAt) < cutoff) {
          attachments = { ...attachments, [attachment.id]: { ...attachment, state: "dead", detachedAt: now() } };
        }
      }
      let next = {
        ...current,
        attachments,
        // A Lead killed at the claim/ack boundary releases its lease only after
        // attachment expiry. The next owner may then receive the same batch,
        // which is deliberate at-least-once delivery.
        events: current.events.map((event) => event.claim && attachments[event.claim.attachmentId]?.state !== "attached"
          ? { ...event, claim: undefined }
          : event),
      };
      for (const feature of Object.values(next.features)) {
        if (!feature.ownerAttachmentId) continue;
        const owner = attachments[feature.ownerAttachmentId];
        if (owner?.state === "attached") continue;
        const already = next.events.some((event) => event.kind === "ownership" && !event.observedAt && event.summary.includes(`generation ${feature.ownerGeneration}`));
        next = {
          ...next,
          features: { ...next.features, [feature.id]: { ...feature, ownerAttachmentId: undefined, leadLaunchState: "unowned", updatedAt: now() } },
        };
        if (!already) next = appendEvent(next, { featureId: feature.id, kind: "ownership", actionable: true, summary: `Feature owner lease expired at generation ${feature.ownerGeneration}; workers remain unchanged and a replacement Lead may claim it` });
      }
      leads = fairLeadLaunches(next);
      workers = fairWorkerLaunches(next);
      // Persist launch intents before any irreversible cmux operation. Runtime
      // adapters must record exact UUID results before sending launch text.
      const features = { ...next.features };
      leads = leads.map((feature) => ({ ...feature, leadLaunchState: "launching" as const, leadLaunchStartedAt: now(), leadProcessPid: undefined, leadCmux: undefined, updatedAt: now() }));
      for (const feature of leads) features[feature.id] = feature;
      const tasks = { ...next.tasks };
      for (const task of workers) tasks[task.id] = { ...task, status: "starting", processState: "launching", updatedAt: now() };
      return { ...next, features, tasks, schedulerCursor: workers.at(-1)?.featureId ?? next.schedulerCursor };
    });
    return { leads, workers };
  }

  async recordAgentsWorkspace(workspace: V4ProjectState["agentsWorkspace"]): Promise<void> {
    if (!workspace) throw new Error("Agents workspace identity is required");
    assertStableUuid(workspace.windowUuid, "agents windowUuid");
    assertStableUuid(workspace.workspaceUuid, "agents workspaceUuid");
    if (workspace.paneUuid) assertStableUuid(workspace.paneUuid, "agents paneUuid");
    await this.store.update((current) => ({ ...current, agentsWorkspace: workspace }));
  }

  async recordWorkerProvision(taskId: string, provision: { worktreePath: string; baseBranch?: string; baseSha?: string; branchName?: string }): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.processState !== "launching") throw new Error("Worker launch intent is not active");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, ...provision, updatedAt: now() } } };
    });
  }

  async recordReviewTarget(taskId: string, target: NonNullable<WorkerTaskV4["reviewTarget"]>): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.role !== "review" || task.processState !== "launching") throw new Error("Review launch intent is not active");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, reviewTarget: target, updatedAt: now() } } };
    });
  }

  async recordWorkerSurface(taskId: string, identity: StableCmuxIdentity): Promise<void> {
    assertIdentity(identity);
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.processState !== "launching") throw new Error("Worker launch intent is not active");
      if (current.agentsWorkspace?.workspaceUuid !== identity.workspaceUuid) throw new Error("Worker surface is outside the dedicated Agents workspace");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, cmux: identity, updatedAt: now() } } };
    });
  }

  async recordLeadSurface(
    featureId: string,
    identity: StableCmuxIdentity,
    launch: { ownershipToken: string; generation: number; processPid?: number },
  ): Promise<void> {
    assertIdentity(identity);
    await this.store.update((current) => {
      const feature = current.features[featureId];
      if (!feature
        || feature.ownershipToken !== launch.ownershipToken
        || feature.leadLaunchGeneration !== launch.generation
        || (feature.leadLaunchState !== "launching" && feature.leadLaunchState !== "attached")) {
        throw new Error("Lead launch intent failed token/generation fencing");
      }
      const owner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : undefined;
      if (owner && !sameIdentity(owner.cmux, identity)) throw new Error("Attached Lead cmux identity differs from its launch result");
      return {
        ...current,
        features: {
          ...current.features,
          [feature.id]: {
            ...feature,
            leadCmux: identity,
            leadProcessPid: owner?.pid ?? launch.processPid,
            leadLaunchState: owner ? "attached" : "launched",
            updatedAt: now(),
          },
        },
      };
    });
  }

  async recoverAfterSupervisorRestart(): Promise<void> {
    await this.store.update((current) => {
      let next = current;
      for (const task of Object.values(current.tasks).filter((candidate) => candidate.processState === "launching")) {
        const updated = { ...task, processState: "unknown" as const, runtime: { ...task.runtime, crashReason: "Supervisor restarted with an incomplete durable launch saga" }, updatedAt: now() };
        next = appendEvent({ ...next, tasks: { ...next.tasks, [task.id]: updated } }, { featureId: task.featureId, taskId: task.id, kind: "runtime", actionable: true, summary: `Incomplete launch for ${task.id.slice(0, 8)} is UNKNOWN after supervisor restart; no duplicate launch is allowed` });
      }
      for (const feature of Object.values(next.features).filter((candidate) => candidate.leadLaunchState === "launching")) {
        const updated = {
          ...feature,
          ownershipToken: token(),
          leadLaunchGeneration: feature.leadLaunchGeneration + 1,
          leadLaunchState: "unowned" as const,
          updatedAt: now(),
        };
        next = appendEvent({ ...next, features: { ...next.features, [feature.id]: updated } }, {
          featureId: feature.id,
          kind: "runtime",
          actionable: true,
          summary: `Incomplete feature Lead launch is fenced UNKNOWN after supervisor restart; any possibly-live Lead workspace is retained`,
        });
      }
      return next;
    });
  }

  async markLeadLaunchUnknown(featureId: string, reason: string, launch?: { ownershipToken: string; generation: number }): Promise<void> {
    await this.store.update((current) => {
      const feature = current.features[featureId];
      if (!feature || feature.ownerAttachmentId || feature.leadLaunchState !== "launching") return current;
      if (launch && (feature.ownershipToken !== launch.ownershipToken || feature.leadLaunchGeneration !== launch.generation)) return current;
      const updated = {
        ...feature,
        ownershipToken: token(),
        leadLaunchGeneration: feature.leadLaunchGeneration + 1,
        leadLaunchState: "unowned" as const,
        updatedAt: now(),
      };
      return appendEvent({ ...current, features: { ...current.features, [feature.id]: updated } }, {
        featureId: feature.id,
        kind: "runtime",
        actionable: true,
        summary: `Feature Lead launch outcome UNKNOWN and its generation was fenced: ${reason}. A possibly-live Lead workspace is never relaunched automatically.`,
      });
    });
  }

  async reconcileUnattachedLead(input: {
    featureId: string;
    ownershipToken: string;
    launchGeneration: number;
    processPid?: number;
    retry: boolean;
    reason: string;
  }): Promise<boolean> {
    let reconciled = false;
    await this.store.update((current) => {
      const feature = current.features[input.featureId];
      if (!feature
        || feature.ownerAttachmentId
        || (feature.leadLaunchState !== "launching" && feature.leadLaunchState !== "launched")
        || feature.ownershipToken !== input.ownershipToken
        || feature.leadLaunchGeneration !== input.launchGeneration
        || feature.leadProcessPid !== input.processPid) return current;
      reconciled = true;
      const updated = {
        ...feature,
        ownershipToken: token(),
        leadLaunchGeneration: feature.leadLaunchGeneration + 1,
        leadLaunchState: input.retry ? "queued" as const : "unowned" as const,
        leadLaunchStartedAt: undefined,
        leadProcessPid: undefined,
        leadCmux: undefined,
        updatedAt: now(),
      };
      return appendEvent({ ...current, features: { ...current.features, [feature.id]: updated } }, {
        featureId: feature.id,
        kind: "runtime",
        actionable: !input.retry,
        summary: input.retry
          ? `Spawned Lead exited before attachment; fenced generation ${input.launchGeneration} was safely requeued (${input.reason})`
          : `Spawned Lead timed out before attachment; fenced generation ${input.launchGeneration} released capacity (${input.reason})`,
      });
    });
    return reconciled;
  }

  async markLaunchUnknown(taskId: string, reason: string): Promise<void> {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || !["launching", "running"].includes(task.processState) || task.status === "stopped") return current;
      const updated = { ...task, processState: "unknown" as const, runtime: { ...task.runtime, crashReason: reason }, updatedAt: now() };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: updated } }, { featureId: task.featureId, taskId: task.id, kind: "runtime", actionable: true, summary: `Launch outcome UNKNOWN: ${reason}. Duplicate launch, resume, reuse, and cleanup are forbidden.` });
    });
  }

  async status(): Promise<V4StatusSnapshot> {
    return this.snapshot(await this.store.read());
  }

  private requireAttachment(state: V4ProjectState, id: string, ownershipToken: string): LeadAttachment {
    const attachment = state.attachments[id];
    if (!attachment || attachment.ownershipToken !== ownershipToken) throw new Error("Lead attachment ownership token is invalid or stale");
    if (attachment.state !== "attached") throw new Error(`Lead attachment is ${attachment.state}; reattach with a new client incarnation`);
    return attachment;
  }

  private snapshot(state: V4ProjectState): V4StatusSnapshot {
    return {
      projectId: state.projectId,
      supervisorGeneration: state.supervisorGeneration,
      config: state.config,
      agentsWorkspace: state.agentsWorkspace,
      attachments: Object.values(state.attachments).sort((a, b) => a.attachedAt.localeCompare(b.attachedAt)),
      features: Object.values(state.features).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      tasks: Object.values(state.tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      pendingActionable: state.events.filter((event) => !event.observedAt && event.actionable).length,
      pendingTelemetry: state.events.filter((event) => !event.observedAt && !event.actionable).length,
    };
  }
}

export function projectName(projectRoot: string): string {
  return basename(projectRoot);
}
