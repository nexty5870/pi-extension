import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LeadCoordinator } from "../extensions/lead/coordinator.ts";
import { effectiveWorkerPolicy, resolveWorkerPolicy } from "../extensions/lead/policy.ts";
import { WorkerRuntimeController } from "../extensions/lead/runtime.ts";
import { LeadStore } from "../extensions/lead/store.ts";
import type { ProjectRecord, TaskRecord } from "../extensions/lead/types.ts";

async function fixture(workers: ProjectRecord["workers"] = { idleReportGraceSeconds: 0 }): Promise<{ store: LeadStore; project: ProjectRecord; task: TaskRecord }> {
  const root = await mkdtemp(join(tmpdir(), "lead-runtime-"));
  const store = new LeadStore(join(root, "state"));
  const project = await store.ensureProject({ projectRoot: join(root, "repo"), projectName: "repo" });
  const configured = await store.saveProject({ ...project, workers });
  const at = new Date().toISOString();
  const task: TaskRecord = {
    schemaVersion: 2,
    id: "12345678-1234-1234-1234-123456789abc",
    projectId: project.projectId,
    role: "implementation",
    brief: { title: "Implement", task: "Do it", acceptanceCriteria: [] },
    status: "running",
    worktreePath: join(root, "repo"),
    sessionId: "12345678-1234-1234-1234-123456789abc",
    workerStartedAt: at,
    checks: [],
    runtime: { state: "starting" },
    createdAt: at,
    updatedAt: at,
  };
  await store.createTask(task);
  return { store, project: configured, task };
}

