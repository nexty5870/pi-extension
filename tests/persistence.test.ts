import assert from "node:assert/strict";
import test from "node:test";
import { contractFromInput } from "../extensions/orchestration/contracts.ts";
import { approveContractLocally, planLinearPersistence } from "../extensions/orchestration/persistence.ts";

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

test("keeps optional Linear persistence when a destination is configured", () => {
  const createPlan = planLinearPersistence(contract({ team: "DEMO" }), approvedAt);
  assert.equal(createPlan?.toolName, "linear_create_issue");
  assert.equal(createPlan?.arguments.teamKey, "DEMO");

  const updatePlan = planLinearPersistence(contract({ issueId: "issue-123" }), approvedAt);
  assert.equal(updatePlan?.toolName, "linear_update_issue");
  assert.equal(updatePlan?.arguments.issue, "issue-123");
});
