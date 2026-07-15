import assert from "node:assert/strict";
import test from "node:test";
import { classifyApprovalIntent, normalizeApprovalText } from "../extensions/orchestration/approval.ts";

for (const phrase of [
  "Approve contract and start implementation",
  "  APPROVED, IMPLEMENT!!! ",
  "go ahead and implement.",
]) {
  test(`accepts explicit approval: ${phrase.trim()}`, () => {
    assert.equal(classifyApprovalIntent(phrase), "explicit");
  });
}

test("normalizes case, surrounding whitespace, and punctuation", () => {
  assert.equal(normalizeApprovalText("  Approved, IMPLEMENT! "), "approved implement");
});

test("does not promote vague acknowledgements to approval", () => {
  assert.equal(classifyApprovalIntent("ok"), "ambiguous");
  assert.equal(classifyApprovalIntent("looks good."), "ambiguous");
  assert.equal(classifyApprovalIntent("thanks"), "none");
});
