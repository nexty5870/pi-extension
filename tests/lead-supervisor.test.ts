import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
      return { stdout: JSON.stringify({ surfaces: [...this.surfaces.keys()].map((ref) => ({ ref, in_window: !this.detached.has(ref) })) }), stderr: "", code: 0 };
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
    workers: { maxVisibleSurfaces: 1, staleAfterSeconds: 2, terminalSurfaceRetentionMinutes: 0 },
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

test("stale transitions wake exactly once across repeated supervision", async () => {
  const { store, coordinator, project, root } = await fixture();
  const stale = record(project, root, "stale-task", "running", {
    workerStartedAt: new Date(0).toISOString(),
    runtime: { state: "busy", lastHeartbeatAt: new Date(0).toISOString(), surfaceHealth: "healthy" },
    surface: { workspaceId: "workspace:1", paneId: "pane:workers", surfaceId: "surface:active" },
  });
  await store.createTask(stale);
  await coordinator.supervise(project.projectId);
  await coordinator.supervise(project.projectId);
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
  });
  await store.createTask(queued);
  const otherProcess = new LeadCoordinator(new LeadStore(store.root), cmux.execute, { command: "pi", leadingArgs: [] });
  await Promise.all([coordinator.supervise(project.projectId), otherProcess.supervise(project.projectId)]);
  assert.equal(cmux.calls.filter((args) => args[0] === "new-surface").length, 1);
  assert.equal((await store.requireTask(project.projectId, queued.id)).launchState, "launched");
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
