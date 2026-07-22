import assert from "node:assert/strict";
import test from "node:test";
import {
  leadStatusSummary,
  taskLine,
  TRIAGE_ACTION_CLOSE_ELIGIBLE,
  TRIAGE_ACTION_DISMISS,
  TRIAGE_ACTION_HANDOFF,
  TRIAGE_ACTION_MESSAGE,
  TRIAGE_ACTION_RESUME,
  TRIAGE_ACTION_RETIRE,
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
  assert.ok(blocked.startsWith("! 12345678 implementation · unknown · Ship the feature — CI failed:"));
  assert.ok(blocked.length < 140);
  assert.ok(blocked.endsWith("…"));
  const failed = taskLine(task("failed", { failure: "launch script missing" }));
  assert.match(failed, /! 12345678 implementation · unknown · Ship the feature — launch script missing/);
  assert.equal(taskLine(task("running", { blockedReason: "stale", runtime: { state: "idle" } })), "◌ 12345678 implementation · idle · Ship the feature");
  assert.equal(taskLine(task("running", { runtime: { state: "busy", contextPercent: 52 } })), "● 12345678 implementation · busy · ctx 52% · Ship the feature");
  assert.match(taskLine(task("running", { runtime: { state: "idle" }, resolvedWorker: { model: "openai/gpt-5.6-sol", thinking: "medium" } })), /openai\/gpt-5\.6-sol\/medium/);
  assert.match(taskLine(task("running", { runtime: { state: "stale", attentionReason: "heartbeat missing" } })), /^! .*stale.*heartbeat missing/);
});

test("leadStatusSummary counts active, blocked, green, and pending events", () => {
  const tasks = [
    task("running", { runtime: { state: "busy" } }),
    task("running", { runtime: { state: "idle" } }),
    task("blocked", { blockedReason: "needs input" }),
    task("blocked", { blockedReason: "CI failed" }),
    task("pr-ready-ci-green"),
    task("completed"),
    task("merged"),
  ];
  assert.equal(leadStatusSummary(tasks, 3), "Lead · 5 active · 1 busy · 2 blocked · 1 green · 3 events pending");
  assert.equal(leadStatusSummary(tasks, 1), "Lead · 5 active · 1 busy · 2 blocked · 1 green · 1 event pending");
  assert.equal(leadStatusSummary(tasks, 0), "Lead · 5 active · 1 busy · 2 blocked · 1 green");
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
  assert.match(detail, /12345678 · implementation · semantic blocked · runtime unknown/);
  assert.match(detail, /Blocked: Waiting on the operator/);
  assert.match(detail, /Summary: Half of the work landed/);
  assert.match(detail, /Handoff: Pick up from the failing test/);
  assert.match(detail, /PR: https:\/\/github\.com\/example\/repo\/pull\/7/);
  assert.match(detail, /Surface: surface:10/);
});

test("triage actions state mutation scope and omit graceful stop for terminal tasks", () => {
  const active = triageActions(task("blocked"));
  assert.deepEqual(active, [TRIAGE_ACTION_MESSAGE, TRIAGE_ACTION_HANDOFF, TRIAGE_ACTION_RESUME, TRIAGE_ACTION_STOP, TRIAGE_ACTION_CLOSE_ELIGIBLE, TRIAGE_ACTION_DISMISS, "Back"]);
  const terminal = triageActions(task("completed"));
  assert.equal(terminal.includes(TRIAGE_ACTION_STOP), false);
  assert.ok(terminal.includes(TRIAGE_ACTION_RESUME));
  const offlineSurface = triageActions(task("completed", {
    surface: { workspaceId: "workspace:1", paneId: "pane:1", surfaceId: "surface:1" },
    runtime: { state: "offline", surfaceHealth: "healthy" },
  }));
  assert.ok(offlineSurface.includes(TRIAGE_ACTION_RETIRE));
  assert.equal(offlineSurface.includes(TRIAGE_ACTION_RESUME), false);
  assert.ok(terminal.every((action) => action === "Back" || action.includes("(") || action.startsWith("Resume")));
});
