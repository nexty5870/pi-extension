import assert from "node:assert/strict";
import test from "node:test";
import { CmuxAdapter, cmuxCommandsAreFocusNeutral } from "../extensions/orchestration/delivery/cmux.ts";
import { GitHubAdapter } from "../extensions/orchestration/delivery/github.ts";
import type { CommandRunner } from "../extensions/orchestration/delivery/command.ts";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = []; queue: Array<{ stdout: string; stderr?: string; exitCode?: number }> = [];
  async run(command: string, args: string[]) { this.calls.push({ command, args }); const next = this.queue.shift() ?? { stdout: "" }; return { stdout: next.stdout, stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 }; }
}
test("cmux topology targets exact caller workspace without focus/select commands", async () => {
  const runner = new FakeRunner(); runner.queue.push({ stdout: "pane:p1" }, { stdout: "surface:s1" }, { stdout: "surface:s2" }, { stdout: "" }, { stdout: "" });
  const cmux = new CmuxAdapter(runner, { projectId: "p", projectRoot: "/tmp/example", projectName: "example", cmuxWorkspaceId: "workspace:w1", cmuxSurfaceId: "surface:caller" });
  const topology = await cmux.ensureTopology(); assert.deepEqual(topology, { paneId: "pane:p1", implementerSurfaceId: "surface:s1", reviewerSurfaceId: "surface:s2" });
  runner.queue.push({ stdout: "" }, { stdout: "" }, { stdout: "" }, { stdout: "" });
  await cmux.attachLogs(topology, "/tmp/public-fixture/implementer.log", "/tmp/public-fixture/reviewer.log");
  const args = runner.calls.map((call) => call.args); assert.equal(cmuxCommandsAreFocusNeutral(args), true);
  assert.ok(args.every((argv) => argv.includes("workspace:w1"))); assert.ok(args.filter((argv) => argv[0] === "new-surface").every((argv) => argv.includes("false")));
  const before = runner.calls.length; await cmux.ensureTopology(topology); assert.equal(runner.calls.length, before);
});
test("GitHub adapter requires public visibility and reconciles exact existing PR", async () => {
  const runner = new FakeRunner(); runner.queue.push({ stdout: JSON.stringify({ visibility: "PUBLIC", nameWithOwner: "example/repo" }) });
  const github = new GitHubAdapter(runner); assert.equal(await github.assertPublic("/tmp/example"), "example/repo");
  runner.queue.push({ stdout: JSON.stringify([{ url: "https://example.invalid/pr/1", title: "Title", body: "Body", baseRefName: "main" }]) });
  assert.equal(await github.reconcilePr("/tmp/example", "feat/x", "main", "Title", "Body"), "https://example.invalid/pr/1");
  assert.ok(runner.calls.every((call) => !call.args.includes("merge")));
});
test("GitHub adapter fails closed for private repositories and mismatched PRs", async () => {
  const runner = new FakeRunner(); const github = new GitHubAdapter(runner);
  runner.queue.push({ stdout: JSON.stringify({ visibility: "PRIVATE", nameWithOwner: "example/repo" }) }); await assert.rejects(() => github.assertPublic("/tmp"), /public/);
  runner.queue.push({ stdout: JSON.stringify([{ url: "u", title: "Other", body: "Body", baseRefName: "main" }]) }); await assert.rejects(() => github.reconcilePr("/tmp", "feat/x", "main", "Title", "Body"), /does not match/);
});
