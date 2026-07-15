import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contractFromInput, contractHash } from "../extensions/orchestration/contracts.ts";
import { DeliveryController } from "../extensions/orchestration/delivery/controller.ts";
import { DeliveryStore } from "../extensions/orchestration/delivery/store.ts";
import { diffHash } from "../extensions/orchestration/delivery/safety.ts";
import type { CommandRunner } from "../extensions/orchestration/delivery/command.ts";
import type { InitiativeState, ProjectContext } from "../extensions/orchestration/types.ts";

const diffA = { text: "diff --git a/a b/a\n+safe\n", hash: diffHash("diff --git a/a b/a\n+safe\n"), paths: [] as string[] };
const diffB = { text: "diff --git a/a b/a\n+safer\n", hash: diffHash("diff --git a/a b/a\n+safer\n"), paths: [] as string[] };
function initiative(root: string): InitiativeState {
  const contract = contractFromInput({ kind: "feature", title: "Delivery", outcome: "Ship", context: "Needed", inScope: ["Code"], acceptanceCriteria: ["Done"], validation: ["Tests"], delivery: { baseBranch: "main", branchName: "feat/delivery", commitMessage: "feat: delivery", prTitle: "Delivery", prBody: "Approved body", checks: [["node", "--version"]] } });
  return { schemaVersion: 1, initiativeId: "i1", projectId: "p1", projectRoot: root, status: "approved", contract, approved: { version: 1, contentHash: contractHash(contract), approvedAt: new Date().toISOString(), approvedBy: "operator", source: "local", linearPersistence: "not-configured" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
const project = (root: string): ProjectContext => ({ projectId: "p1", projectRoot: root, projectName: "fixture", cmuxWorkspaceId: "w1", cmuxSurfaceId: "s1" });

async function harness(options: { verdicts?: Array<"approved" | "changes_requested">; checkExit?: number; mutate?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "controller-")); const calls: string[] = []; let diffCalls = 0; const verdicts = [...(options.verdicts ?? ["approved"])];
  const runner: CommandRunner = { async run(command, args) { calls.push(`${command} ${args.join(" ")}`); return { stdout: "", stderr: "", exitCode: options.checkExit ?? 0 }; } };
  const git: any = { preflight: async () => ({ baseSha: "base", remote: "origin" }), createWorktree: async () => root, diff: async () => { diffCalls++; return options.mutate && diffCalls >= 3 ? diffB : diffA; }, commit: async () => { calls.push("commit"); return "commit"; }, pushedSha: async () => undefined, push: async () => calls.push("push") };
  const github: any = { assertPublic: async () => "example/repo", reconcilePr: async () => { calls.push("pr"); return "https://example.invalid/pr/1"; }, observeCi: async () => "success" };
  const cmux: any = { ensureTopology: async (value: any) => value ?? { paneId: "p", implementerSurfaceId: "i", reviewerSurfaceId: "r" }, attachLogs: async () => {}, update: async () => {}, flash: async () => {} };
  const worker = async (role: string, _cwd: string, prompt: string) => { calls.push(role); if (role === "reviewer") { const verdict = verdicts.shift() ?? "approved"; const hash = prompt.includes(diffB.hash) ? diffB.hash : diffA.hash; return { text: JSON.stringify({ verdict, diffHash: hash, findings: verdict === "approved" ? [] : ["fix it"] }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }; } return { text: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }; };
  const store = new DeliveryStore(join(root, "state")); const controller = new DeliveryController({ runner, git, github, cmux, store, worker: worker as any });
  return { root, calls, controller, store };
}

test("controller completes reviewed checks, commit, push, PR and stops before merge/deploy", async () => {
  const h = await harness(); const state = await h.controller.run(initiative(h.root), project(h.root));
  assert.equal(state.phase, "completed"); assert.equal(state.reviewPass, 1); assert.equal(state.prUrl, "https://example.invalid/pr/1");
  assert.ok(h.calls.includes("commit") && h.calls.includes("push") && h.calls.includes("pr")); assert.ok(!h.calls.some((call) => /merge|deploy|force/.test(call)));
});
test("controller returns findings and fails after three requested-change passes", async () => {
  const h = await harness({ verdicts: ["changes_requested", "changes_requested", "changes_requested"] }); const state = await h.controller.run(initiative(h.root), project(h.root));
  assert.equal(state.phase, "failed"); assert.equal(state.reviewPass, 3); assert.match(state.failure!, /pass limit/); assert.ok(!h.calls.includes("commit"));
});
test("controller fails closed on checks and re-reviews check-mutated diffs", async () => {
  const failed = await harness({ checkExit: 1 }); const failedState = await failed.controller.run(initiative(failed.root), project(failed.root)); assert.equal(failedState.phase, "failed"); assert.match(failedState.failure!, /check failed/);
  const changed = await harness({ mutate: true, verdicts: ["approved", "approved"] }); const changedState = await changed.controller.run(initiative(changed.root), project(changed.root)); assert.equal(changedState.phase, "completed"); assert.equal(changedState.reviewPass, 2);
});
test("controller rejects contract drift and reconciles publication without duplicate commit", async () => {
  const h = await harness(); const item = initiative(h.root); const state = h.controller.create(item); item.contract!.title = "drift";
  const drifted = await h.controller.run(item, project(h.root), state); assert.equal(drifted.phase, "failed"); assert.match(drifted.failure!, /drift/);
  const clean = initiative(h.root); const resume = h.controller.create(clean); resume.baseSha = "base"; resume.worktreePath = h.root; resume.commitSha = "commit"; resume.phase = "failed";
  const resumed = await h.controller.run(clean, project(h.root), resume); assert.equal(resumed.phase, "completed"); assert.equal(h.calls.filter((call) => call === "commit").length, 0); assert.equal(h.calls.filter((call) => call === "pr").length, 1);
});
