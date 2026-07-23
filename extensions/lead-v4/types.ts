export type V4ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type V4WorkerRole = "implementation" | "research" | "review";
export type V4TaskStatus = "queued" | "starting" | "running" | "blocked" | "pr-ready-ci-pending" | "pr-ready-ci-green" | "completed" | "failed" | "stopped" | "merged";
export type V4ProcessState = "queued" | "launching" | "running" | "unknown" | "quarantined" | "offline" | "crashed" | "stopped";
export type ResolutionSource = "explicit-operator" | "spawning-lead" | "feature-preset" | "role-project" | "inherited-lead";

export interface StableCmuxIdentity {
  windowUuid: string;
  workspaceUuid: string;
  paneUuid: string;
  surfaceUuid: string;
  windowRef?: string;
  workspaceRef?: string;
  paneRef?: string;
  surfaceRef?: string;
}

export interface ResolvedChoice<T extends string = string> {
  value: T;
  source: ResolutionSource;
}

export interface ModelSelection {
  model?: string;
  thinking?: V4ThinkingLevel;
}

export interface ResolvedModelSelection {
  model: ResolvedChoice;
  thinking: ResolvedChoice<V4ThinkingLevel>;
  requestedModel: string;
  requestedThinking: V4ThinkingLevel;
  actualModel?: string;
  actualThinking?: V4ThinkingLevel;
  provider: string;
  modelId: string;
  resolvedAt: string;
}

export interface V4RolePolicy extends ModelSelection {}

export interface V4SupervisorConfig {
  maxConcurrentLeads: number;
  maxConcurrentWorkerProcesses: number;
  attachmentLeaseSeconds: number;
  processHeartbeatSeconds: number;
  digestLimit: number;
  automaticWorkerSurfaceRetirement: boolean;
  project?: ModelSelection;
  roles?: Partial<Record<"lead" | V4WorkerRole, V4RolePolicy>>;
  reviewerDiversity?: ModelSelection[];
}

export interface LeadAttachment {
  id: string;
  ownershipToken: string;
  sessionGeneration: number;
  sessionId: string;
  sessionFile?: string;
  pid: number;
  attachedAt: string;
  lastSeenAt: string;
  detachedAt?: string;
  state: "attached" | "detached" | "dead";
  featureId?: string;
  cmux: StableCmuxIdentity;
  selected: ResolvedModelSelection;
  availableModels: string[];
  inherited?: ModelSelection;
}

export interface FeatureTrack {
  id: string;
  key: string;
  title: string;
  task: string;
  issue?: string;
  acceptanceCriteria: string[];
  ownershipToken: string;
  ownerAttachmentId?: string;
  ownerGeneration: number;
  ownerAssignedAt?: string;
  preset?: ModelSelection;
  leadResolution?: ResolvedModelSelection;
  leadLaunchState: "attached" | "queued" | "launching" | "launched" | "unowned";
  leadCmux?: StableCmuxIdentity;
  taskIds: string[];
  eventCursors: Record<string, number>;
  schedulerSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerRuntimeV4 {
  pid?: number;
  processIncarnation?: string;
  ownershipToken: string;
  sessionGeneration: number;
  lastHeartbeatAt?: string;
  lastReportAt?: string;
  reportBaselineAt?: string;
  terminalAt?: string;
  crashReason?: string;
}

export interface WorkerTaskV4 {
  id: string;
  featureId: string;
  uniqueKey: string;
  role: V4WorkerRole;
  parentTaskId?: string;
  title: string;
  task: string;
  issue?: string;
  acceptanceCriteria: string[];
  status: V4TaskStatus;
  processState: V4ProcessState;
  baseBranch?: string;
  baseSha?: string;
  branchName?: string;
  worktreePath: string;
  sessionId: string;
  resolved: ResolvedModelSelection;
  cmux?: StableCmuxIdentity;
  runtime: WorkerRuntimeV4;
  blockedReason?: string;
  summary?: string;
  handoff?: string;
  prUrl?: string;
  checks?: Array<{ name: string; status: "passed" | "failed" | "pending" | "skipped"; details?: string }>;
  pullRequestChecks?: Array<{ name: string; status: "passed" | "failed" | "pending" | "skipped"; details?: string }>;
  pullRequestSummary?: string;
  reviewTarget?: { parentTaskId: string; diffHash: string; headSha: string; checksHash: string; capturedAt: string };
  review?: {
    verdict: "approved" | "changes-requested";
    findings: string[];
    acceptance: Array<{ criterion: string; status: "met" | "not-met" | "unclear"; evidence: string }>;
    diffHash?: string;
    headSha?: string;
    checksHash?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SupervisorEvent {
  id: string;
  sequence: number;
  featureId: string;
  taskId?: string;
  kind: "status" | "runtime" | "review" | "telemetry" | "ownership";
  actionable: boolean;
  summary: string;
  createdAt: string;
  observedAt?: string;
  observedBy?: string;
  claim?: { batchId: string; attachmentId: string; claimedAt: string };
}

export interface DigestBatch {
  id: string;
  attachmentId: string;
  eventIds: string[];
  actionable: boolean;
  content: string;
  truncated: boolean;
  createdAt: string;
}

export interface AgentsWorkspace {
  ownershipToken: string;
  sessionGeneration: number;
  windowUuid: string;
  workspaceUuid: string;
  paneUuid?: string;
  workspaceRef?: string;
  paneRef?: string;
  createdAt: string;
}

export interface LegacyV2Descriptor {
  taskId: string;
  status?: string;
  worktreePath?: string;
  surfaceId?: string;
  importedAt: string;
  sourceHash: string;
  resumeAllowed: false;
}

export interface V4ProjectState {
  schemaVersion: 4;
  projectId: string;
  projectRoot: string;
  projectName: string;
  supervisorGeneration: number;
  supervisorStartedAt: string;
  config: V4SupervisorConfig;
  agentsWorkspace?: AgentsWorkspace;
  attachments: Record<string, LeadAttachment>;
  features: Record<string, FeatureTrack>;
  tasks: Record<string, WorkerTaskV4>;
  events: SupervisorEvent[];
  operations: Record<string, { attachmentId: string; clientOperationId: string; kind: string; resultId: string; createdAt: string }>;
  nextEventSequence: number;
  schedulerCursor?: string;
  legacyV2: LegacyV2Descriptor[];
  createdAt: string;
  updatedAt: string;
}

export interface V4StatusSnapshot {
  projectId: string;
  supervisorGeneration: number;
  config: V4SupervisorConfig;
  agentsWorkspace?: AgentsWorkspace;
  attachments: LeadAttachment[];
  features: FeatureTrack[];
  tasks: WorkerTaskV4[];
  pendingActionable: number;
  pendingTelemetry: number;
}
