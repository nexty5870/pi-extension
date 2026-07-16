import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTaskId, LeadStore, projectIdForRoot } from "../extensions/lead/store.ts";
import type { TaskRecord } from "../extensions/lead/types.ts";

test("V2 store keeps project and worker state durable with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-store-"));
  const store = new LeadStore(join(root, "state"));
  const project = await store.ensureProject({
    projectRoot: join(root, "repo"),
    projectName: "repo",
    leadSessionFile: "/tmp/lead.jsonl",
    cmuxWorkspaceId: "workspace:2",
    cmuxSurfaceId: "surface:6",
  });
  assert.equal(project.projectId, projectIdForRoot(join(root, "repo")));
  assert.equal(project.cmux?.workspaceId, "workspace:2");

  const id = createTaskId();
  const timestamp = new Date().toISOString();
  const task: TaskRecord = {
    schemaVersion: 2,
    id,
    projectId: project.projectId,
    role: "implementation",
    brief: { title: "Add health check", task: "Implement it", acceptanceCriteria: ["Tests pass"] },
    status: "starting",
    worktreePath: store.worktreeDirectory(project.projectId, id),
    sessionId: id,
    checks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.createTask(task);
  await Promise.all([
    store.updateTask(project.projectId, id, (current) => ({ ...current, status: "running" })),
    store.updateTask(project.projectId, id, (current) => ({ ...current, summary: "visible" })),
  ]);
  const restored = await store.requireTask(project.projectId, id.slice(0, 8));
  assert.equal(restored.status, "running");
  assert.equal(restored.summary, "visible");
  assert.equal((await store.listTasks(project.projectId)).length, 1);

  const taskMode = (await stat(join(store.taskArtifactDirectory(project.projectId, id), "task.json"))).mode & 0o777;
  const directoryMode = (await stat(store.taskArtifactDirectory(project.projectId, id))).mode & 0o777;
  assert.equal(taskMode, 0o600);
  assert.equal(directoryMode, 0o700);
});
