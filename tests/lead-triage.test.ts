import assert from "node:assert/strict";
import test from "node:test";
import {
  leadStatusSummary,
  taskLine,
  TRIAGE_ACTION_DISMISS,
  TRIAGE_ACTION_MESSAGE,
  TRIAGE_ACTION_STOP,
  triageActions,
  triageDetail,
  truncateLine,
} from "../extensions/lead/triage.ts";
import type { TaskRecord, TaskStatus } from "../extensions/lead/types.ts";

function task(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: "12345678-1234-1234-1234-123456789abc",
    projectId: "project-test",
    role: "implementation",
    brief: { title: "Ship the feature", task: "Implement it", acceptanceCriteria: [] },
    status,
    worktreePath: "/tmp/repo",
    sessionId: "12345678-1234-1234-1234-123456789abc",
    checks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test("truncateLine collapses whitespace and clips long reasons", () => {
  assert.equal(truncateLine("short reason"), "short reason");
  assert.equal(truncateLine("line one\nline   two"), "line one line two");
  const clipped = truncateLine("x".repeat(200));
  assert.equal(clipped.length, 72);
  assert.ok(clipped.endsWith("…"));
});

test("taskLine surfaces truncated blocked reasons only for blocked/failed tasks", () => {
  const reason = `CI failed: ${"detail ".repeat(30)}`;
  const blocked = taskLine(task("blocked", { blockedReason: reason }));
  assert.ok(blocked.startsWith("! 12345678 blocked · Ship the feature — CI failed:"));
  assert.ok(blocked.length < 140);
  assert.ok(blocked.endsWith("…"));
  const failed = taskLine(task("failed", { failure: "launch script missing" }));
  assert.match(failed, /! 12345678 failed · Ship the feature — launch script missing/);
  assert.equal(taskLine(task("running", { blockedReason: "stale" })), "• 12345678 running · Ship the feature");
  assert.equal(taskLine(task("pr-ready-ci-green")), "✓ 12345678 pr-ready-ci-green · Ship the feature");
});

test("leadStatusSummary counts active, blocked, green, and pending events", () => {
  const tasks = [
    task("running"),
    task("running"),
    task("blocked", { blockedReason: "needs input" }),
    task("blocked", { blockedReason: "CI failed" }),
    task("pr-ready-ci-green"),
    task("completed"),
    task("merged"),
  ];
  assert.equal(leadStatusSummary(tasks, 3), "Lead · 5 active · 2 running · 2 blocked · 1 green · 3 events pending");
  assert.equal(leadStatusSummary(tasks, 1), "Lead · 5 active · 2 running · 2 blocked · 1 green · 1 event pending");
  assert.equal(leadStatusSummary(tasks, 0), "Lead · 5 active · 2 running · 2 blocked · 1 green");
  assert.equal(leadStatusSummary([], 0), "Lead · 0 active");
});

test("triage detail shows status, reason, summary, handoff, PR, and surface", () => {
  const detail = triageDetail(task("blocked", {
    blockedReason: "Waiting on the operator",
    summary: "Half of the work landed",
    handoff: "Pick up from the failing test",
    pullRequest: { url: "https://github.com/example/repo/pull/7", checks: [] },
    surface: { workspaceId: "workspace:2", paneId: "pane:1", surfaceId: "surface:10" },
  }));
  assert.match(detail, /12345678 · implementation · blocked/);
  assert.match(detail, /Blocked: Waiting on the operator/);
  assert.match(detail, /Summary: Half of the work landed/);
  assert.match(detail, /Handoff: Pick up from the failing test/);
  assert.match(detail, /PR: https:\/\/github\.com\/example\/repo\/pull\/7/);
  assert.match(detail, /Surface: surface:10/);
});

test("triage actions omit mark-stopped for terminal tasks", () => {
  assert.deepEqual(triageActions(task("blocked")), [TRIAGE_ACTION_MESSAGE, TRIAGE_ACTION_STOP, TRIAGE_ACTION_DISMISS, "Back"]);
  assert.deepEqual(triageActions(task("completed")), [TRIAGE_ACTION_MESSAGE, TRIAGE_ACTION_DISMISS, "Back"]);
});
