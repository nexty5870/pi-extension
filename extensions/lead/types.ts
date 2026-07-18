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
  kind: "status" | "review";
  status: TaskStatus;
  createdAt: string;
  observedAt?: string;
  blockedReason?: string;
  summary?: string;
  handoff?: string;
  review?: ReviewEvidence;
  pullRequestUrl?: string;
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
  messages?: WorkerMessage[];
  linear?: LinearLifecycleState;
  leadEvents?: LeadTaskEvent[];
  leadObservedStatus?: TaskStatus;
  leadObservedAt?: string;
  failure?: string;
  setupWarnings?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  schemaVersion: 2;
  projectId: string;
  projectRoot: string;
  projectName: string;
  leadSessionFile?: string;
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
