import assert from "node:assert/strict";
import test from "node:test";
import { classifyApprovalIntent, isCompletionDirective, isLinearIssueCreateDirective, normalizeApprovalText } from "../extensions/orchestration/approval.ts";

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
]) {
  test(`accepts explicit approval: ${phrase.trim()}`, () => {
    assert.equal(classifyApprovalIntent(phrase), "explicit");
  });
}

test("normalizes case, surrounding whitespace, and punctuation", () => {
  assert.equal(normalizeApprovalText("  Approved, IMPLEMENT! "), "approved implement");
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

test("does not promote vague acknowledgements or negation to approval", () => {
  assert.equal(classifyApprovalIntent("ok"), "ambiguous");
  assert.equal(classifyApprovalIntent("looks good."), "ambiguous");
  assert.equal(classifyApprovalIntent("thanks"), "none");
  assert.equal(classifyApprovalIntent("do not approve this"), "none");
  assert.equal(classifyApprovalIntent("I do not want you to approve this"), "none");
  assert.equal(classifyApprovalIntent("can you approve and get it done?"), "explicit");
  assert.equal(classifyApprovalIntent("should we get it done?"), "none");
});
