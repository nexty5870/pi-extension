import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitWorktrees, slugifyBranchPart, type CommandExecutor } from "../extensions/lead/git.ts";

const execFileAsync = promisify(execFile);

const execute: CommandExecutor = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout,
      signal: options.signal,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1 };
  }
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd, timeout: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test("V2 creates an isolated worker worktree from the base without touching caller files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-lead-git-"));
  const repo = join(fixture, "repo");
  const remote = join(fixture, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");

  const manager = new GitWorktrees(execute);
  const project = await manager.inspect(repo);
  assert.equal(project.defaultBaseBranch, "main");
  const destination = join(fixture, "workers", "task-1");
  const created = await manager.create(project, {
    taskId: "12345678-1234-1234-1234-123456789abc",
    title: "Implement: tenant ownership!",
    destination,
  });
  assert.match(created.branchName, /^pi\/implement-tenant-ownership-12345678$/);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "base\n");
  assert.equal(await readFile(join(destination, "README.md"), "utf8"), "base\n");

  await writeFile(join(destination, "README.md"), "base\nworker change\n");
  const packet = await manager.reviewPacket(destination, created.baseSha);
  assert.match(packet.diff, /worker change/);
  assert.match(packet.status, /README\.md/);
  assert.equal(packet.truncated, false);
});

test("branch slugs are bounded and safe", () => {
  assert.equal(slugifyBranchPart("  Héllo / dangerous.. task  "), "hello-dangerous-task");
  assert.ok(slugifyBranchPart("x".repeat(100)).length <= 42);
});
