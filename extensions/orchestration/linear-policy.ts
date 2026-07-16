import type { FeatureOrBugContract, InitiativeState } from "./types.ts";

export type LinearToolClass = "read" | "write" | "destructive" | "operator" | "unknown";

const SCOPED_WRITES = new Set([
  "linear_create_issue",
  "linear_update_issue",
  "linear_create_comment",
  "linear_update_comment",
  "linear_save_project",
  "linear_create_issue_relation",
]);

export function classifyLinearTool(toolName: string): LinearToolClass {
  const name = toolName.toLowerCase();
  if (name === "linear_switch_workspace") return "operator";
  if (/^linear_(delete|archive|unarchive)_/.test(name)) return "destructive";
  if (/^linear_(list|get|search)_/.test(name)) return "read";
  if (SCOPED_WRITES.has(name)) return "write";
  return "unknown";
}

export function hasLinearDestination(contract: FeatureOrBugContract): boolean {
  return Boolean(contract.linear.issueId || contract.linear.issueIdentifier || contract.linear.team);
}

function parsedLinearValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\[{]/.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function collectLinearResourceAliases(value: unknown, result = new Map<string, string>()): Map<string, string> {
  value = parsedLinearValue(value);
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) { for (const item of value) collectLinearResourceAliases(item, result); return result; }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id) {
    for (const key of ["id", "name", "key", "identifier"] as const) {
      const alias = typeof record[key] === "string" ? record[key].trim() : "";
      if (alias) {
        for (const candidate of new Set([alias, alias.toLowerCase()])) {
          const existing = result.get(candidate);
          result.set(candidate, existing && existing !== id ? "" : id);
        }
      }
    }
  }
  for (const item of Object.values(record)) collectLinearResourceAliases(item, result);
  return result;
}

export function collectCompletedStatusIds(value: unknown, result = new Set<string>()): Set<string> {
  value = parsedLinearValue(value);
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) { for (const item of value) collectCompletedStatusIds(item, result); return result; }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  if (id && (type === "completed" || /^(?:done|completed|complete)$/.test(name))) result.add(id);
  for (const item of Object.values(record)) collectCompletedStatusIds(item, result);
  return result;
}

function stringAt(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function issueReference(args: Record<string, unknown>): string | undefined {
  return stringAt(args, ["issue", "issueId", "issue_id"]);
}

function hasOnlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(args).every((key) => keys.has(key));
}

function resolvedLinearId(value: string, aliases?: ReadonlyMap<string, string>): string | undefined {
  return aliases?.get(value) || aliases?.get(value.toLowerCase()) || undefined;
}

