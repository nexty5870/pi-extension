import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArgvCommandRunner, checked } from "../extensions/orchestration/delivery/command.ts";
import { GitAdapter } from "../extensions/orchestration/delivery/git.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "delivery-git-")); const remote = join(root, "remote.git"); const repo = join(root, "repo"); const runner = new ArgvCommandRunner();
  await checked(runner, "git", ["init", "--bare", remote], root); await checked(runner, "git", ["init", "-b", "main", repo], root);
  await checked(runner, "git", ["config", "user.email", "test@example.invalid"], repo); await checked(runner, "git", ["config", "user.name", "Test"], repo);
  await checked(runner, "git", ["commit", "--allow-empty", "-m", "initial"], repo); await checked(runner, "git", ["remote", "add", "origin", remote], repo); await checked(runner, "git", ["push", "-u", "origin", "main"], repo);
  return { root, repo, runner };
}
test("git adapter gates clean synchronized base and creates isolated worktree", async () => {
  const { root, repo, runner } = await fixture(); const git = new GitAdapter(runner);
  const metadata = { baseBranch: "main", branchName: "feat/test", commitMessage: "test", prTitle: "test", prBody: "test", checks: [["true"]] };
  const { baseSha } = await git.preflight(repo, metadata); const worktree = await git.createWorktree(repo, join(root, "run"), metadata.branchName, baseSha);
  assert.notEqual(worktree, repo); assert.equal(await checked(runner, "git", ["branch", "--show-current"], worktree), "feat/test");
  await assert.rejects(() => git.preflight(repo, metadata), /Branch already exists/);
});
test("git adapter refuses dirty base", async () => {
  const { repo, runner } = await fixture(); await import("node:fs/promises").then(({ writeFile }) => writeFile(join(repo, "dirty"), "x"));
  await assert.rejects(() => new GitAdapter(runner).preflight(repo, { baseBranch: "main", branchName: "feat/x", commitMessage: "x", prTitle: "x", prBody: "x", checks: [["true"]] }), /dirty/);
});
