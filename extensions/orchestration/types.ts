export type ContractKind = "feature" | "bug";
export type InitiativeStatus = "design" | "review" | "approved" | "closed";

export interface LinearDestination {
  /** Team ID or key used by pi-linear. Omit for GitHub/docs-only contracts. */
  team?: string;
  project?: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface DeliveryMetadata {
  baseBranch: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  /** Executable plus arguments. Commands are never interpreted by a shell. */
  checks: string[][];
}

interface ContractBase {
  kind: ContractKind;
  title: string;
  version: number;
  linear: LinearDestination;
  delivery?: DeliveryMetadata;
}

export interface FeatureContract extends ContractBase {
  kind: "feature";
  outcome: string;
  context: string;
  inScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  dependencies: string[];
  validation: string[];
  rollout: string[];
  documentation: string[];
}

export interface BugContract extends ContractBase {
  kind: "bug";
  impact: string;
  environment: string;
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  evidence: string[];
  frequency: string;
  triggeringConditions: string[];
  workaround: string;
  suspectedArea?: string;
  acceptanceCriteria: string[];
  regressionTests: string[];
}

export type FeatureOrBugContract = FeatureContract | BugContract;

export interface ApprovedContractRecord {
  version: number;
  contentHash: string;
  approvedAt: string;
  approvedBy: "operator";
  source: "local" | "linear";
  linearPersistence: "not-configured" | "pending" | "persisted";
  issueId?: string;
  issueIdentifier?: string;
}

export interface InitiativeState {
  schemaVersion: 1;
  initiativeId: string;
  projectId: string;
  projectRoot: string;
  cmuxWorkspaceId?: string;
  cmuxSurfaceId?: string;
  status: InitiativeStatus;
  contract?: FeatureOrBugContract;
  contractPath?: string;
  approved?: ApprovedContractRecord;
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  schemaVersion: 1;
  timestamp: string;
  projectId: string;
  initiativeId?: string;
  taskId?: string;
  role: "cto" | "scout" | "worker" | "reviewer";
  runtime: "pi" | "cursor";
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  estimatedCost: boolean;
  turns: number;
  toolCalls: number;
  durationMs?: number;
}

export interface ProjectContext {
  projectId: string;
  projectRoot: string;
  projectName: string;
  cmuxWorkspaceId?: string;
  cmuxSurfaceId?: string;
  cmuxSocketPath?: string;
}

export type McpOperationClass = "read" | "write" | "destructive" | "unknown";

export interface McpToolPolicy {
  read: string[];
  write: string[];
  destructive: string[];
}

interface McpServerBase {
  policy: McpToolPolicy;
}

export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerBase {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpPolicyContext {
  approvalGranted: boolean;
  allowCreateIssue?: boolean;
  activeIssueId?: string;
}
