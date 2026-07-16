import type { DeliveryMetadata } from "../types.ts";

export type DeliveryPhase =
  | "preflight" | "worktree" | "implementing" | "reviewing" | "checking"
  | "committing" | "pushing" | "pull-request" | "ci" | "action-required"
  | "completed" | "failed" | "aborted";
export type WorkerRole = "implementer" | "reviewer";

export interface WorkerSnapshot {
  role: WorkerRole;
  phase: "idle" | "running" | "passed" | "failed";
  task: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: { input: number; output: number; cost: number };
  failure?: string;
}

export interface CheckResult {
  argv: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  outputPath: string;
  diffHashBefore: string;
  diffHashAfter: string;
  disposition?: "passed" | "blocked" | "failed";
  reason?: string;
}

export interface BaselineCheckResult {
  argv: string[];
  exitCode: number;
  outputPath: string;
}

export interface OperatorAction { id: string; severity: "info" | "warning" | "critical"; message: string; createdAt: string }

export interface DeliveryState {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  initiativeId: string;
  projectRoot: string;
  contractHash: string;
  metadata: DeliveryMetadata;
  phase: DeliveryPhase;
  baseSha?: string;
  branchName: string;
  worktreePath?: string;
  commitSha?: string;
  pushed?: boolean;
  prUrl?: string;
  ciState?: "pending" | "success" | "failure" | "cancelled" | "timed-out" | "none";
  reviewPass: number;
  repairPass?: number;
  reviewedDiffHash?: string;
  dependencySetupComplete?: boolean;
  baselineChecks?: BaselineCheckResult[];
  baselineUnavailable?: boolean;
  workers: Partial<Record<WorkerRole, WorkerSnapshot>>;
  checks: CheckResult[];
  actions: OperatorAction[];
  cmux?: { paneId?: string; implementerSurfaceId?: string; reviewerSurfaceId?: string };
  failure?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ReviewerResult { verdict: "approved" | "changes_requested"; diffHash: string; findings: string[] }
export interface WorkerResult { text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } }
