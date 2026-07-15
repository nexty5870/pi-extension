import assert from "node:assert/strict";
import test from "node:test";
import { authorizeMcpCall, classifyMcpTool } from "../extensions/orchestration/mcp/policy.ts";
import type { McpServerConfig } from "../extensions/orchestration/types.ts";

const server: McpServerConfig = {
  transport: "http",
  url: "https://example.test/mcp",
  policy: {
    read: ["get_*", "list_*", "search_issues"],
    write: ["create_issue", "update_issue", "create_comment"],
    destructive: ["delete_*", "archive_issue"],
  },
};

test("classifies tools through the configured semantic allowlist", () => {
  assert.equal(classifyMcpTool(server, "get_issue"), "read");
  assert.equal(classifyMcpTool(server, "update_issue"), "write");
  assert.equal(classifyMcpTool(server, "delete_issue"), "destructive");
  assert.equal(classifyMcpTool(server, "surprise_tool"), "unknown");
});

test("allows reads before approval and denies writes", () => {
  assert.deepEqual(authorizeMcpCall("read", "get_issue", { id: "A" }, { approvalGranted: false }), {
    allowed: true,
  });
  assert.equal(
    authorizeMcpCall("write", "update_issue", { id: "A" }, { approvalGranted: false }).allowed,
    false,
  );
});

test("scopes approved writes to the active issue", () => {
  assert.deepEqual(
    authorizeMcpCall(
      "write",
      "update_issue",
      { id: "issue-1" },
      { approvalGranted: true, activeIssueId: "issue-1" },
    ),
    { allowed: true },
  );
  assert.equal(
    authorizeMcpCall(
      "write",
      "update_issue",
      { id: "issue-2" },
      { approvalGranted: true, activeIssueId: "issue-1" },
    ).allowed,
    false,
  );
});

test("permits issue creation only inside the approved persistence flow", () => {
  assert.deepEqual(
    authorizeMcpCall(
      "write",
      "create_issue",
      { team: "DEMO" },
      { approvalGranted: true, allowCreateIssue: true },
      "create_issue",
    ),
    { allowed: true },
  );
  assert.equal(
    authorizeMcpCall("write", "create_issue", { team: "DEMO" }, { approvalGranted: true }, "create_issue").allowed,
    false,
  );
});

test("always denies destructive and unknown tools", () => {
  assert.equal(authorizeMcpCall("destructive", "delete_issue", {}, { approvalGranted: true }).allowed, false);
  assert.equal(authorizeMcpCall("unknown", "mystery", {}, { approvalGranted: true }).allowed, false);
});
