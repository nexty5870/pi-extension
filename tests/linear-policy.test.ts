import assert from "node:assert/strict";
import test from "node:test";
import { contractFromInput } from "../extensions/orchestration/contracts.ts";
import {
  authorizeLinearTool,
  classifyLinearTool,
  collectCompletedStatusIds,
  collectLinearResourceAliases,
  isLinearMcpRoute,
} from "../extensions/orchestration/linear-policy.ts";
import type { InitiativeState } from "../extensions/orchestration/types.ts";

const now = "2026-01-01T00:00:00.000Z";
function initiative(linear: { team?: string; issueId?: string; issueIdentifier?: string }, status: InitiativeState["status"] = "approved"): InitiativeState {
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
  assert.equal(classifyLinearTool("linear_save_project"), "write");
  assert.equal(classifyLinearTool("linear_create_issue_relation"), "write");
  assert.equal(classifyLinearTool("linear_switch_workspace"), "operator");
});

test("allows only reads during contract design", () => {
  const design = initiative({ issueId: "issue-1" }, "review");
  assert.equal(authorizeLinearTool("linear_list_issues", {}, { initiative: design }).allowed, true);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1" }, { initiative: design }).allowed, false);
});

test("collects read-proven Linear names, keys, and canonical IDs", () => {
  const aliases = collectLinearResourceAliases({ teams: [{ id: "team-uuid", key: "DEMO", name: "Demo Team" }], projects: [{ id: "project-uuid", name: "Public Launch" }] });
  assert.equal(aliases.get("Demo Team"), "team-uuid");
  assert.equal(aliases.get("demo"), "team-uuid");
  assert.equal(aliases.get("Public Launch"), "project-uuid");
  assert.equal(collectLinearResourceAliases([{ type: "text", text: JSON.stringify({ id: "p2", name: "Second Project" }) }]).get("Second Project"), "p2");
  const ambiguous = collectLinearResourceAliases([{ id: "p1", name: "Duplicate" }, { id: "p2", name: "Duplicate" }]);
  assert.equal(ambiguous.get("Duplicate"), "");
});

test("collects only completed workflow statuses from pi-linear results", () => {
  assert.deepEqual([...collectCompletedStatusIds({ data: { statuses: [
    { id: "started", name: "In Progress", type: "started" },
    { id: "done", name: "Done", type: "completed" },
  ] } })], ["done"]);
  assert.deepEqual([...collectCompletedStatusIds([{ type: "text", text: JSON.stringify({ statuses: [{ id: "closed", type: "completed" }] }) }])], ["closed"]);
});

test("direct operator completion allows only a resolved completed state on the active issue", () => {
  const review = initiative({ issueId: "issue-1" }, "review");
  const workflow = { initiative: review, allowWorkflowUpdate: true, completedStatusIds: new Set(["done"]) };
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1", stateId: "done" }, workflow).allowed, true);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1", stateId: "started" }, workflow).allowed, false);
  const aliases = initiative({ issueId: "uuid-1", issueIdentifier: "DEMO-1" }, "review");
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "DEMO-1", stateId: "done" }, { ...workflow, initiative: aliases }).allowed, true);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-2", stateId: "done" }, workflow).allowed, false);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1", title: "rewrite", stateId: "done" }, workflow).allowed, false);
  assert.equal(authorizeLinearTool("linear_create_comment", { issueId: "issue-1", body: "done" }, workflow).allowed, false);
  const approved = initiative({ issueId: "issue-1" });
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "issue-1", description: "approved contract" }, { ...workflow, initiative: approved }).allowed, true);
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

test("allows explicit issue administration only for named issues", () => {
  const aliases = collectLinearResourceAliases({ issues: [{ id: "uuid-1", identifier: "DEMO-41" }, { id: "uuid-2", identifier: "DEMO-42" }] });
  const context = { allowIssueAdmin: true, adminIssueRefs: new Set(["DEMO-41", "DEMO-42"]), resourceAliases: aliases };
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "uuid-1", priority: 1, addedLabelIds: ["label-1"] }, context).allowed, true);
  assert.equal(authorizeLinearTool("linear_update_issue", { issue: "OTHER-1", priority: 1 }, context).allowed, false);
  assert.equal(authorizeLinearTool("linear_create_issue_relation", { issueId: "DEMO-41", relatedIssueId: "uuid-2", type: "blocks" }, context).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_issue_relation", { issueId: "DEMO-41", relatedIssueId: "OTHER-1", type: "blocks" }, context).allowed, false);
  assert.equal(authorizeLinearTool("linear_create_issue_relation", { issueId: "DEMO-41", relatedIssueId: "DEMO-42", type: "delete" }, context).allowed, false);
});

test("allows create-only project publication with read-proven teams", () => {
  const aliases = collectLinearResourceAliases({ teams: [{ id: "team-uuid", key: "DEMO" }] });
  const args = { name: "Public roadmap", description: "Approved plan", teamIds: ["team-uuid"] };
  assert.equal(authorizeLinearTool("linear_save_project", args, { allowPlanProjectCreate: true, resourceAliases: aliases }).allowed, true);
  assert.equal(authorizeLinearTool("linear_save_project", { ...args, projectId: "existing" }, { allowPlanProjectCreate: true, resourceAliases: aliases }).allowed, false);
  assert.equal(authorizeLinearTool("linear_save_project", args, { resourceAliases: aliases }).allowed, false);
});

test("allows plan issues only in the newly created project", () => {
  const aliases = collectLinearResourceAliases({ teams: [{ id: "team-uuid", key: "DEMO" }] });
  const args = { teamId: "team-uuid", projectId: "new-project", title: "Milestone", description: "Scoped work" };
  const context = { allowPlanIssueCreate: true, planProjectIds: new Set(["new-project"]), resourceAliases: aliases };
  assert.equal(authorizeLinearTool("linear_create_issue", args, context).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_issue", { ...args, projectId: "other" }, context).allowed, false);
});

test("allows a direct tracking issue without an implementation contract", () => {
  const aliases = collectLinearResourceAliases({ teams: [{ id: "team-uuid", key: "DEMO" }], projects: [{ id: "project-uuid", name: "Public Launch" }] });
  const args = { teamId: "team-uuid", projectId: "project-uuid", title: "Track scheduler defect", description: "The scheduler retries too quickly." };
  assert.equal(authorizeLinearTool("linear_create_issue", args, { allowDirectIssueCreate: true, resourceAliases: aliases }).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_issue", args, { allowDirectIssueCreate: true }).allowed, false);
  assert.equal(authorizeLinearTool("linear_create_issue", { ...args, labelIds: ["extra"] }, { allowDirectIssueCreate: true, resourceAliases: aliases }).allowed, false);
});

test("allows read-proven canonical team/project IDs without contract reapproval", () => {
  const active = initiative({ team: "Demo Team" });
  active.contract!.linear.project = "Public Launch";
  const aliases = collectLinearResourceAliases({ teams: [{ id: "team-uuid", key: "DEMO", name: "Demo Team" }], projects: [{ id: "project-uuid", name: "Public Launch" }] });
  const args = { teamKey: "DEMO", projectId: "project-uuid", title: "Export report", description: "<!-- pi-contract:start -->approved<!-- pi-contract:end -->" };
  assert.equal(authorizeLinearTool("linear_create_issue", args, { initiative: active, allowCreateIssue: true, resourceAliases: aliases }).allowed, true);
  assert.equal(authorizeLinearTool("linear_create_issue", args, { initiative: active, allowCreateIssue: true }).allowed, false);
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
