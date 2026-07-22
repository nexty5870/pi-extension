import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticLinearUpdateSafetyReason,
  isStartedLinearState,
  linearLifecycleAfterStatuses,
  linearLifecycleAfterToolResult,
  linearLifecycleHasPendingWriteScope,
  linearLifecycleIsActionable,
  linearLifecycleMutationSafetyReason,
  linearLifecycleNeedsQueuedLaunchPrompt,
  linearStartInstruction,
  normalizeLinearIssueReference,
  parseLinearIssueSnapshot,
  parseLinearWorkflowStates,
  linearStatusFilterTeamId,
  selectLinearStartedState,
} from "../extensions/lead/linear-lifecycle.ts";
import type { LinearLifecycleState, TaskRecord } from "../extensions/lead/types.ts";

const pending: LinearLifecycleState = {
  issueIdentifier: "APP-41",
  desiredStateType: "started",
  status: "pending",
  attempts: 0,
  updatedAt: new Date(0).toISOString(),
};

function taskWithLinear(linear: LinearLifecycleState = pending): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: "12345678-1234-1234-1234-123456789abc",
    projectId: "project-test",
    role: "implementation",
    brief: { title: "Implement issue", task: "Implement", acceptanceCriteria: [] },
    status: "running",
    worktreePath: "/tmp/worktree",
    sessionId: "12345678-1234-1234-1234-123456789abc",
    workerStartedAt: timestamp,
    checks: [],
    linear,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("Linear issue bindings accept exact identifiers and linear.app URLs only", () => {
  assert.equal(normalizeLinearIssueReference("app-41"), "APP-41");
  assert.equal(normalizeLinearIssueReference("https://linear.app/acme/issue/APP-41/title"), "APP-41");
  assert.equal(normalizeLinearIssueReference("APP-41 extra text"), undefined);
  assert.equal(normalizeLinearIssueReference("https://github.com/acme/repo/issues/41"), undefined);
});

test("Linear status evidence requires the canonical exact-team filter", () => {
  assert.equal(linearStatusFilterTeamId({ filter: { team: { id: { eq: "team-id" } } } }), "team-id");
  assert.equal(linearStatusFilterTeamId({ filter: { team: { id: "team-id" } } }), undefined);
  assert.equal(linearStatusFilterTeamId({ filter: { teamId: "team-id" } }), undefined);
  assert.equal(linearStatusFilterTeamId({ filter: { team: { id: { eq: "team-id" } }, state: { type: { eq: "started" } } } }), undefined);
  assert.equal(linearStatusFilterTeamId({ filter: { team: { id: { eq: "team-id" } } }, first: 1 }), undefined);
});

test("Linear workflow resolution is team-scoped and prefers an exact In Progress state", () => {
  const states = parseLinearWorkflowStates({ states: [
    { id: "review", name: "In Review", type: "started", position: 3, team: { id: "team-id" } },
    { id: "other", name: "In Progress", type: "started", position: 2, team: { id: "other-team" } },
    { id: "progress", name: "In Progress", type: "started", position: 1, team: { id: "team-id" } },
  ] }, []);
  assert.equal(selectLinearStartedState(states, "team-id")?.id, "progress");
  const resolved = linearLifecycleAfterStatuses({ ...pending, teamId: "team-id", issueObservedAt: new Date().toISOString() }, states);
  assert.equal(resolved.candidateStateId, "progress");
  assert.equal(resolved.candidateStateName, "In Progress");
  assert.equal(resolved.candidateTeamId, "team-id");
  assert.ok(resolved.candidateObservedAt);
});

test("Linear workflow resolution rejects status evidence older than the issue-team read", () => {
  const issueObservedAt = Date.now();
  const states = parseLinearWorkflowStates({ states: [
    { id: "progress", name: "In Progress", type: "started", team: { id: "team-id" } },
  ] }, []);
  const stale = linearLifecycleAfterStatuses({
    ...pending,
    teamId: "team-id",
    issueObservedAt: new Date(issueObservedAt).toISOString(),
  }, states, issueObservedAt - 1);
  assert.equal(stale.candidateStateId, undefined);
  assert.match(stale.lastError ?? "", /Read the Linear issue/);
});

