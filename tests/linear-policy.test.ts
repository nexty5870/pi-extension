import assert from "node:assert/strict";
import test from "node:test";
import { contractFromInput } from "../extensions/orchestration/contracts.ts";
import {
  authorizeLinearTool,
  classifyLinearTool,
  isLinearMcpRoute,
} from "../extensions/orchestration/linear-policy.ts";
import type { InitiativeState } from "../extensions/orchestration/types.ts";

const now = "2026-01-01T00:00:00.000Z";
function initiative(linear: { team?: string; issueId?: string }, status: InitiativeState["status"] = "approved"): InitiativeState {
  return {
    schemaVersion: 1,
    initiativeId: "initiative-1",
    projectId: "project-1",
    projectRoot: "/tmp/public-example",
    status,
    contract: contractFromInput({
      kind: "feature",
      title: "Export report",
      linear,
      outcome: "Users can export a report.",
      context: "Exports are currently manual.",
      inScope: ["CSV export"],
      acceptanceCriteria: ["CSV downloads"],
      validation: ["Integration test"],
    }),
    createdAt: now,
    updatedAt: now,
  };
}

test("classifies pi-linear reads, scoped writes, destructive, and unknown tools", () => {
  assert.equal(classifyLinearTool("linear_list_issues"), "read");
  assert.equal(classifyLinearTool("linear_get_issue"), "read");
  assert.equal(classifyLinearTool("linear_search_issues"), "read");
  assert.equal(classifyLinearTool("linear_update_issue"), "write");
  assert.equal(classifyLinearTool("linear_delete_issue"), "destructive");
  assert.equal(classifyLinearTool("linear_save_project"), "unknown");
  assert.equal(classifyLinearTool("linear_switch_workspace"), "operator");
});

test("allows only reads during contract design", () => {
  const design = initiative({ issueId: "issue-1" }, "review");
  assert.equal(authorizeLinearTool("linear_list_issues", {}, { initiative: design }).allowed, true);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1" }, { initiative: design }).allowed, false);
});

test("scopes approved pi-linear writes and always blocks destructive operations", () => {
  const active = initiative({ issueId: "issue-1" });
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1" }, { initiative: active }).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_comment", { issueId: "issue-2" }, { initiative: active }).allowed, false);
  assert.equal(authorizeLinearTool("linear_archive_issue", { issue: "issue-1" }, { initiative: active }).allowed, false);
});

test("prevents generic MCP and third-party Linear write bypass", () => {
  assert.equal(isLinearMcpRoute("linear", "update_issue"), true);
  assert.equal(isLinearMcpRoute("other", "linear_update_issue"), true);
  assert.equal(authorizeLinearTool("linear_save_project", {}, { initiative: initiative({ issueId: "issue-1" }) }).allowed, false);
});

test("allows issue creation only for the armed approved destination", () => {
  const active = initiative({ team: "DEMO" });
  const args = {
    teamKey: "DEMO",
    title: "Export report",
    description: "<!-- pi-contract:start -->approved<!-- pi-contract:end -->",
  };
  assert.equal(authorizeLinearTool("linear_create_issue", args, { initiative: active, allowCreateIssue: true }).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_issue", args, { initiative: active }).allowed, false);
});
