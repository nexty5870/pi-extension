import assert from "node:assert/strict";
import test from "node:test";
import { contractFromInput } from "../extensions/orchestration/contracts.ts";
import { approveContractLocally, normalizeApprovedIssueCreateArguments, planLinearPersistence } from "../extensions/orchestration/persistence.ts";

function contract(linear?: { team?: string; issueId?: string }) {
  return contractFromInput({
    kind: "feature",
    title: "Reminder preferences",
    linear,
    outcome: "Let users choose reminder timing.",
    context: "Reminder timing is currently fixed.",
    inScope: ["Timing preference"],
    acceptanceCriteria: ["Preference controls reminder timing"],
    validation: ["Unit tests"],
  });
}

const approvedAt = "2026-01-01T00:00:00.000Z";

test("approves local-only contracts without planning a Linear contact", () => {
  const local = contract();
  const approved = approveContractLocally(local, approvedAt);
  assert.equal(approved.source, "local");
  assert.equal(approved.linearPersistence, "not-configured");
  assert.equal(planLinearPersistence(local, approvedAt), undefined);
});

test("normalizes proposed pi-linear creation to the exact approved managed payload", () => {
  const value = contract({ team: "DEMO" });
  const normalized = normalizeApprovedIssueCreateArguments(value, approvedAt, {
    input: { teamId: "team-uuid", projectId: "project-uuid", title: "wrong", description: "missing markers", priority: 1 },
    title: "also wrong",
    labelIds: ["unapproved"],
  });
  assert.deepEqual(Object.keys(normalized).sort(), ["description", "projectId", "teamId", "title"]);
  assert.equal(normalized.title, value.title);
  assert.equal(normalized.teamId, "team-uuid");
  assert.equal(normalized.projectId, "project-uuid");
  assert.match(String(normalized.description), /<!-- pi-contract:start -->/);
  assert.match(String(normalized.description), /<!-- pi-contract:end -->/);
  assert.doesNotMatch(String(normalized.description), /missing markers|also wrong/);
});

test("keeps optional Linear persistence when a destination is configured", () => {
  const createPlan = planLinearPersistence(contract({ team: "DEMO" }), approvedAt);
  assert.equal(createPlan?.toolName, "linear_create_issue");
  assert.equal(createPlan?.arguments.teamKey, "DEMO");
  const unresolved = planLinearPersistence(contractFromInput({
    kind: "feature", title: "Named destination", linear: { team: "Demo Team", project: "Public Launch" },
    outcome: "Resolve IDs", context: "Names are human-friendly", inScope: ["Issue"], acceptanceCriteria: ["Created"], validation: ["Test"],
  }), approvedAt);
  assert.equal(unresolved?.arguments.teamKey, undefined);
  assert.equal(unresolved?.arguments.projectId, undefined);
  assert.deepEqual(unresolved?.destination, { team: "Demo Team", project: "Public Launch" });

  const updatePlan = planLinearPersistence(contract({ issueId: "issue-123" }), approvedAt);
  assert.equal(updatePlan?.toolName, "linear_update_issue");
  assert.equal(updatePlan?.arguments.issue, "issue-123");
});