test("Linear workflow resolution refuses ambiguous custom started states", () => {
  const states = parseLinearWorkflowStates({ states: [
    { id: "doing", name: "Doing", type: "started", team: { id: "team-id" } },
    { id: "review", name: "Review", type: "started", team: { id: "team-id" } },
  ] }, []);
  assert.equal(selectLinearStartedState(states, "team-id"), undefined);
  assert.match(linearLifecycleAfterStatuses({ ...pending, teamId: "team-id", issueObservedAt: new Date().toISOString() }, states).lastError ?? "", /No unambiguous/);
});

test("automatic Linear writes require the exact read-proven state and no unrelated fields", () => {
  const task = taskWithLinear({
    ...pending,
    candidateStateId: "progress",
    teamId: "team-id",
    issueObservedAt: new Date().toISOString(),
    candidateStateName: "In Progress",
    candidateTeamId: "team-id",
    candidateObservedAt: new Date().toISOString(),
  });
  assert.equal(automaticLinearUpdateSafetyReason([task], { issue: "APP-41", stateId: "progress" }), undefined);
  assert.match(automaticLinearUpdateSafetyReason([task], { issue: "APP-41", stateId: "other" }) ?? "", /read-proven/);
  assert.match(automaticLinearUpdateSafetyReason([task], { issue: "APP-41", stateId: "progress", title: "changed" }) ?? "", /only stateId/);
  assert.match(automaticLinearUpdateSafetyReason([taskWithLinear()], { issue: "APP-41", stateId: "progress" }) ?? "", /no single.*read-proven/);
  const stale = taskWithLinear({ ...task.linear!, candidateObservedAt: new Date(0).toISOString() });
  assert.match(automaticLinearUpdateSafetyReason([stale], { issue: "APP-41", stateId: "progress" }) ?? "", /again/);
  assert.match(automaticLinearUpdateSafetyReason([task], { issue: "OTHER-1", stateId: "other" }) ?? "", /unrelated/);
  assert.match(linearLifecycleMutationSafetyReason([task], "linear_create_issue", { title: "unrelated" }) ?? "", /only the bound issue/);
  const unavailable = taskWithLinear({ ...pending, status: "unavailable" });
  assert.equal(linearLifecycleMutationSafetyReason([unavailable], "linear_create_issue", { title: "normal admin" }), undefined);
  const claimed = taskWithLinear({ ...task.linear!, writeClaimId: "claim", writeClaimedAt: new Date().toISOString() });
  assert.match(linearLifecycleMutationSafetyReason([claimed], "linear_update_issue", { issue: "APP-41", stateId: "progress" }) ?? "", /in flight/);
  const verifying = taskWithLinear({ ...task.linear!, status: "verifying" });
  assert.match(linearLifecycleMutationSafetyReason([verifying], "linear_update_issue", { issue: "APP-41", stateId: "progress" }) ?? "", /readback/);
});

test("queued-to-running event retriggers Linear lifecycle exactly once after launch", () => {
  const running = taskWithLinear();
  const launched = {
    ...running,
    leadEvents: [{
      id: "queued-launch",
      kind: "runtime" as const,
      status: "running" as const,
      createdAt: new Date().toISOString(),
      runtimeReasonKey: `queued-launched:${running.id}`,
      runtimeState: "starting" as const,
    }],
  };
  assert.equal(linearLifecycleNeedsQueuedLaunchPrompt(launched), true);
  assert.equal(linearLifecycleNeedsQueuedLaunchPrompt({ ...launched, linear: { ...launched.linear!, queuedLaunchPromptedAt: new Date().toISOString() } }), false);
  assert.equal(linearLifecycleNeedsQueuedLaunchPrompt(running), false);
});

