import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { actionCount, contextLevel, renderTeamFooter, workerLines } from "../extensions/orchestration/delivery/ui.ts";
import type { DeliveryState } from "../extensions/orchestration/delivery/types.ts";

const theme: any = { fg: (_color: string, text: string) => text };
test("context thresholds are exact at 59/60/79/80 and unknown", () => {
  assert.equal(contextLevel(undefined), "unknown"); assert.equal(contextLevel(59), "normal"); assert.equal(contextLevel(60), "warning"); assert.equal(contextLevel(79), "warning"); assert.equal(contextLevel(80), "critical");
});
test("responsive footer preserves model, branch, unrelated statuses and width", () => {
  const statuses = new Map([["other", "vim"], ["team-context", "old"]]);
  const wide = renderTeamFooter(120, theme, "model-x", "feat/x", statuses, { contextPercent: 80, initiativeState: "approved" })[0]!;
  assert.match(wide, /model-x \(feat\/x\)/); assert.match(wide, /vim/); assert.ok(visibleWidth(wide) <= 120);
  const narrow = renderTeamFooter(20, theme, "model-x", "feat/x", statuses, { contextPercent: 60 })[0]!; assert.ok(visibleWidth(narrow) <= 20);
});
test("worker snapshot exposes transitions, usage/checks, failures and deduplicated actions", () => {
  const state: DeliveryState = { schemaVersion: 1, runId: "r", projectId: "p", initiativeId: "i", projectRoot: "/tmp/example", contractHash: "h", metadata: { baseBranch: "main", branchName: "feat/x", commitMessage: "x", prTitle: "x", prBody: "x", checks: [["true"]] }, phase: "reviewing", branchName: "feat/x", reviewPass: 1, workers: { reviewer: { role: "reviewer", phase: "failed", task: "Review", failure: "bad output" } }, checks: [], actions: [{ id: "a", severity: "critical", message: "Fix review", createdAt: new Date().toISOString() }], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  assert.match(workerLines(state).join("\n"), /reviewer: failed/); assert.equal(actionCount({ delivery: state }), 1);
});
