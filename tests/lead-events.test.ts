import assert from "node:assert/strict";
import test from "node:test";
import { pendingLeadEvents, workerEventMessage } from "../extensions/lead/events.ts";
import type { TaskRecord, TaskStatus } from "../extensions/lead/types.ts";

function task(status: TaskStatus, observed?: TaskStatus): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: "12345678-1234-1234-1234-123456789abc",
    projectId: "project-test",
    role: "research",
    brief: { title: "Inspect tests", task: "Inspect only", acceptanceCriteria: [] },
    status,
    leadObservedStatus: observed,
    summary: "Research finished with exact file references.",
    handoff: "Use the focused test file for the next implementation worker.",
    worktreePath: "/tmp/repo",
    sessionId: "12345678-1234-1234-1234-123456789abc",
    checks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("completed worker state becomes one durable Lead wake event", () => {
  const completed = task("completed", "running");
  assert.deepEqual(pendingLeadEvents([completed]), [completed]);
  assert.deepEqual(pendingLeadEvents([{ ...completed, leadObservedStatus: "completed" }]), []);
  assert.deepEqual(pendingLeadEvents([task("running", "starting")]), []);
  const message = workerEventMessage([completed]);
  assert.match(message, /Research finished/);
  assert.match(message, /delegate the next implementation or review step/);
  assert.match(message, /instead of waiting for another user prompt/);
});