function sameLinearResource(expected: string, actual: string, aliases?: ReadonlyMap<string, string>): boolean {
  const expectedId = resolvedLinearId(expected, aliases);
  const actualId = resolvedLinearId(actual, aliases);
  return expectedId ? expectedId === (actualId ?? actual) : expected === actual;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAuthorizedIssue(reference: string | undefined, authorized?: ReadonlySet<string>, aliases?: ReadonlyMap<string, string>): boolean {
  if (!reference || !authorized?.size) return false;
  if (authorized.has(reference) || authorized.has(reference.toUpperCase())) return true;
  const referenceId = resolvedLinearId(reference, aliases) ?? reference;
  return [...authorized].some((item) => (resolvedLinearId(item, aliases) ?? item) === referenceId);
}

export interface LinearPolicyContext {
  initiative?: InitiativeState;
  allowCreateIssue?: boolean;
  /** One-turn capability created by a direct operator request to open a tracking issue. */
  allowDirectIssueCreate?: boolean;
  /** One-turn capability created by an explicit request to publish a plan to Linear. */
  allowPlanProjectCreate?: boolean;
  allowPlanIssueCreate?: boolean;
  planProjectIds?: ReadonlySet<string>;
  /** Operator-directed administration scoped to issue identifiers named in the conversation. */
  allowIssueAdmin?: boolean;
  adminIssueRefs?: ReadonlySet<string>;
  /** One-turn capability created by a direct operator request such as “mark it done”. */
  allowWorkflowUpdate?: boolean;
  completedStatusIds?: ReadonlySet<string>;
  /** Canonical IDs proven by pi-linear read results in this session. */
  resourceAliases?: ReadonlyMap<string, string>;
}

export function authorizeLinearTool(
  toolName: string,
  args: Record<string, unknown>,
  context: LinearPolicyContext,
): { allowed: true } | { allowed: false; reason: string } {
  const classification = classifyLinearTool(toolName);
  if (classification === "read") return { allowed: true };
  if (classification === "destructive") {
    return { allowed: false, reason: `${toolName} is destructive and is always blocked by orchestration` };
  }
  if (classification === "operator") {
    return { allowed: false, reason: "Linear workspace switching is operator-controlled through /linear-auth" };
  }
  if (classification === "unknown") {
    return { allowed: false, reason: `Unknown Linear tool ${toolName} is blocked by default` };
  }

  const lowerToolName = toolName.toLowerCase();
  if (context.allowIssueAdmin && lowerToolName === "linear_update_issue") {
    const target = issueReference(args);
    if (!isAuthorizedIssue(target, context.adminIssueRefs, context.resourceAliases)) {
      return { allowed: false, reason: "Issue administration must target an issue explicitly named by the operator" };
    }
    if (!hasOnlyKeys(args, ["issue", "priority", "stateId", "assigneeId", "dueDate", "clearDueDate", "estimate", "addedLabelIds", "removedLabelIds", "labelIds", "projectId", "parentId", "cycleId"])) {
      return { allowed: false, reason: "Issue administration contains unsupported fields" };
    }
    return { allowed: true };
  }
  if (context.allowIssueAdmin && lowerToolName === "linear_create_issue_relation") {
    const issueId = stringAt(args, ["issueId"]);
    const relatedIssueId = stringAt(args, ["relatedIssueId"]);
    if (!isAuthorizedIssue(issueId, context.adminIssueRefs, context.resourceAliases) || !isAuthorizedIssue(relatedIssueId, context.adminIssueRefs, context.resourceAliases)) {
      return { allowed: false, reason: "Issue relations must connect issues explicitly named by the operator" };
    }
    if (!hasOnlyKeys(args, ["issueId", "relatedIssueId", "type"]) || !["blocks", "duplicate", "related", "similar"].includes(String(args.type))) {
      return { allowed: false, reason: "Issue relation type must be blocks, duplicate, related, or similar" };
    }
    return { allowed: true };
  }

  if (lowerToolName === "linear_save_project") {
    if (!context.allowPlanProjectCreate) {
      return { allowed: false, reason: "Project creation requires a direct operator request to publish a plan to Linear" };
    }
    if (args.projectId !== undefined || args.id !== undefined) {
      return { allowed: false, reason: "Plan publication may create a project but cannot update an existing project" };
    }
    if (typeof args.name !== "string" || !args.name.trim()) return { allowed: false, reason: "Project creation requires a name" };
    if (!Array.isArray(args.teamIds) || args.teamIds.length === 0 || args.teamIds.some((id) => typeof id !== "string" || !resolvedLinearId(id, context.resourceAliases))) {
      return { allowed: false, reason: "Project creation requires read-proven canonical teamIds" };
    }
    if (!hasOnlyKeys(args, ["name", "description", "content", "teamIds"])) {
      return { allowed: false, reason: "Project creation contains fields outside plan publication" };
    }
    return { allowed: true };
  }

  if (toolName.toLowerCase() === "linear_create_issue" && (context.allowDirectIssueCreate || context.allowPlanIssueCreate)) {
    const teamId = stringAt(args, ["teamId"]);
    const teamKey = stringAt(args, ["teamKey"]);
    const actualTeam = teamId ?? teamKey;
    if (!actualTeam || !resolvedLinearId(actualTeam, context.resourceAliases)) {
      return { allowed: false, reason: "Direct issue creation requires a teamId/teamKey proven by a pi-linear read in this turn" };
    }
    const projectId = stringAt(args, ["projectId"]);
    if (context.allowPlanIssueCreate && (!projectId || !context.planProjectIds?.has(projectId))) {
      return { allowed: false, reason: "Plan issues must target the project created for this publication" };
    }
    if (projectId && !resolvedLinearId(projectId, context.resourceAliases) && !context.planProjectIds?.has(projectId)) {
      return { allowed: false, reason: "Direct issue creation projectId must be proven by a pi-linear read in this turn" };
    }
    if (typeof args.title !== "string" || !args.title.trim()) {
      return { allowed: false, reason: "Direct issue creation requires a title" };
    }
    if (!hasOnlyKeys(args, ["teamId", "teamKey", "projectId", "title", "description"])) {
      return { allowed: false, reason: "Direct issue creation contains unsupported fields" };
    }
    return { allowed: true };
  }

  const initiative = context.initiative;
  if (!initiative?.contract || !hasLinearDestination(initiative.contract)) {
    return { allowed: false, reason: `${toolName} has no active Linear-bound contract` };
  }
  if (initiative.status !== "approved" && !context.allowWorkflowUpdate) {
    return { allowed: false, reason: `${toolName} requires contract approval or a direct operator workflow instruction` };
  }

  if (toolName.toLowerCase() === "linear_create_issue") {
    if (initiative.status !== "approved") {
      return { allowed: false, reason: "Issue creation still requires an approved contract" };
    }
    if (!context.allowCreateIssue || initiative.contract.linear.issueId || initiative.contract.linear.issueIdentifier) {
      return { allowed: false, reason: "Issue creation is allowed only for pending approved-contract persistence" };
    }
    const expectedTeam = initiative.contract.linear.team;
    const teamId = stringAt(args, ["teamId"]);
    const teamKey = stringAt(args, ["teamKey"]);
    const actualTeam = teamId ?? teamKey;
    const unresolvedTeamIsCanonical = teamId ? UUID.test(teamId) : Boolean(teamKey && /^[A-Z][A-Z0-9_-]*$/.test(teamKey));
    if (!expectedTeam || !actualTeam || !sameLinearResource(expectedTeam, actualTeam, context.resourceAliases) || (!resolvedLinearId(expectedTeam, context.resourceAliases) && !unresolvedTeamIsCanonical)) {
      return { allowed: false, reason: "Issue creation must target the configured team using a read-proven teamId/teamKey, never a display name" };
    }
    if (!hasOnlyKeys(args, ["teamId", "teamKey", "projectId", "title", "description"])) {
      return { allowed: false, reason: "Issue creation contains fields outside approved contract persistence" };
    }
    if (initiative.contract.linear.project) {
      const projectId = typeof args.projectId === "string" ? args.projectId : "";
      const resolvedProject = resolvedLinearId(initiative.contract.linear.project, context.resourceAliases);
      if (!projectId || !sameLinearResource(initiative.contract.linear.project, projectId, context.resourceAliases) || (!resolvedProject && !UUID.test(projectId))) {
        return { allowed: false, reason: "Issue creation must target the configured project using a read-proven canonical projectId, never a display name" };
      }
    }
    if (args.title !== initiative.contract.title || typeof args.description !== "string" || !args.description.includes("<!-- pi-contract:start -->")) {
      return { allowed: false, reason: "Issue creation must contain the approved contract title and managed description" };
    }
    return { allowed: true };
  }

  if (initiative.status !== "approved" && toolName.toLowerCase() !== "linear_update_issue") {
    return { allowed: false, reason: "Direct workflow instructions authorize only the active issue status update" };
  }

  const activeIssues = new Set([
    initiative.contract.linear.issueId,
    initiative.contract.linear.issueIdentifier,
    initiative.approved?.issueId,
    initiative.approved?.issueIdentifier,
  ].filter((value): value is string => Boolean(value)));
  if (activeIssues.size === 0) return { allowed: false, reason: `${toolName} has no active issue binding` };
  const target = issueReference(args);
  if (!target || !activeIssues.has(target)) {
    return { allowed: false, reason: `${toolName} must target the active issue (${[...activeIssues].join(" / ")})` };
  }
  const name = toolName.toLowerCase();
  const workflowStateId = name === "linear_update_issue" && context.allowWorkflowUpdate && typeof args.stateId === "string"
    ? args.stateId
    : undefined;
  if (name === "linear_update_issue" && context.allowWorkflowUpdate && initiative.status !== "approved" && !workflowStateId) {
    return { allowed: false, reason: "Direct workflow instructions authorize only a completed stateId" };
  }
  if (workflowStateId && !context.completedStatusIds?.has(workflowStateId)) {
    return { allowed: false, reason: "Marking an issue done requires a stateId resolved from the team's completed statuses in this turn" };
  }
  const allowedKeys = name === "linear_update_issue"
    ? workflowStateId
      ? ["issue", "stateId", "completedAt", "canceledAt"]
      : ["issue", "title", "description"]
    : name === "linear_create_comment"
      ? ["issueId", "body"]
      : ["id", "issueId", "body", "quotedText"];
  if (!hasOnlyKeys(args, allowedKeys)) {
    return { allowed: false, reason: `${toolName} contains fields outside approved contract persistence` };
  }
  return { allowed: true };
}

/** Generic MCP must never be an alternate route around the companion extension policy. */
export function isLinearMcpRoute(serverId: string, toolName: string): boolean {
  return /linear/i.test(serverId) || /^linear_/i.test(toolName);
}
