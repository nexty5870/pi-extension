import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V4RuntimeAdapter } from "../extensions/lead-v4/runtime-adapter.ts";
import { V4Store } from "../extensions/lead-v4/store.ts";
import { V4SupervisorCore } from "../extensions/lead-v4/supervisor.ts";
import type { CommandExecutor } from "../extensions/lead/git.ts";
import type { LeadAttachment, StableCmuxIdentity } from "../extensions/lead-v4/types.ts";

const models = ["openai/gpt-5.6-sol", "anthropic/claude-opus-4-6", "google/gemini-3-pro"];

function identity(index: number, workspace = "22222222-2222-4222-8222-222222222222"): StableCmuxIdentity {
  const suffix = String(index).padStart(12, "0");
  return {
    windowUuid: "11111111-1111-4111-8111-111111111111",
    workspaceUuid: workspace,
    paneUuid: "33333333-3333-4333-8333-333333333333",
    surfaceUuid: `44444444-4444-4444-8444-${suffix}`,
    workspaceRef: `workspace:${index}`,
    paneRef: `pane:${index}`,
    surfaceRef: `surface:${index}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-core-"));
  const projectRoot = join(root, "repo");
  const store = new V4Store(join(root, "state"), projectRoot);
  await store.initialize(projectRoot, "repo", {
    maxConcurrentLeads: 3,
    maxConcurrentWorkerProcesses: 2,
    attachmentLeaseSeconds: 5,
    automaticWorkerSurfaceRetirement: false,
    roles: { review: { model: "anthropic/claude-opus-4-6", thinking: "medium" } },
  });
  await store.beginSupervisorGeneration();
  const core = new V4SupervisorCore(store, join(root, "state"));
  const leads: LeadAttachment[] = [];
  for (let index = 1; index <= 3; index++) {
    const result = await core.attach({
      sessionId: `lead-session-${index}`,
      clientIncarnation: `lead-incarnation-${index}`,
      sessionGeneration: 1,
      pid: 100 + index,
      cmux: identity(index),
      model: models[index - 1],
      thinking: index === 1 ? "xhigh" : "high",
      availableModels: models,
    });
    leads.push(result.attachment);
  }
  return { root, projectRoot, store, core, leads };
}

function featureInput(lead: LeadAttachment, operation: string, index: number) {
  return {
    attachmentId: lead.id,
    ownershipToken: lead.ownershipToken,
    clientOperationId: operation,
    title: `Feature ${index}`,
    task: `Implement independent feature ${index}`,
    issue: `ENG-${index}`,
    acceptanceCriteria: [`Feature ${index} works`],
  };
}

test("V2 import is a one-time read-only hashed snapshot and never resume-authorized", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-legacy-"));
  const projectRoot = join(root, "repo");
  const store = new V4Store(join(root, "state"), projectRoot);
  const legacyDirectory = join(store.projectDirectory, "tasks", "legacy-task");
  await mkdir(legacyDirectory, { recursive: true });
  const source = `${JSON.stringify({ schemaVersion: 2, id: "legacy-task", status: "running", worktreePath: "/tmp/legacy", surface: { surfaceId: "surface:12" } }, null, 2)}\n`;
  const path = join(legacyDirectory, "task.json");
  await writeFile(path, source);
  const state = await store.initialize(projectRoot, "repo");
  assert.equal(state.legacyV2.length, 1);
  assert.equal(state.legacyV2[0].resumeAllowed, false);
  assert.equal(state.legacyV2[0].sourceHash, createHash("sha256").update(source).digest("hex"));
  assert.equal(await readFile(path, "utf8"), source);
  await writeFile(path, source.replace("running", "completed"));
  assert.equal((await store.initialize(projectRoot, "repo")).legacyV2[0].sourceHash, state.legacyV2[0].sourceHash);
});

test("three Leads attach concurrently, own separate tracks, and same-issue races reuse exactly", async () => {
  const { core, leads } = await fixture();
  const tracks = await Promise.all(leads.map((lead, index) => core.createFeature(featureInput(lead, `feature-${index}`, index + 1))));
  assert.equal(new Set(tracks.map((track) => track.id)).size, 3);
  assert.deepEqual(tracks.map((track) => track.ownerAttachmentId), leads.map((lead) => lead.id));

  const race = await Promise.all([
    core.createFeature({ ...featureInput(leads[0], "same-issue-a", 90), issue: "ENG-99" }),
    core.createFeature({ ...featureInput(leads[1], "same-issue-b", 91), issue: "eng-99" }),
  ]);
  assert.equal(race[0].id, race[1].id);
  const retry = await core.createFeature({ ...featureInput(leads[0], "same-issue-a", 900), issue: "ENG-99" });
  assert.equal(retry.id, race[0].id);

  const queuedLead = await core.createFeature({ ...featureInput(leads[0], "spawned-lead", 200), spawnLead: true });
  assert.equal(queuedLead.leadLaunchState, "queued");
  assert.equal((await core.tick()).leads.length, 0, "three attached Leads consume the separate Lead-process limit");
  await core.detach(leads[2].id, leads[2].ownershipToken);
  assert.equal((await core.tick()).leads.map((feature) => feature.id).includes(queuedLead.id), true);

  await core.createFeature({ ...featureInput(leads[0], "goal-one", 100), issue: undefined, title: "Natural goal" });
  await assert.rejects(
    () => core.createFeature({ ...featureInput(leads[0], "goal-two", 101), issue: undefined, title: "Natural goal" }),
    /Possible existing feature.*choose existingFeatureId or duplicateChoice=new/,
  );
});

test("direct Lead attachment refuses over-capacity without mutating durable state", async () => {
  const { core, leads, store } = await fixture();
  const before = await store.read();
  await assert.rejects(() => core.attach({
    sessionId: "lead-session-4",
    clientIncarnation: "lead-incarnation-4",
    sessionGeneration: 1,
    pid: 104,
    cmux: identity(4),
    model: models[0],
    thinking: "high",
    availableModels: models,
  }), /Lead capacity is full \(3\)/);
  const after = await store.read();
  assert.equal(Object.values(after.attachments).filter((attachment) => attachment.state === "attached").length, 3);
  assert.equal(Object.values(after.attachments).some((attachment) => attachment.sessionId === "lead-session-4"), false);
  assert.equal(after.updatedAt, before.updatedAt, "a refused attachment does not rewrite durable state");

  const refreshed = await core.attach({
    attachmentId: leads[0].id,
    attachmentOwnershipToken: leads[0].ownershipToken,
    sessionId: leads[0].sessionId,
    clientIncarnation: "same-attached-lead-refresh",
    sessionGeneration: leads[0].sessionGeneration,
    pid: leads[0].pid,
    cmux: leads[0].cmux,
    model: models[0],
    thinking: "xhigh",
    availableModels: models,
  });
  assert.equal(refreshed.attachment.id, leads[0].id);
});

test("concurrent feature implementations have distinct task, branch, worktree, ownership, and cursor identities", async () => {
  const { core, leads } = await fixture();
  const features = await Promise.all(leads.slice(0, 2).map((lead, index) => core.createFeature(featureInput(lead, `feature-${index}`, index + 1))));
  const tasks = await Promise.all(features.map((feature, index) => core.createTask({
    attachmentId: leads[index].id,
    ownershipToken: leads[index].ownershipToken,
    clientOperationId: `implementation-${index}`,
    featureId: feature.id,
    role: "implementation",
    title: `Implementation ${index}`,
    task: "Build independently",
  })));
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.notEqual(tasks[0].branchName, tasks[1].branchName);
  assert.notEqual(tasks[0].worktreePath, tasks[1].worktreePath);
  assert.notEqual(features[0].ownershipToken, features[1].ownershipToken);
  assert.notEqual(features[0].eventCursors, features[1].eventCursors);
});

test("feature tasks are distinct/idempotent, reviews share only their parent worktree, and models resolve per role", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const implementation = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "implementation-one",
    featureId: feature.id,
    role: "implementation",
    title: "Implement one",
    task: "Build it",
    selection: { model: "openai/gpt-5.6-sol", thinking: "high" },
  });
  const same = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "implementation-retry",
    featureId: feature.id,
    role: "implementation",
    title: "Implement one",
    task: "Build it again",
  });
  assert.equal(same.id, implementation.id);
  assert.match(implementation.branchName ?? "", new RegExp(implementation.id.slice(0, 8)));

  const research = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "research",
    featureId: feature.id,
    role: "research",
    title: "Research one",
    task: "Inspect it",
    selection: { model: "google/gemini-3-pro", thinking: "off" },
  });
  const review = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "review",
    featureId: feature.id,
    role: "review",
    parentTaskId: implementation.id,
    title: "Review one",
    task: "Review it",
    // Explicit reviewer diversity is supported, not silently invented.
    selection: { model: "anthropic/claude-opus-4-6", thinking: "medium" },
  });
  assert.notEqual(research.id, implementation.id);
  assert.equal(research.worktreePath.endsWith("repo"), true);
  assert.equal(review.worktreePath, implementation.worktreePath);
  assert.equal(review.resolved.requestedModel, "anthropic/claude-opus-4-6");
  assert.equal(review.resolved.model.source, "explicit-operator");
});

test("a root owning Lead is always the spawning-Lead policy source", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature({
    ...featureInput(leads[0], "root-spawning-policy", 77),
    preset: { model: "google/gemini-3-pro", thinking: "minimal" },
  });
  const task = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "root-spawned-worker",
    featureId: feature.id,
    role: "implementation",
    title: "Root-spawned implementation",
    task: "Prove spawning precedence",
  });
  assert.equal(task.resolved.requestedModel, "openai/gpt-5.6-sol");
  assert.equal(task.resolved.requestedThinking, "xhigh");
  assert.equal(task.resolved.model.source, "spawning-lead");
  assert.equal(task.resolved.thinking.source, "spawning-lead");
});

test("review verdict is bound to exact parent diff/HEAD/check target and acceptance matrix", async () => {
  const { core, store, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const implementation = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "implementation",
    featureId: feature.id,
    role: "implementation",
    title: "Implement reviewed work",
    task: "Build",
  });
  await store.update((state) => ({
    ...state,
    tasks: { ...state.tasks, [implementation.id]: { ...state.tasks[implementation.id], status: "pr-ready-ci-pending", processState: "offline", checks: [{ name: "npm test", status: "passed" }] } },
  }));
  const review = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "review",
    featureId: feature.id,
    role: "review",
    parentTaskId: implementation.id,
    title: "Review exact work",
    task: "Review",
  });
  await core.tick();
  const target = {
    parentTaskId: implementation.id,
    diffHash: "diff-hash",
    headSha: "head-sha",
    checksHash: createHash("sha256").update(JSON.stringify([{ name: "npm test", status: "passed" }])).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
  await core.recordReviewTarget(review.id, target);
  await assert.rejects(() => core.report({
    taskId: review.id,
    ownershipToken: review.runtime.ownershipToken,
    sessionGeneration: 1,
    review: { verdict: "approved", findings: [], acceptance: [], diffHash: target.diffHash, headSha: target.headSha, checksHash: target.checksHash },
  }), /acceptance matrix is missing/);
  await core.report({
    taskId: review.id,
    ownershipToken: review.runtime.ownershipToken,
    sessionGeneration: 1,
    review: {
      verdict: "approved",
      findings: [],
      acceptance: implementation.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: "exact diff and passing test" })),
      diffHash: target.diffHash,
      headSha: target.headSha,
      checksHash: target.checksHash,
    },
  });
  assert.equal((await core.status()).tasks.find((task) => task.id === implementation.id)?.review?.verdict, "approved");
});

test("fair scheduling is track round-robin and launching/UNKNOWN conservatively consume process capacity", async () => {
  const { core, store, leads } = await fixture();
  const features = await Promise.all(leads.map((lead, index) => core.createFeature(featureInput(lead, `feature-${index}`, index + 1))));
  for (let index = 0; index < features.length; index++) {
    await core.createTask({
      attachmentId: leads[index].id,
      ownershipToken: leads[index].ownershipToken,
      clientOperationId: `task-${index}`,
      featureId: features[index].id,
      role: "research",
      title: `Research ${index}`,
      task: "Inspect",
    });
  }
  const first = await core.tick();
  assert.equal(first.workers.length, 2);
  assert.deepEqual(new Set(first.workers.map((task) => task.featureId)).size, 2);
  await core.markLaunchUnknown(first.workers[0].id, "crash after cmux create before hello");
  const second = await core.tick();
  assert.equal(second.workers.length, 0, "UNKNOWN + launching conservatively use both process slots");
  const snapshot = await core.status();
  assert.equal(snapshot.tasks.filter((task) => task.processState === "queued").length, 1);
  assert.equal(snapshot.config.automaticWorkerSurfaceRetirement, false);
  assert.ok((await store.read()).events.some((event) => /Duplicate launch.*forbidden/.test(event.summary)));
});

test("stop atomically cancels queued work so it is never schedulable", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "stop-queued-feature", 301));
  const task = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "stop-queued-task",
    featureId: feature.id,
    role: "research",
    title: "Cancel before schedule",
    task: "Must never launch",
  });
  const stopped = await core.stopTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    taskId: task.id,
    reason: "No longer needed",
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.processState, "stopped");
  assert.notEqual(stopped.runtime.ownershipToken, task.runtime.ownershipToken);
  assert.equal((await core.tick()).workers.some((candidate) => candidate.id === task.id), false);
});

test("stop fences and aborts a launching worker saga before it can send a launch", async () => {
  const { core, leads, root, store } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "stop-launching-feature", 302));
  const task = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "stop-launching-task",
    featureId: feature.id,
    role: "research",
    title: "Cancel during launch",
    task: "Must not continue",
  });
  const scheduled = await core.tick();
  const agents = identity(70);
  await core.recordAgentsWorkspace({
    ownershipToken: "agents-stop-token",
    sessionGeneration: 1,
    windowUuid: agents.windowUuid,
    workspaceUuid: agents.workspaceUuid,
    paneUuid: agents.paneUuid,
    createdAt: new Date().toISOString(),
  });
  const adapter = new V4RuntimeAdapter(join(root, "artifacts"));
  let enteredSurface!: () => void;
  const surfaceStarted = new Promise<void>((resolveStarted) => { enteredSurface = resolveStarted; });
  const commands: string[] = [];
  const controlled: CommandExecutor = async (_command, args, options) => {
    const operation = args.find((arg) => arg === "new-surface" || arg === "send" || arg === "send-key") ?? "other";
    commands.push(operation);
    if (operation === "new-surface") {
      enteredSurface();
      return new Promise((resolveCommand) => {
        const aborted = () => resolveCommand({ stdout: "", stderr: "aborted", code: 1, killed: true });
        if (options.signal?.aborted) aborted();
        else options.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    return { stdout: "", stderr: "unexpected launch continuation", code: 1 };
  };
  (adapter as unknown as { execute: CommandExecutor }).execute = controlled;
  const launch = adapter.launchWorker(await store.read(), scheduled.workers[0], core);
  await surfaceStarted;
  const stopped = await core.stopTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    taskId: task.id,
    reason: "Race stop",
  });
  adapter.abortWorkerLaunch(task.id);
  await launch;
  assert.deepEqual(commands, ["new-surface"]);
  assert.equal(stopped.processState, "stopped");
  const durable = (await core.status()).tasks.find((candidate) => candidate.id === task.id)!;
  assert.equal(durable.processState, "stopped");
  await assert.rejects(() => core.workerHello({
    taskId: task.id,
    ownershipToken: task.runtime.ownershipToken,
    sessionGeneration: task.runtime.sessionGeneration,
    sessionId: task.sessionId,
    processIncarnation: "stale-launch",
    pid: 700,
    cmux: identity(71),
    actualModel: task.resolved.requestedModel,
    actualThinking: task.resolved.requestedThinking,
  }), /launch\/generation\/token\/session fencing/);
});

test("reload transfers tracks only to a fresh incarnation of the same detached Pi session and fences stale callbacks", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  await core.detach(leads[0].id, leads[0].ownershipToken);
  const replacement = await core.attach({
    sessionId: leads[0].sessionId,
    clientIncarnation: "reload-incarnation",
    sessionGeneration: 1,
    pid: 999,
    cmux: identity(40),
    model: "openai/gpt-5.6-sol",
    thinking: "xhigh",
    availableModels: models,
  });
  const transferred = replacement.snapshot.features.find((candidate) => candidate.id === feature.id)!;
  assert.equal(transferred.ownerAttachmentId, replacement.attachment.id);
  assert.equal(transferred.ownerGeneration, feature.ownerGeneration + 1);
  await assert.rejects(() => core.heartbeat({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    sessionId: leads[0].sessionId,
    sessionGeneration: 1,
    cmux: leads[0].cmux,
  }), /detached/);
});

test("owner death never changes workers; failover is fenced until lease expiry", async () => {
  const { core, store, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const worker = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker",
    featureId: feature.id,
    role: "research",
    title: "Keep alive",
    task: "Remain unchanged",
  });
  await assert.rejects(
    () => core.claimFeature({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, featureId: feature.id, expectedOwnerGeneration: feature.ownerGeneration }),
    /still owned/,
  );
  await store.update((state) => ({
    ...state,
    attachments: { ...state.attachments, [leads[0].id]: { ...state.attachments[leads[0].id], lastSeenAt: new Date(0).toISOString() } },
  }));
  await core.tick();
  const unowned = (await core.status()).features.find((candidate) => candidate.id === feature.id)!;
  assert.equal(unowned.ownerAttachmentId, undefined);
  assert.equal((await core.status()).tasks.find((candidate) => candidate.id === worker.id)?.status, "starting");
  const claimed = await core.claimFeature({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, featureId: feature.id, expectedOwnerGeneration: unowned.ownerGeneration });
  assert.equal(claimed.ownerAttachmentId, leads[1].id);
  assert.equal(claimed.ownerGeneration, feature.ownerGeneration + 1);
});

test("a spawned Lead that dies before attach is generation-fenced, requeued, and releases capacity", async () => {
  const { core, store, leads, root } = await fixture();
  await core.detach(leads[2].id, leads[2].ownershipToken);
  const feature = await core.createFeature({ ...featureInput(leads[0], "pre-attach-death", 401), spawnLead: true });
  const scheduled = await core.tick();
  assert.deepEqual(scheduled.leads.map((candidate) => candidate.id), [feature.id]);
  const launched = scheduled.leads[0];
  const launchIdentity = identity(80, "88888888-8888-4888-8888-888888888888");
  await core.recordLeadSurface(feature.id, launchIdentity, {
    ownershipToken: launched.ownershipToken,
    generation: launched.leadLaunchGeneration,
    processPid: 999_999_999,
  });
  await store.update((state) => ({
    ...state,
    features: {
      ...state.features,
      [feature.id]: {
        ...state.features[feature.id],
        leadLaunchStartedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    },
  }));
  const adapter = new V4RuntimeAdapter(join(root, "artifacts"));
  let topologyGeneration = 0;
  adapter.topology = async () => ({
    complete: true,
    capturedAt: `2026-01-01T00:00:0${topologyGeneration++}.000Z`,
    workspaceUuids: new Set(),
    workspaceToWindow: new Map(),
    paneToWorkspace: new Map(),
    surfaceToPane: new Map(),
    processPidsBySurface: new Map(),
  });
  await adapter.reconcile(await store.read(), core);
  assert.equal((await core.status()).features.find((candidate) => candidate.id === feature.id)?.leadLaunchState, "launched");
  await adapter.reconcile(await store.read(), core);
  const recovered = (await core.status()).features.find((candidate) => candidate.id === feature.id)!;
  assert.equal(recovered.leadLaunchState, "queued");
  assert.equal(recovered.leadLaunchGeneration, feature.leadLaunchGeneration + 1);
  assert.notEqual(recovered.ownershipToken, feature.ownershipToken);
  await assert.rejects(() => core.attach({
    sessionId: "dead-spawned-lead",
    clientIncarnation: "stale-generation",
    sessionGeneration: 1,
    pid: 808,
    cmux: launchIdentity,
    model: models[0],
    thinking: "high",
    availableModels: models,
    featureId: feature.id,
    featureOwnershipToken: feature.ownershipToken,
    featureLaunchGeneration: feature.leadLaunchGeneration,
  }), /token\/generation is stale/);
  assert.deepEqual((await core.tick()).leads.map((candidate) => candidate.id), [feature.id]);
});

test("an unattached live Lead is fenced and terminated on timeout so capacity is released", async (t) => {
  const { core, store, leads, root } = await fixture();
  await core.detach(leads[2].id, leads[2].ownershipToken);
  const feature = await core.createFeature({ ...featureInput(leads[0], "pre-attach-timeout", 403), spawnLead: true });
  const launched = (await core.tick()).leads[0];
  const launchIdentity = identity(83, "88888888-8888-4888-8888-888888888883");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } });
  assert.ok(child.pid);
  await core.recordLeadSurface(feature.id, launchIdentity, {
    ownershipToken: launched.ownershipToken,
    generation: launched.leadLaunchGeneration,
    processPid: child.pid,
  });
  await store.update((state) => ({
    ...state,
    features: {
      ...state.features,
      [feature.id]: {
        ...state.features[feature.id],
        leadLaunchStartedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    },
  }));
  const adapter = new V4RuntimeAdapter(join(root, "artifacts"));
  adapter.topology = async () => ({
    complete: true,
    capturedAt: "2026-01-01T00:01:00.000Z",
    workspaceUuids: new Set([launchIdentity.workspaceUuid]),
    workspaceToWindow: new Map([[launchIdentity.workspaceUuid, launchIdentity.windowUuid]]),
    paneToWorkspace: new Map([[launchIdentity.paneUuid, launchIdentity.workspaceUuid]]),
    surfaceToPane: new Map([[launchIdentity.surfaceUuid, launchIdentity.paneUuid]]),
    processPidsBySurface: new Map([[launchIdentity.surfaceUuid, new Set([child.pid!])]]),
  });
  const childExit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  await adapter.reconcile(await store.read(), core);
  await childExit;
  const timedOut = (await core.status()).features.find((candidate) => candidate.id === feature.id)!;
  assert.equal(timedOut.leadLaunchState, "unowned");
  assert.equal(timedOut.leadLaunchGeneration, feature.leadLaunchGeneration + 1);
  assert.notEqual(timedOut.ownershipToken, feature.ownershipToken);

  const next = await core.createFeature({ ...featureInput(leads[0], "capacity-after-timeout", 404), spawnLead: true });
  assert.deepEqual((await core.tick()).leads.map((candidate) => candidate.id), [next.id]);
});

test("worker exit and runtime reconciliation preserve a fenced crash outcome", async () => {
  const { core, store, leads, root } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "worker-crash", 402));
  const worker = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker-crash-task",
    featureId: feature.id,
    role: "research",
    title: "Crash after hello",
    task: "Exercise exit reconciliation",
  });
  await core.tick();
  const agents = identity(81);
  await core.recordAgentsWorkspace({
    ownershipToken: "agents-crash-token",
    sessionGeneration: 1,
    windowUuid: agents.windowUuid,
    workspaceUuid: agents.workspaceUuid,
    paneUuid: agents.paneUuid,
    createdAt: new Date().toISOString(),
  });
  const workerIdentity = identity(82);
  await core.recordWorkerSurface(worker.id, workerIdentity);
  await core.workerHello({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: worker.runtime.sessionGeneration,
    sessionId: worker.sessionId,
    processIncarnation: "crashed-process",
    pid: 999_999_998,
    cmux: workerIdentity,
    actualModel: worker.resolved.requestedModel,
    actualThinking: worker.resolved.requestedThinking,
  });
  await core.workerExited({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: worker.runtime.sessionGeneration,
    processIncarnation: "crashed-process",
  });
  const adapter = new V4RuntimeAdapter(join(root, "artifacts"));
  adapter.topology = async () => ({
    complete: true,
    capturedAt: new Date().toISOString(),
    workspaceUuids: new Set(),
    workspaceToWindow: new Map(),
    paneToWorkspace: new Map(),
    surfaceToPane: new Map(),
    processPidsBySurface: new Map(),
  });
  await adapter.reconcile(await store.read(), core);
  const crashed = (await core.status()).tasks.find((candidate) => candidate.id === worker.id)!;
  assert.equal(crashed.processState, "offline");
  assert.ok(crashed.runtime.terminalAt);
});

test("all pending owned events form one bounded concurrent at-least-once digest and survive owner death at claim/ack", async () => {
  const { core, store, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const worker = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker",
    featureId: feature.id,
    role: "research",
    title: "Digest worker",
    task: "Report",
  });
  await core.report({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: 1,
    status: "blocked",
    blockedReason: "Need a product decision",
    summary: "Stopped safely",
  });
  await core.report({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: 1,
    status: "completed",
    summary: "Completion telemetry retained for replacement",
  });
  const implementation = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "digest-ci-worker",
    featureId: feature.id,
    role: "implementation",
    title: "Digest CI worker",
    task: "Retain CI telemetry",
  });
  await core.report({
    taskId: implementation.id,
    ownershipToken: implementation.runtime.ownershipToken,
    sessionGeneration: 1,
    status: "pr-ready-ci-pending",
    prUrl: "https://example.invalid/pull/24",
    summary: "PR ready for CI",
  });
  await core.recordPullRequestObservation({
    taskId: implementation.id,
    status: "pr-ready-ci-pending",
    checks: [{ name: "deterministic-ci", status: "pending" }],
    summary: "CI telemetry remains pending for replacement",
    actionable: false,
  });
  const input = { attachmentId: leads[0].id, ownershipToken: leads[0].ownershipToken, includeTelemetry: true };
  const [left, right] = await Promise.all([core.claimDigest(input), core.claimDigest(input)]);
  assert.ok(left && right);
  assert.equal(left.id, right.id);
  assert.deepEqual(left.eventIds, right.eventIds);
  assert.ok(left.eventIds.length >= 3);
  assert.match(left.content, /Need a product decision/);
  assert.equal((await core.status()).pendingActionable > 0, true);

  // Kill the owner after claim but before acknowledgement. The lease expiry
  // releases the claim, workers remain unchanged, and the replacement receives
  // the same events at least once in one new bounded batch.
  await store.update((state) => ({
    ...state,
    attachments: { ...state.attachments, [leads[0].id]: { ...state.attachments[leads[0].id], lastSeenAt: new Date(0).toISOString() } },
  }));
  await core.tick();
  const unowned = (await core.status()).features.find((candidate) => candidate.id === feature.id)!;
  await core.claimFeature({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, featureId: feature.id, expectedOwnerGeneration: unowned.ownerGeneration });
  const replacement = await core.claimDigest({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, includeTelemetry: true });
  assert.ok(replacement);
  assert.ok(left.eventIds.every((id) => replacement.eventIds.includes(id)));
  assert.match(replacement.content, /Completion telemetry retained for replacement/);
  assert.match(replacement.content, /CI telemetry remains pending for replacement/);
  await core.acknowledgeDigest({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, batchId: replacement.id, eventIds: replacement.eventIds });
  assert.ok(((await core.status()).features.find((candidate) => candidate.id === feature.id)?.eventCursors[leads[1].id] ?? 0) > 0);
  assert.equal(await core.claimDigest({ attachmentId: leads[1].id, ownershipToken: leads[1].ownershipToken, includeTelemetry: true }), undefined);
});

test("worker attestation stores requested vs actual thinking and coordinator.report keeps agent-start baseline", async () => {
  const { core, store, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const worker = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker",
    featureId: feature.id,
    role: "research",
    title: "Blocked longevity",
    task: "Stay blocked without reminder loops",
    selection: { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
  });
  await core.tick();
  const agentsWorkspace = {
    ownershipToken: "agents-token",
    sessionGeneration: 1,
    windowUuid: identity(10).windowUuid,
    workspaceUuid: identity(10).workspaceUuid,
    paneUuid: identity(10).paneUuid,
    createdAt: new Date().toISOString(),
  };
  await core.recordAgentsWorkspace(agentsWorkspace);
  const workerIdentity = identity(20);
  await core.recordWorkerSurface(worker.id, workerIdentity);
  const hello = await core.workerHello({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: 1,
    sessionId: worker.sessionId,
    processIncarnation: "process-one",
    pid: 321,
    cmux: workerIdentity,
    actualModel: "openai/gpt-5.6-sol",
    actualThinking: "high",
  });
  assert.equal(hello.resolved.requestedThinking, "xhigh");
  assert.equal(hello.resolved.actualThinking, "high");
  const priorReportAt = new Date(Date.now() - 60_000).toISOString();
  await store.update((state) => ({ ...state, tasks: { ...state.tasks, [worker.id]: { ...state.tasks[worker.id], runtime: { ...state.tasks[worker.id].runtime, lastReportAt: priorReportAt } } } }));
  await core.workerAgentStart({ taskId: worker.id, ownershipToken: worker.runtime.ownershipToken, sessionGeneration: 1 });
  await core.report({ taskId: worker.id, ownershipToken: worker.runtime.ownershipToken, sessionGeneration: 1, status: "blocked", blockedReason: "Waiting without churn" });
  const reported = (await core.status()).tasks.find((task) => task.id === worker.id)!;
  assert.equal(reported.runtime.reportBaselineAt, priorReportAt);
  assert.ok(reported.runtime.lastReportAt! > reported.runtime.reportBaselineAt!);
  const elapsedReportAt = new Date(Date.now() - 120_000).toISOString();
  await store.update((state) => ({
    ...state,
    tasks: {
      ...state.tasks,
      [worker.id]: {
        ...state.tasks[worker.id],
        runtime: { ...state.tasks[worker.id].runtime, lastReportAt: elapsedReportAt },
      },
    },
  }));
  assert.ok(Date.now() - Date.parse(elapsedReportAt) >= 120_000);
  for (let elapsedTick = 0; elapsedTick < 3; elapsedTick++) await core.tick();
  assert.equal((await store.read()).events.filter((event) => event.summary.includes("report nudge")).length, 0);
});

test("worker hello model mismatch is durably visible and quarantined without fallback", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const worker = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker",
    featureId: feature.id,
    role: "research",
    title: "No fallback",
    task: "Fail visibly",
    selection: { model: "openai/gpt-5.6-sol", thinking: "off" },
  });
  await core.tick();
  await core.recordAgentsWorkspace({
    ownershipToken: "agents-token",
    sessionGeneration: 1,
    windowUuid: identity(10).windowUuid,
    workspaceUuid: identity(10).workspaceUuid,
    paneUuid: identity(10).paneUuid,
    createdAt: new Date().toISOString(),
  });
  await core.recordWorkerSurface(worker.id, identity(30));
  await assert.rejects(() => core.workerHello({
    taskId: worker.id,
    ownershipToken: worker.runtime.ownershipToken,
    sessionGeneration: 1,
    sessionId: worker.sessionId,
    processIncarnation: "wrong-model-process",
    pid: 333,
    cmux: identity(30),
    actualModel: "anthropic/claude-opus-4-6",
    actualThinking: "off",
  }), /not requested.*quarantined/);
  const quarantined = (await core.status()).tasks.find((task) => task.id === worker.id)!;
  assert.equal(quarantined.processState, "quarantined");
  assert.equal(quarantined.resolved.actualModel, "anthropic/claude-opus-4-6");
});

test("supervisor restart quarantines every incomplete launch saga instead of duplicating it", async () => {
  const { core, leads } = await fixture();
  const feature = await core.createFeature(featureInput(leads[0], "feature", 1));
  const task = await core.createTask({
    attachmentId: leads[0].id,
    ownershipToken: leads[0].ownershipToken,
    clientOperationId: "worker",
    featureId: feature.id,
    role: "research",
    title: "Crash edge",
    task: "Do not duplicate",
  });
  await core.tick();
  assert.equal((await core.status()).tasks.find((candidate) => candidate.id === task.id)?.processState, "launching");
  await core.recoverAfterSupervisorRestart();
  assert.equal((await core.status()).tasks.find((candidate) => candidate.id === task.id)?.processState, "unknown");
  assert.equal((await core.tick()).workers.length, 0);
});

test("Lead attachments are not valid cleanup/stop targets", async () => {
  const { core, leads } = await fixture();
  await assert.rejects(
    () => core.stopTask({ attachmentId: leads[0].id, ownershipToken: leads[0].ownershipToken, taskId: leads[0].id, reason: "must refuse" }),
    /Unknown task/,
  );
});
