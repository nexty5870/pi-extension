export const TASK_STATUSES = [
  "starting",
  "running",
  "blocked",
  "pr-ready-ci-pending",
  "pr-ready-ci-green",
  "completed",
  "failed",
  "stopped",
  "merged",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export const LEAD_EVENT_STATUSES = [
  "blocked",
  "pr-ready-ci-pending",
  "pr-ready-ci-green",
  "completed",
  "failed",
  "stopped",
  "merged",
] as const satisfies readonly TaskStatus[];
export type WorkerRole = "implementation" | "review" | "research";
export type WorkerRuntimeState = "starting" | "busy" | "idle" | "stale" | "offline" | "detached" | "needs-attention";
export type WorkerSurfaceHealth = "healthy" | "missing" | "detached";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerRuntime {
  state: WorkerRuntimeState;
  lastHeartbeatAt?: string;
  lastActivityAt?: string;
  lastReportAt?: string;
  lastAgentSettledAt?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  loadedRuntimeVersion?: string;
  surfaceHealth?: WorkerSurfaceHealth;
  attentionReason?: string;
  shutdownReason?: string;
  shutdownRequestedAt?: string;
  terminalAt?: string;
  reportNudgeState?: "scheduled" | "sent" | "attention";
  reportNudgeAt?: string;
  reportBaselineAt?: string;
  contextWarnedAt?: string;
  contextHandoffRequestedAt?: string;
  retiredAt?: string;
  retiredSurfaceId?: string;
  surfaceTransitionKey?: string;
}

export interface WorkerSelection {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface WorkerModelRule extends WorkerSelection {
  pattern: string;
}

export interface WorkerPolicy {
  maxVisibleSurfaces?: number;
  heartbeatSeconds?: number;
  staleAfterSeconds?: number;
  idleReportGraceSeconds?: number;
  terminalSurfaceRetentionMinutes?: number;
  contextWarnPercent?: number;
  contextHandoffPercent?: number;
  default?: WorkerSelection & { inheritModel?: boolean };
  roles?: Partial<Record<WorkerRole, WorkerSelection>>;
  models?: WorkerModelRule[];
}

export interface ResolvedWorkerPolicy {
  model?: string;
  provider?: string;
  modelId?: string;
  thinking?: ThinkingLevel;
}

export interface TaskBrief {
  title: string;
  task: string;
  issue?: string;
  acceptanceCriteria: string[];
}

export interface CheckEvidence {
  name: string;
  status: "passed" | "failed" | "pending" | "skipped";
  details?: string;
}

export interface AcceptanceEvidence {
  criterion: string;
  status: "met" | "not-met" | "unclear";
  evidence: string;
}

export interface ReviewEvidence {
  verdict: "approved" | "changes-requested";
  reviewedAt: string;
  diffBaseSha?: string;
  diffHash: string;
  headSha: string;
  checksHash: string;
  acceptance: AcceptanceEvidence[];
  findings: string[];
}

export interface ReviewTarget {
  parentTaskId: string;
  diffBaseSha: string;
  diffHash: string;
  headSha: string;
  checksHash: string;
  capturedAt: string;
}

export interface PullRequestState {
  url: string;
  headSha?: string;
  mergeState?: string;
  checks: CheckEvidence[];
  observedAt?: string;
}

export interface AutoReviewState {
  spawnedTaskId?: string;
  attemptedAt: string;
  error?: string;
}

export interface WorkerSurface {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

export interface WorkerMessage {
  id: string;
  text: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface LeadTaskEvent {
  id: string;
  kind: "status" | "review" | "runtime";
  status: TaskStatus;
  createdAt: string;
  observedAt?: string;
  deliveryClaimId?: string;
  deliveryClaimedAt?: string;
  blockedReason?: string;
  summary?: string;
  handoff?: string;
  review?: ReviewEvidence;
  pullRequestUrl?: string;
  runtimeReasonKey?: string;
  linear?: {
    issueIdentifier: string;
    status: LinearLifecycleState["status"];
    stateName?: string;
  };
}

export interface LinearLifecycleState {
  issueIdentifier: string;
  desiredStateType: "started";
  status: "pending" | "verifying" | "in-progress" | "unavailable";
  attempts: number;
  issueId?: string;
  teamId?: string;
  issueObservedAt?: string;
  stateId?: string;
  stateName?: string;
  candidateStateId?: string;
  candidateStateName?: string;
  candidateTeamId?: string;
  candidateObservedAt?: string;
  writeClaimId?: string;
  writeClaimedAt?: string;
  writeObservedAt?: string;
  verifiedAt?: string;
  promptedAt?: string;
  promptCount?: number;
  promptClaimId?: string;
  promptClaimedAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface TaskRecord {
  schemaVersion: 2;
  id: string;
  projectId: string;
  role: WorkerRole;
  parentTaskId?: string;
  brief: TaskBrief;
  status: TaskStatus;
  blockedReason?: string;
  summary?: string;
  handoff?: string;
  baseBranch?: string;
  baseSha?: string;
  branchName?: string;
  worktreePath: string;
  sessionId: string;
  workerStartedAt?: string;
  surface?: WorkerSurface;
  promptPath?: string;
  launchScriptPath?: string;
  pullRequest?: PullRequestState;
  checks: CheckEvidence[];
  review?: ReviewEvidence;
  reviewTarget?: ReviewTarget;
  autoReview?: AutoReviewState;
  messages?: WorkerMessage[];
  linear?: LinearLifecycleState;
  leadEvents?: LeadTaskEvent[];
  leadObservedStatus?: TaskStatus;
  leadObservedAt?: string;
  failure?: string;
  setupWarnings?: string[];
  runtime?: WorkerRuntime;
  resolvedWorker?: ResolvedWorkerPolicy;
  launchState?: "queued" | "launching" | "launched" | "retired";
  launchClaimId?: string;
  launchClaimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  schemaVersion: 2;
  projectId: string;
  projectRoot: string;
  projectName: string;
  leadSessionFile?: string;
  autoReview?: boolean;
  workers?: WorkerPolicy;
  surfaceLaunchClaims?: Record<string, string>;
  cmux?: {
    workspaceId: string;
    callerSurfaceId: string;
    helperPaneId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestObservation {
  status: "pending" | "green" | "failed" | "merged";
  url: string;
  headSha?: string;
  mergeState?: string;
  checks: CheckEvidence[];
  reason?: string;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "merged";
}