test("Linear lifecycle is actionable only after a durable nonterminal worker start", () => {
  const running = taskWithLinear();
  assert.equal(linearLifecycleIsActionable(running), true);
  assert.equal(linearLifecycleIsActionable({ ...running, workerStartedAt: undefined, status: "failed" }), false);
  assert.equal(linearLifecycleIsActionable({ ...running, status: "stopped" }), false);
  assert.equal(linearLifecycleIsActionable({ ...running, status: "completed" }), false);
  assert.equal(linearLifecycleHasPendingWriteScope(running), true);
  assert.equal(linearLifecycleHasPendingWriteScope(taskWithLinear({ ...pending, status: "unavailable" })), false);
});

test("a fresh issue read clears state evidence from an earlier team", () => {
  const current: LinearLifecycleState = {
    ...pending,
    teamId: "team-a",
    issueObservedAt: new Date().toISOString(),
    candidateStateId: "state-a",
    candidateStateName: "In Progress",
    candidateTeamId: "team-a",
    candidateObservedAt: new Date().toISOString(),
  };
  const changed = linearLifecycleAfterToolResult(current, "linear_get_issue", {
    identifier: "APP-41",
    team: { id: "team-b" },
    state: { id: "backlog-b", name: "Backlog", type: "backlog" },
  }, false);
  assert.equal(changed.teamId, "team-b");
  assert.equal(changed.candidateStateId, undefined);
  assert.equal(changed.candidateTeamId, undefined);
});

test("Linear lifecycle requires update followed by started-state readback", () => {
  const snapshot = parseLinearIssueSnapshot({
    issue: {
      id: "issue-id",
      identifier: "APP-41",
      state: { id: "state-id", name: "In Progress", type: "started" },
      team: { id: "team-id", key: "APP", name: "Application" },
    },
  }, []);
  assert.equal(snapshot?.identifier, "APP-41");
  assert.equal(isStartedLinearState(snapshot?.state), true);

  const observed = linearLifecycleAfterToolResult(pending, "linear_get_issue", {
    ...snapshot!,
    state: { id: "backlog", name: "Backlog", type: "backlog" },
  }, false);
  assert.equal(observed.issueId, "issue-id");
  assert.equal(observed.teamId, "team-id");
  const afterWrite = linearLifecycleAfterToolResult(observed, "linear_update_issue", snapshot, false);
  assert.equal(afterWrite.status, "verifying");
  assert.equal(afterWrite.attempts, 1);
  const afterReadback = linearLifecycleAfterToolResult(afterWrite, "linear_get_issue", snapshot, false);
  assert.equal(afterReadback.status, "in-progress");
  assert.equal(afterReadback.stateId, "state-id");
  assert.equal(afterReadback.stateName, "In Progress");

  const staleReadback = linearLifecycleAfterToolResult(afterWrite, "linear_get_issue", {
    ...snapshot!,
    state: { id: "backlog", name: "Backlog", type: "backlog" },
  }, false);
  assert.equal(staleReadback.status, "pending");
  assert.match(staleReadback.lastError ?? "", /did not confirm/);
});

test("Linear lifecycle failures remain pending and retryable", () => {
  const failed = linearLifecycleAfterToolResult(pending, "linear_update_issue", undefined, true, "schema rejected");
  assert.equal(failed.status, "pending");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError, "schema rejected");
});

test("Linear start instruction is scoped, canonical, and readback-bound", () => {
  const instruction = linearStartInstruction(taskWithLinear());
  assert.match(instruction, /linear_get_issue/);
  assert.match(instruction, /linear_list_issue_statuses/);
  assert.match(instruction, /linear_update_issue/);
  assert.match(instruction, /only this issue with only the read-proven stateId/);
  assert.match(instruction, /returned state has type `started`/);
});
