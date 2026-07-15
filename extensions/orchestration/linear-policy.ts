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

export interface LinearPolicyContext {
  initiative?: InitiativeState;
  allowCreateIssue?: boolean;
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

  const initiative = context.initiative;
  if (!initiative?.contract || initiative.status !== "approved" || !hasLinearDestination(initiative.contract)) {
    return { allowed: false, reason: `${toolName} is unavailable without an approved Linear-bound contract` };
  }

  if (toolName.toLowerCase() === "linear_create_issue") {
    if (!context.allowCreateIssue || initiative.contract.linear.issueId || initiative.contract.linear.issueIdentifier) {
      return { allowed: false, reason: "Issue creation is allowed only for pending approved-contract persistence" };
    }
    const expectedTeam = initiative.contract.linear.team;
    const actualTeam = stringAt(args, ["teamId", "teamKey"]);
    if (!expectedTeam || actualTeam !== expectedTeam) {
      return { allowed: false, reason: "Issue creation must target the contract's configured Linear team" };
    }
    if (!hasOnlyKeys(args, ["teamId", "teamKey", "projectId", "title", "description"])) {
      return { allowed: false, reason: "Issue creation contains fields outside approved contract persistence" };
    }
    if (initiative.contract.linear.project && args.projectId !== initiative.contract.linear.project) {
      return { allowed: false, reason: "Issue creation must target the contract's configured Linear project" };
    }
    if (args.title !== initiative.contract.title || typeof args.description !== "string" || !args.description.includes("<!-- pi-contract:start -->")) {
      return { allowed: false, reason: "Issue creation must contain the approved contract title and managed description" };
    }
    return { allowed: true };
  }

  const activeIssue = initiative.contract.linear.issueId ?? initiative.contract.linear.issueIdentifier ?? initiative.approved?.issueId;
  if (!activeIssue) return { allowed: false, reason: `${toolName} has no active issue binding` };
  const target = issueReference(args);
  if (target !== activeIssue) {
    return { allowed: false, reason: `${toolName} must target the active issue ${activeIssue}` };
  }
  const name = toolName.toLowerCase();
  const allowedKeys = name === "linear_update_issue"
    ? ["issue", "title", "description"]
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
