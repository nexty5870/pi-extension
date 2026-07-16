import assert from "node:assert/strict";
import test from "node:test";
import { CmuxAdapter, cmuxCommandsAreFocusNeutral, isSingleCmuxCommand } from "../extensions/orchestration/delivery/cmux.ts";
import { GitHubAdapter } from "../extensions/orchestration/delivery/github.ts";
import type { CommandRunner } from "../extensions/orchestration/delivery/command.ts";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = []; queue: Array<{ stdout: string; stderr?: string; exitCode?: number }> = [];
  async run(command: string, args: string[]) { this.calls.push({ command, args }); const next = this.queue.shift() ?? { stdout: "" }; return { stdout: next.stdout, stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 }; }
}
test("cmux shell allowance accepts one topology command and rejects shell composition", () => {
  assert.equal(isSingleCmuxCommand("cmux identify --json"), true);
  assert.equal(isSingleCmuxCommand("cmux new-window"), true);
  assert.equal(isSingleCmuxCommand("cmux identify && rm -rf ."), false);
  assert.equal(isSingleCmuxCommand("git status"), false);
});
test("cmux topology targets exact caller workspace without focus/select commands", async () => {
  const runner = new FakeRunner(); runner.queue.push({ stdout: "pane:p1" }, { stdout: "surface:s1" }, { stdout: "surface:s2" }, { stdout: "" }, { stdout: "" });
  const cmux = new CmuxAdapter(runner, { projectId: "p", projectRoot: "/tmp/example", projectName: "example", cmuxWorkspaceId: "workspace:w1", cmuxSurfaceId: "surface:caller" });
  const topology = await cmux.ensureTopology(); assert.deepEqual(topology, { windowId: undefined, workspaceId: "workspace:w1", placement: "caller", paneId: "pane:p1", implementerSurfaceId: "surface:s1", reviewerSurfaceId: "surface:s2" });
  runner.queue.push({ stdout: "" }, { stdout: "" }, { stdout: "" }, { stdout: "" });
  await cmux.attachLogs(topology, "/tmp/public-fixture/implementer.log", "/tmp/public-fixture/reviewer.log");
  const args = runner.calls.map((call) => call.args); assert.equal(cmuxCommandsAreFocusNeutral(args), true);
  assert.ok(args.every((argv) => argv.includes("workspace:w1"))); assert.ok(args.filter((argv) => argv[0] === "new-surface").every((argv) => argv.includes("false")));
  const before = runner.calls.length; await cmux.ensureTopology(topology); assert.equal(runner.calls.length, before);
});
test("cmux can place delivery in a dedicated new window", async () => {
  const runner = new FakeRunner();
  runner.queue.push({ stdout: "window:w2" }, { stdout: "workspace:w2" }, { stdout: "pane:p2" }, { stdout: "surface:i2" }, { stdout: "surface:r2" }, { stdout: "" }, { stdout: "" });
  const cmux = new CmuxAdapter(runner, { projectId: "p", projectRoot: "/tmp/example", projectName: "example", cmuxWorkspaceId: "workspace:w1", cmuxSurfaceId: "surface:caller" }, "new-window");
  assert.deepEqual(await cmux.ensureTopology(), { windowId: "window:w2", workspaceId: "workspace:w2", placement: "new-window", paneId: "pane:p2", implementerSurfaceId: "surface:i2", reviewerSurfaceId: "surface:r2" });
  assert.ok(runner.calls.some((call) => call.args[0] === "new-window"));
  assert.ok(runner.calls.some((call) => call.args[0] === "new-workspace" && call.args.includes("window:w2")));
});
test("GitHub adapter accepts recognized repository visibility and reconciles exact existing PR", async () => {
  const runner = new FakeRunner(); runner.queue.push({ stdout: JSON.stringify({ visibility: "PUBLIC", nameWithOwner: "example/repo" }) });
  const github = new GitHubAdapter(runner); assert.deepEqual(await github.assertPublishable("/tmp/example"), { nameWithOwner: "example/repo", visibility: "PUBLIC" });
  runner.queue.push({ stdout: JSON.stringify([{ url: "https://example.invalid/pr/1", title: "Title", body: "Body", baseRefName: "main" }]) });
  assert.equal(await github.reconcilePr("/tmp/example", "feat/x", "main", "Title", "Body"), "https://example.invalid/pr/1");
  assert.ok(runner.calls.every((call) => !call.args.includes("merge")));
});
test("GitHub adapter supports private repositories and fails closed for unknown visibility or mismatched PRs", async () => {
  const runner = new FakeRunner(); const github = new GitHubAdapter(runner);
  runner.queue.push({ stdout: JSON.stringify({ visibility: "PRIVATE", nameWithOwner: "example/repo" }) });
  assert.deepEqual(await github.assertPublishable("/tmp"), { nameWithOwner: "example/repo", visibility: "PRIVATE" });
  runner.queue.push({ stdout: JSON.stringify({ visibility: "UNKNOWN", nameWithOwner: "example/repo" }) });
  await assert.rejects(() => github.assertPublishable("/tmp"), /recognized visibility/);
  runner.queue.push({ stdout: JSON.stringify([{ url: "u", title: "Other", body: "Body", baseRefName: "main" }]) }); await assert.rejects(() => github.reconcilePr("/tmp", "feat/x", "main", "Title", "Body"), /does not match/);
});
