import assert from "node:assert/strict";
import test from "node:test";
import { deliveredLeadEventIds, pendingLeadEvents, workerEventMessage } from "../extensions/lead/events.ts";
import type { LeadTaskEvent, TaskRecord, TaskStatus } from "../extensions/lead/types.ts";

function task(status: TaskStatus, observed?: TaskStatus, leadEvents?: LeadTaskEvent[]): TaskRecord {
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
    leadEvents,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("legacy completed worker state becomes one durable Lead wake event", () => {
  const completed = task("completed", "running");
  const pending = pendingLeadEvents([completed]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].task, completed);
  assert.equal(pending[0].legacy, true);
  assert.deepEqual(pendingLeadEvents([{ ...completed, leadObservedStatus: "completed" }]), []);
  assert.deepEqual(pendingLeadEvents([task("running", "starting")]), []);
  const message = workerEventMessage(pending);
  assert.match(message, /Research finished/);
  assert.match(message, /delegate the next implementation or review step/);
  assert.match(message, /instead of waiting for another user prompt/);
});

test("persisted transitions remain ordered until each event is observed", () => {
  const timestamp = new Date().toISOString();
  const events: LeadTaskEvent[] = [
    { id: "blocked-event", kind: "status", status: "blocked", createdAt: timestamp, blockedReason: "Need input" },
    { id: "ready-event", kind: "status", status: "pr-ready-ci-pending", createdAt: new Date(Date.now() + 1).toISOString() },
  ];
  const pending = pendingLeadEvents([task("pr-ready-ci-pending", "running", events)]);
  assert.deepEqual(pending.map(({ event }) => event.id), ["blocked-event", "ready-event"]);
  const observed = events.map((event, index) => index === 0 ? { ...event, observedAt: timestamp } : event);
  assert.deepEqual(pendingLeadEvents([task("pr-ready-ci-pending", "running", observed)]).map(({ event }) => event.id), ["ready-event"]);
});

test("runtime Lead event headers render runtime truth instead of semantic running", () => {
  const timestamp = new Date().toISOString();
  const runtimeEvent: LeadTaskEvent = {
    id: "runtime-stale",
    kind: "runtime",
    status: "running",
    createdAt: timestamp,
    runtimeReasonKey: "stale:1",
    runtimeState: "stale",
    runtimeReason: "No deterministic heartbeat for 121s",
  };
  const message = workerEventMessage([{ task: task("running", "running", [runtimeEvent]), event: runtimeEvent, legacy: false }]);
  assert.match(message, /research · stale/);
  assert.match(message, /Runtime: No deterministic heartbeat for 121s/);
  assert.doesNotMatch(message, /research · running/);
});

test("session custom messages provide idempotent delivery receipts", () => {
  const ids = deliveredLeadEventIds([
    { type: "custom_message", customType: "lead:worker-event", details: { eventIds: ["event-1", "event-2"] } },
    { type: "custom_message", customType: "other", details: { eventIds: ["ignored"] } },
    { type: "custom", customType: "lead:worker-event", details: { eventIds: ["ignored-too"] } },
  ]);
  assert.deepEqual([...ids], ["event-1", "event-2"]);
});
