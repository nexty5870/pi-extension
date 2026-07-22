import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LeadCoordinator } from "../extensions/lead/coordinator.ts";
import type { CommandExecutor } from "../extensions/lead/git.ts";
import { LeadStore } from "../extensions/lead/store.ts";
import type { ProjectRecord, TaskRecord, TaskStatus } from "../extensions/lead/types.ts";

class CmuxHarness {
  calls: string[][] = [];
  surfaces = new Map<string, string>([["surface:active", "pane:workers"]]);
  detached = new Set<string>();
  next = 1;
  malformedHealth = false;

  execute: CommandExecutor = async (command, args) => {
    assert.equal(command, "cmux");
    this.calls.push(args);
    if (args[0] === "list-panes") {
      return { stdout: JSON.stringify({ panes: [{ ref: "pane:workers", surface_refs: [...this.surfaces.keys()] }] }), stderr: "", code: 0 };
    }
    if (args[0] === "list-pane-surfaces") {
      const pane = args[args.indexOf("--pane") + 1];
      return { stdout: JSON.stringify({ surfaces: [...this.surfaces].filter(([, owner]) => owner === pane).map(([ref]) => ({ ref })) }), stderr: "", code: 0 };
    }
    if (args[0] === "surface-health") {
      return { stdout: this.malformedHealth ? "broken" : JSON.stringify({ surfaces: [...this.surfaces.keys()].map((ref) => ({ ref, in_window: !this.detached.has(ref) })) }), stderr: "", code: 0 };
    }
    if (args[0] === "close-surface") {
      this.surfaces.delete(args[args.indexOf("--surface") + 1]);
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "new-surface") {
      const ref = `surface:new-${this.next++}`;
      this.surfaces.set(ref, "pane:workers");
      return { stdout: ref, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

async function fixture(): Promise<{ store: LeadStore; coordinator: LeadCoordinator; cmux: CmuxHarness; project: ProjectRecord; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "lead-supervisor-"));
  const store = new LeadStore(join(root, "state"));
  let project = await store.ensureProject({
    projectRoot: root,
    projectName: "repo",
    cmuxWorkspaceId: "workspace:1",
    cmuxSurfaceId: "surface:caller",
  });
  project = await store.saveProject({
    ...project,
    workers: { maxVisibleSurfaces: 1, staleAfterSeconds: 2, terminalSurfaceRetentionMinutes: 0, supervisionSeconds: 15 },
    cmux: { ...project.cmux!, helperPaneId: "pane:workers" },
  });
  const cmux = new CmuxHarness();
  return { store, coordinator: new LeadCoordinator(store, cmux.execute, { command: "pi", leadingArgs: [] }), cmux, project, root };
}

function record(project: ProjectRecord, root: string, id: string, status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const at = new Date().toISOString();
  return {
    schemaVersion: 2,
    id,
    projectId: project.projectId,
    role: "research",
    brief: { title: id, task: "Inspect", acceptanceCriteria: [] },
    status,
    worktreePath: root,
    sessionId: id,
    checks: [],
    runtime: { state: "idle", lastHeartbeatAt: at, surfaceHealth: "healthy" },
    launchState: "launched",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

test("startup reconciliation uses exact topology/health IDs and wakes missing/detached once", async () => {
  const { store, coordinator, cmux, project, root } = await fixture();
  const missing = record(project, root, "missing-task", "running", {
    workerStartedAt: new Date().toISOString(),
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:missing" },
  });
  const detached = record(project, root, "detached-task", "running", {
    workerStartedAt: new Date().toISOString(),
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:active" },
  });
  cmux.detached.add("surface:active");
  await store.createTask(missing);
  await store.createTask(detached);
  await coordinator.reconcile(project.projectId);
  await coordinator.reconcile(project.projectId);
  const updated = await store.requireTask(project.projectId, missing.id);
  assert.equal(updated.runtime?.state, "detached");
  assert.equal(updated.runtime?.surfaceHealth, "missing");
  assert.equal(updated.leadEvents?.filter((event) => event.kind === "runtime").length, 1);
  const detachedUpdated = await store.requireTask(project.projectId, detached.id);
  assert.equal(detachedUpdated.runtime?.state, "detached");
  assert.equal(detachedUpdated.runtime?.surfaceHealth, "detached");
  assert.equal(detachedUpdated.leadEvents?.filter((event) => event.kind === "runtime").length, 1);
  // A genuine recovery followed by a new detach is a new transition, but each
  // transition remains exactly-once across repeated polls/reloads.
  cmux.surfaces.set("surface:missing", "pane:workers");
  await coordinator.reconcile(project.projectId);
  cmux.surfaces.delete("surface:missing");
  await coordinator.reconcile(project.projectId);
  assert.equal((await store.requireTask(project.projectId, missing.id)).leadEvents?.filter((event) => event.kind === "runtime").length, 2);
  assert.ok(cmux.calls.some((args) => args[0] === "list-panes"));
  assert.ok(cmux.calls.some((args) => args[0] === "list-pane-surfaces"));
  assert.ok(cmux.calls.some((args) => args[0] === "surface-health"));
  assert.ok(cmux.calls.every((args) => !["focus-panel", "focus-pane", "select-workspace"].includes(args[0])));
});

test("topology parse failures retain last health and repeated bounded supervision is a no-op", async () => {
  const { store, coordinator, cmux, project, root } = await fixture();
  const active = record(project, root, "healthy-task", "running", {
    workerStartedAt: new Date().toISOString(),
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:active" },
  });
  await store.createTask(active);
  await coordinator.supervise(project.projectId, undefined, true);
  const taskPath = join(store.taskArtifactDirectory(project.projectId, active.id), "task.json");
  const beforeMtime = (await stat(taskPath)).mtimeMs;
  const beforeCalls = cmux.calls.filter((args) => args[0] === "list-panes").length;
  await coordinator.supervise(project.projectId);
  await coordinator.supervise(project.projectId);
  assert.equal(cmux.calls.filter((args) => args[0] === "list-panes").length, beforeCalls);
  assert.equal((await stat(taskPath)).mtimeMs, beforeMtime);

  cmux.malformedHealth = true;
  await coordinator.supervise(project.projectId, undefined, true);
  const degraded = await store.requireTask(project.projectId, active.id);
  assert.equal(degraded.runtime?.surfaceHealth, "healthy");
  assert.match(degraded.runtime?.telemetryError ?? "", /surface-health returned invalid JSON/);
  assert.equal(degraded.leadEvents?.filter((event) => event.kind === "runtime").length ?? 0, 0);
  const degradedMtime = (await stat(taskPath)).mtimeMs;
  await coordinator.supervise(project.projectId, undefined, true);
  assert.equal((await stat(taskPath)).mtimeMs, degradedMtime);
});

test("detached, missing, and retired sessions resume in a fresh surface while live surfaces refuse", async () => {
  for (const scenario of ["detached", "missing", "retired", "live"] as const) {
    const { store, coordinator, cmux, project, root } = await fixture();
    const id = `resume-${scenario}`;
    const script = join(root, `${id}.sh`);
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    const surface = scenario === "retired" ? undefined : {
      workspaceId: "workspace:1",
      paneId: "pane:workers",
      surfaceId: scenario === "missing" ? "surface:missing" : "surface:active",
    };
    if (scenario === "detached") cmux.detached.add("surface:active");
    if (scenario === "retired") cmux.surfaces.clear();
    const task = record(project, root, id, scenario === "retired" ? "completed" : "running", {
      workerStartedAt: new Date(0).toISOString(),
      launchScriptPath: script,
      launchState: scenario === "retired" ? "retired" : "launched",
      surface,
      runtime: {
        state: scenario === "retired" ? "offline" : scenario === "live" ? "stale" : "detached",
        surfaceHealth: scenario === "detached" ? "detached" : scenario === "missing" || scenario === "retired" ? "missing" : "healthy",
        retiredSurfaceId: scenario === "retired" ? "surface:retired" : undefined,
      },
    });
    await store.createTask(task);
    if (scenario === "live") {
      await assert.rejects(() => coordinator.resume(project.projectId, task.id), /still live and healthy/);
      assert.equal(cmux.calls.some((args) => args[0] === "new-surface"), false);
      continue;
    }
    const resumed = await coordinator.resume(project.projectId, task.id);
    assert.equal(resumed.sessionId, task.sessionId);
    assert.equal(resumed.launchState, "launched");
    assert.match(resumed.surface?.surfaceId ?? "", /^surface:new-/);
    assert.equal(resumed.runtime?.surfaceHealth, "healthy");
    if (scenario === "detached") assert.ok(cmux.calls.some((args) => args[0] === "close-surface" && args.includes("surface:active")));
  }
});

test("stale transitions wake exactly once across repeated supervision", async () => {
  const { store, coordinator, project, root } = await fixture();
  const stale = record(project, root, "stale-task", "running", {
    workerStartedAt: new Date(0).toISOString(),
    runtime: { state: "busy", lastHeartbeatAt: new Date(0).toISOString(), surfaceHealth: "healthy" },
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:active" },
  });
  await store.createTask(stale);
  await coordinator.supervise(project.projectId);
  const taskPath = join(store.taskArtifactDirectory(project.projectId, stale.id), "task.json");
  const attentionMtime = (await stat(taskPath)).mtimeMs;
  await coordinator.supervise(project.projectId);
  assert.equal((await stat(taskPath)).mtimeMs, attentionMtime);
  const updated = await store.requireTask(project.projectId, stale.id);
  assert.equal(updated.runtime?.state, "stale");
  assert.equal(updated.leadEvents?.filter((event) => event.kind === "runtime").length, 1);
});

test("cross-process supervision claims one queued surface launch", async () => {
  const { store, coordinator, cmux, project, root } = await fixture();
  cmux.surfaces.clear();
  const script = join(root, "launch-once.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  const queued = record(project, root, "queue-once", "starting", {
    launchState: "queued",
    launchScriptPath: script,
    surface: undefined,
    runtime: { state: "starting", surfaceHealth: "missing" },
    linear: {
      issueIdentifier: "ENG-21",
      desiredStateType: "started",
      status: "pending",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    },
  });
  await store.createTask(queued);
  const otherProcess = new LeadCoordinator(new LeadStore(store.root), cmux.execute, { command: "pi", leadingArgs: [] });
  await Promise.all([coordinator.supervise(project.projectId), otherProcess.supervise(project.projectId)]);
  assert.equal(cmux.calls.filter((args) => args[0] === "new-surface").length, 1);
  const launched = await store.requireTask(project.projectId, queued.id);
  assert.equal(launched.launchState, "launched");
  const launchEvents = launched.leadEvents?.filter((event) => event.runtimeReasonKey === `queued-launched:${queued.id}`) ?? [];
  assert.equal(launchEvents.length, 1);
  assert.equal(launchEvents[0].runtimeState, "starting");
  assert.match(launchEvents[0].runtimeReason ?? "", /surface:new-.*Linear ENG-21/);
});

test("five-minute launch leases prevent overlap and expired launch claims recover", async () => {
  const { store, coordinator, cmux, project, root } = await fixture();
  cmux.surfaces.clear();
  const script = join(root, "claimed.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  const claimedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const task = record(project, root, "claimed-task", "starting", {
    launchState: "launching",
    launchClaimId: "other-process",
    launchClaimedAt: claimedAt,
    launchScriptPath: script,
    surface: undefined,
    runtime: { state: "starting", surfaceHealth: "missing" },
  });
  await store.createTask(task);
  await store.saveProject({ ...project, surfaceLaunchClaims: { [task.id]: claimedAt } });
  await coordinator.supervise(project.projectId, undefined, true);
  assert.equal(cmux.calls.some((args) => args[0] === "new-surface"), false);

  const expiredAt = new Date(Date.now() - 6 * 60_000).toISOString();
  await store.updateTask(project.projectId, task.id, (current) => ({ ...current, launchClaimedAt: expiredAt }));
  await store.updateProject(project.projectId, (current) => ({ ...current, surfaceLaunchClaims: { [task.id]: expiredAt } }));
  const recovered = await coordinator.supervise(project.projectId, undefined, true);
  assert.equal(recovered.find((candidate) => candidate.id === task.id)?.launchState, "launched");
  assert.equal(cmux.calls.filter((args) => args[0] === "new-surface").length, 1);
});

test("retention reclaims exact offline terminal surface, never blocked, then launches queue", async () => {
  const { store, coordinator, cmux, project, root } = await fixture();
  const active = record(project, root, "active-task", "completed", {
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:active" },
    runtime: { state: "offline", terminalAt: new Date(0).toISOString(), surfaceHealth: "healthy" },
  });
  const script = join(root, "launch.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  const queued = record(project, root, "queued-task", "starting", {
    launchState: "queued",
    launchScriptPath: script,
    surface: undefined,
    runtime: { state: "starting", surfaceHealth: "missing" },
  });
  const blocked = record(project, root, "blocked-task", "blocked", {
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:blocked" },
    runtime: { state: "offline", terminalAt: new Date(0).toISOString(), surfaceHealth: "healthy" },
  });
  cmux.surfaces.set("surface:blocked", "pane:workers");
  await store.createTask(active);
  await store.createTask(queued);
  await store.createTask(blocked);
  // Cap is occupied by active + blocked, and blocked must not be reclaimed.
  await coordinator.supervise(project.projectId);
  assert.ok(cmux.surfaces.has("surface:blocked"));
  assert.equal((await store.requireTask(project.projectId, active.id)).launchState, "retired");
  assert.equal((await store.requireTask(project.projectId, queued.id)).launchState, "queued");
  await coordinator.retire(project.projectId, blocked.id, true);
  await coordinator.supervise(project.projectId);
  const launched = await store.requireTask(project.projectId, queued.id);
  assert.equal(launched.launchState, "launched");
  assert.match(launched.surface?.surfaceId ?? "", /^surface:new-/);
  assert.ok(cmux.calls.some((args) => args[0] === "close-surface" && args.includes("surface:active")));
});
