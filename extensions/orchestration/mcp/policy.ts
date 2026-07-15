import type {
  McpOperationClass,
  McpPolicyContext,
  McpServerConfig,
} from "../types.ts";

function matches(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(toolName);
}

export function classifyMcpTool(
  server: McpServerConfig,
  toolName: string,
): McpOperationClass {
  if (server.policy.destructive.some((pattern) => matches(pattern, toolName))) return "destructive";
  if (server.policy.write.some((pattern) => matches(pattern, toolName))) return "write";
  if (server.policy.read.some((pattern) => matches(pattern, toolName))) return "read";
  return "unknown";
}

function findIssueReference(args: Record<string, unknown>): string | undefined {
  for (const key of ["issueId", "issue_id", "issue", "id"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return undefined;
}

export function authorizeMcpCall(
  operation: McpOperationClass,
  toolName: string,
  args: Record<string, unknown>,
  context: McpPolicyContext,
  createIssueTool?: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (operation === "read") return { allowed: true };
  if (operation === "unknown") {
    return { allowed: false, reason: `MCP tool ${toolName} is not on the configured allowlist` };
  }
  if (operation === "destructive") {
    return { allowed: false, reason: `MCP tool ${toolName} is destructive and requires a separate approval flow` };
  }
  if (!context.approvalGranted) {
    return { allowed: false, reason: `MCP write ${toolName} is unavailable before contract approval` };
  }
  if (createIssueTool && toolName === createIssueTool) {
    return context.allowCreateIssue
      ? { allowed: true }
      : { allowed: false, reason: "Creating a Linear issue is only allowed while persisting an approved contract" };
  }
  if (!context.activeIssueId) {
    return { allowed: false, reason: `MCP write ${toolName} has no active Linear issue binding` };
  }
  const issueReference = findIssueReference(args);
  if (!issueReference) {
    return { allowed: false, reason: `MCP write ${toolName} must include the active issue ID` };
  }
  if (issueReference !== context.activeIssueId) {
    return { allowed: false, reason: `MCP write ${toolName} targets an issue outside the active initiative` };
  }
  return { allowed: true };
}
