import type { FeatureOrBugContract, InitiativeState } from "./types.ts";

export type LinearToolClass = "read" | "write" | "destructive" | "operator" | "unknown";

const SCOPED_WRITES = new Set([
  "linear_create_issue",
  "linear_update_issue",
  "linear_create_comment",
  "linear_update_comment",
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

export interface LinearPolicyContext {
  initiative?: InitiativeState;
  allowCreateIssue?: boolean;
  /** One-turn capability created by a direct operator request to open a tracking issue. */
  allowDirectIssueCreate?: boolean;
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

  if (toolName.toLowerCase() === "linear_create_issue" && context.allowDirectIssueCreate) {
    const teamId = stringAt(args, ["teamId"]);
    const teamKey = stringAt(args, ["teamKey"]);
    const actualTeam = teamId ?? teamKey;
    if (!actualTeam || !resolvedLinearId(actualTeam, context.resourceAliases)) {
      return { allowed: false, reason: "Direct issue creation requires a teamId/teamKey proven by a pi-linear read in this turn" };
    }
    const projectId = stringAt(args, ["projectId"]);
    if (projectId && !resolvedLinearId(projectId, context.resourceAliases)) {
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
