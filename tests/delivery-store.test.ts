import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DeliveryStore } from "../extensions/orchestration/delivery/store.ts";
import type { DeliveryState } from "../extensions/orchestration/delivery/types.ts";

function state(root: string): DeliveryState { const now = new Date().toISOString(); return { schemaVersion: 1, runId: "run", projectId: "p", initiativeId: "i", projectRoot: root, contractHash: "h", metadata: { baseBranch: "main", branchName: "feat/x", commitMessage: "x", prTitle: "x", prBody: "x", checks: [["true"]] }, phase: "preflight", branchName: "feat/x", reviewPass: 0, workers: {}, checks: [], actions: [], startedAt: now, updatedAt: now }; }
test("delivery store persists private atomic state/logs and enforces exclusive locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-store-")); const store = new DeliveryStore(root); const value = state(root); await store.write(value);
  assert.equal((await stat(store.statePath("run"))).mode & 0o777, 0o600); const log = await store.writeLog("run", "worker", "private"); assert.equal((await stat(log)).mode & 0o777, 0o600);
  const release = await store.acquire("run"); await assert.rejects(() => store.acquire("run"), /already active/); await release();
});
test("delivery store recovers a stale process lock without guessing active ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-lock-")); const store = new DeliveryStore(root); const lock = join(root, "delivery", "run", "run.lock"); await mkdir(dirname(lock), { recursive: true }); await writeFile(lock, "99999999\n");
  const release = await store.acquire("run"); await release(); assert.equal(await store.latest(), undefined);
});