function context(usage?: { tokens: number; contextWindow: number; percent: number }) {
  const notifications: string[] = [];
  let shutdowns = 0;
  const ctx = {
    isIdle: () => true,
    shutdown: () => { shutdowns++; },
    getContextUsage: () => usage,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  return { ctx, notifications, shutdowns: () => shutdowns };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for runtime transition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("worker lifecycle is deterministic and reportless settling nudges once then wakes once", async () => {
  const { store, project, task } = await fixture();
  const sent: string[] = [];
  const fake = context();
  const runtime = new WorkerRuntimeController(store, project.projectId, task.id, (message) => sent.push(message));
  await runtime.start(fake.ctx);
  await runtime.agentStart(fake.ctx);
  assert.equal((await store.requireTask(project.projectId, task.id)).runtime?.state, "busy");
  await runtime.activity(fake.ctx);
  await runtime.settled(fake.ctx);
  await waitFor(() => sent.length === 1);
  assert.equal(sent.length, 1);
  assert.equal((await store.requireTask(project.projectId, task.id)).runtime?.reportNudgeState, "sent");
  await runtime.agentStart(fake.ctx);
  await runtime.settled(fake.ctx);
  await runtime.settled(fake.ctx);
  const attention = await store.requireTask(project.projectId, task.id);
  assert.equal(attention.runtime?.state, "needs-attention");
  assert.equal(attention.leadEvents?.filter((event) => event.kind === "runtime").length, 1);
  assert.match(attention.runtime?.attentionReason ?? "", /settled again/);
  await runtime.shutdown("reload");
});

test("coordinator running/blocked reports preserve agent-start baseline and produce zero reminder turns", async () => {
  const { store, project, task } = await fixture({ idleReportGraceSeconds: 0 });
  const sent: string[] = [];
  const fake = context();
  const runtime = new WorkerRuntimeController(store, project.projectId, task.id, (message) => sent.push(message));
  await runtime.start(fake.ctx);
  await runtime.agentStart(fake.ctx);
  const baseline = (await store.requireTask(project.projectId, task.id)).runtime?.reportBaselineAt;
  const coordinator = new LeadCoordinator(store, async () => ({ stdout: "", stderr: "", code: 0 }), { command: "pi", leadingArgs: [] });
  await coordinator.report(project.projectId, task.id, { status: "blocked", blockedReason: "Waiting safely", summary: "Valid nonterminal report" });
  const reported = await store.requireTask(project.projectId, task.id);
  assert.equal(reported.runtime?.reportBaselineAt, baseline);
  assert.ok(reported.runtime?.lastReportAt);
  await runtime.settled(fake.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 0);
  assert.equal((await store.requireTask(project.projectId, task.id)).runtime?.reportNudgeState, undefined);
  await runtime.shutdown("reload");
});

test("offline-without-handoff wakes once and shutdown cleanup is idempotent", async () => {
  const { store, project, task } = await fixture();
  const fake = context();
  const runtime = new WorkerRuntimeController(store, project.projectId, task.id, () => undefined);
  await runtime.start(fake.ctx);
  await runtime.shutdown("quit");
  await runtime.shutdown("quit");
  const offline = await store.requireTask(project.projectId, task.id);
  assert.equal(offline.runtime?.state, "offline");
  assert.equal(offline.leadEvents?.filter((event) => event.kind === "runtime").length, 1);
});

test("scheduled nudge recovers across reload and runtime heartbeats preserve semantic updatedAt", async () => {
  const { store, project, task } = await fixture();
  const originalUpdatedAt = task.updatedAt;
  await store.updateRuntime(project.projectId, task.id, (runtime) => ({
    ...runtime,
    reportNudgeState: "scheduled",
    reportNudgeAt: new Date(0).toISOString(),
  }));
  const sent: string[] = [];
  const fake = context();
  const runtime = new WorkerRuntimeController(store, project.projectId, task.id, (message) => sent.push(message));
  await runtime.start(fake.ctx);
  await waitFor(() => sent.length === 1);
  const restored = await store.requireTask(project.projectId, task.id);
  assert.equal(sent.length, 1);
  assert.equal(restored.updatedAt, originalUpdatedAt);
  assert.ok(restored.runtime?.lastHeartbeatAt);
  await runtime.shutdown("reload");
});

test("context warning and handoff thresholds fire once without semantic completion", async () => {
  const { store, project, task } = await fixture({ contextWarnPercent: 80, contextHandoffPercent: 92 });
  const sent: string[] = [];
  const fake = context({ tokens: 92_000, contextWindow: 100_000, percent: 92 });
  const runtime = new WorkerRuntimeController(store, project.projectId, task.id, (message) => sent.push(message));
  await runtime.start(fake.ctx);
  await runtime.activity(fake.ctx);
  const updated = await store.requireTask(project.projectId, task.id);
  assert.equal(updated.status, "running");
  assert.equal(updated.runtime?.contextPercent, 92);
  assert.equal(sent.length, 1);
  assert.equal(fake.notifications.length, 1);
  await runtime.shutdown("reload");
});

test("worker policy precedence is explicit > model > role > project > Lead and values clamp safely", () => {
  const timestamp = new Date().toISOString();
  const project: ProjectRecord = {
    schemaVersion: 2,
    projectId: "project-test",
    projectRoot: "/tmp/repo",
    projectName: "repo",
    workers: {
      default: { inheritModel: true, thinking: "low" },
      roles: { implementation: { thinking: "high" }, research: { model: "openai/gpt-5.6-sol", thinking: "high" } },
      models: [{ pattern: "openai/gpt-5.6-sol", thinking: "medium" }],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const lead = { model: "anthropic/lead", thinking: "xhigh" };
  assert.equal(resolveWorkerPolicy(project, { role: "implementation" }, lead).thinking, "high");
  const sol = resolveWorkerPolicy(project, { role: "research" }, lead);
  assert.equal(sol.model, "openai/gpt-5.6-sol");
  assert.equal(sol.provider, "openai");
  assert.equal(sol.modelId, "gpt-5.6-sol");
  assert.equal(sol.thinking, "medium");
  assert.equal(resolveWorkerPolicy(project, { role: "research", thinking: "minimal" }, lead).thinking, "minimal");
  assert.equal(resolveWorkerPolicy(project, { role: "research", thinking: "off" }, lead).thinking, "off");
  assert.equal(resolveWorkerPolicy({ ...project, workers: undefined }, { role: "review" }, lead).thinking, "xhigh");
  const bounded = effectiveWorkerPolicy({ maxVisibleSurfaces: 0, heartbeatSeconds: 0, contextWarnPercent: 99, contextHandoffPercent: 50 });
  assert.equal(bounded.maxVisibleSurfaces, 1);
  assert.equal(bounded.heartbeatSeconds, 1);
  assert.equal(bounded.contextHandoffPercent, 99);
});
