import assert from "node:assert/strict";
import test from "node:test";
import { classifyApprovalIntent, extractLinearIssueIdentifiers, isCompletionDirective, isImplementationStartDirective, isLinearIssueAdminDirective, isLinearIssueCreateDirective, isLinearPlanPublishCancelDirective, isLinearPlanPublishDirective, normalizeApprovalText, restoreLinearPlanPublishIntent } from "../extensions/orchestration/approval.ts";

for (const phrase of [
  "Approve contract and start implementation",
  "  APPROVED, IMPLEMENT!!! ",
  "go ahead and implement.",
  "approve get it done",
  "approved — ship it",
  "mark it DONE!",
  "do it",
  "make it happen",
  "yes, proceed with it",
  "confirm lets proceed",
  "I confirm",
  "let's proceed",
]) {
  test(`accepts explicit approval: ${phrase.trim()}`, () => {
    assert.equal(classifyApprovalIntent(phrase), "explicit");
  });
}

test("normalizes case, surrounding whitespace, and punctuation", () => {
  assert.equal(normalizeApprovalText("  Approved, IMPLEMENT! "), "approved implement");
});

test("recognizes natural implementation start directives", () => {
  assert.equal(isImplementationStartDirective("ok lets start the implementation then"), true);
  assert.equal(isImplementationStartDirective("confirm lets proceed"), true);
  assert.equal(isImplementationStartDirective("retry"), false);
  assert.equal(isImplementationStartDirective("should we start implementation?"), false);
  assert.equal(isImplementationStartDirective("do not start implementation"), false);
});

test("accepts completion directives without magic wording", () => {
  assert.equal(isCompletionDirective("mark it done"), true);
  assert.equal(isCompletionDirective("can you mark it done?"), true);
  assert.equal(isCompletionDirective("ok lets update DEMO-38 on linear since it's already done then"), true);
  assert.equal(isCompletionDirective("set the issue to completed"), true);
  assert.equal(isCompletionDirective("move DEMO-38 to Done"), true);
  assert.equal(isCompletionDirective("change it to closed"), true);
  assert.equal(isCompletionDirective("should we mark it done?"), false);
  assert.equal(isCompletionDirective("do not mark it done"), false);
  assert.equal(isCompletionDirective("do not update it to done"), false);
});

test("recognizes direct Linear tracking requests without implementation ceremony", () => {
  assert.equal(isLinearIssueCreateDirective("open a bug in Linear"), true);
  assert.equal(isLinearIssueCreateDirective("please create the Linear issue"), true);
  assert.equal(isLinearIssueCreateDirective("ok so open the bug on linear please"), true);
  assert.equal(isLinearIssueCreateDirective("record this ticket"), true);
  assert.equal(isLinearIssueCreateDirective("should we open a bug?"), false);
  assert.equal(isLinearIssueCreateDirective("do not create an issue"), false);
});

test("recognizes explicit publication of a completed plan to Linear", () => {
  assert.equal(isLinearPlanPublishDirective("create this plan and translate it to Linear"), true);
  assert.equal(isLinearPlanPublishDirective("publish the roadmap into Linear"), true);
  assert.equal(isLinearPlanPublishDirective("create this project in Linear"), true);
  assert.equal(isLinearPlanPublishDirective("should we publish it to Linear?"), false);
  assert.equal(isLinearPlanPublishDirective("do not sync this plan to Linear"), false);
  assert.equal(restoreLinearPlanPublishIntent(["create this plan and translate it to Linear", "retry with the canonical IDs"]), true);
  assert.equal(restoreLinearPlanPublishIntent(["publish this plan into Linear", "ok lets start the implementation then"]), false);
  assert.equal(isLinearPlanPublishCancelDirective("cancel the Linear publication"), true);
  assert.equal(restoreLinearPlanPublishIntent(["publish the roadmap into Linear", "cancel the Linear publication", "retry"]), false);
});

test("recognizes explicit administration for named Linear issues", () => {
  assert.deepEqual(extractLinearIssueIdentifiers("Update DEMO-41 and demo-42; DEMO-41 blocks DEMO-43"), ["DEMO-41", "DEMO-42", "DEMO-43"]);
  assert.equal(isLinearIssueAdminDirective("apply the labels, high priority, and blockers"), true);
  assert.equal(isLinearIssueAdminDirective("yes apply both changes"), true);
  assert.equal(isLinearIssueAdminDirective("should we update the labels?"), false);
  assert.equal(isLinearIssueAdminDirective("do not update these issues"), false);
});

test("does not promote vague acknowledgements or negation to approval", () => {
  assert.equal(classifyApprovalIntent("ok"), "ambiguous");
  assert.equal(classifyApprovalIntent("looks good."), "ambiguous");
  assert.equal(classifyApprovalIntent("thanks"), "none");
  assert.equal(classifyApprovalIntent("do not approve this"), "none");
  assert.equal(classifyApprovalIntent("do not confirm this"), "none");
  assert.equal(classifyApprovalIntent("I do not want you to approve this"), "none");
  assert.equal(classifyApprovalIntent("can you approve and get it done?"), "explicit");
  assert.equal(classifyApprovalIntent("should we get it done?"), "none");
});
