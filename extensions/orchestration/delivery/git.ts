import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliveryMetadata } from "../types.ts";
import { checked, type CommandRunner } from "./command.ts";
import { diffHash } from "./safety.ts";

export class GitAdapter {
  constructor(private readonly runner: CommandRunner) {}
  private git(cwd: string, args: string[], timeout = 60_000) { return checked(this.runner, "git", args, cwd, timeout); }

  async preflight(root: string, metadata: DeliveryMetadata): Promise<{ baseSha: string; remote: string }> {
    if (await this.git(root, ["status", "--porcelain"])) throw new Error("Repository working tree is dirty");
    const remote = await this.git(root, ["remote", "get-url", "origin"]);
    if (!remote) throw new Error("origin remote is missing");
    await this.git(root, ["fetch", "--prune", "origin", metadata.baseBranch], 120_000);
    const local = await this.git(root, ["rev-parse", metadata.baseBranch]);
    const upstream = await this.git(root, ["rev-parse", `origin/${metadata.baseBranch}`]);
    if (local !== upstream) throw new Error("Base branch is divergent from origin");
    const branch = await this.runner.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${metadata.branchName}`], { cwd: root });
    if (branch.exitCode === 0) throw new Error(`Branch already exists: ${metadata.branchName}`);
    return { baseSha: local, remote };
  }

  async createWorktree(root: string, runDir: string, branch: string, baseSha: string): Promise<string> {
    const path = join(runDir, "worktree"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.git(root, ["worktree", "add", "-b", branch, path, baseSha], 120_000);
    return realpath(path);
  }

  async diff(root: string, baseSha: string): Promise<{ text: string; hash: string; paths: string[] }> {
    const text = await this.git(root, ["diff", "--binary", baseSha]);
    const names = await this.git(root, ["diff", "--name-only", baseSha]);
    return { text, hash: diffHash(text), paths: names.split("\n").filter(Boolean) };
  }

  async commit(root: string, message: string): Promise<string> {
    await this.git(root, ["add", "--all"]);
    await this.git(root, ["commit", "-m", message], 120_000);
    return this.git(root, ["rev-parse", "HEAD"]);
  }

  async push(root: string, branch: string): Promise<void> {
    await this.git(root, ["push", "--set-upstream", "origin", branch], 120_000);
  }

  async pushedSha(root: string, branch: string): Promise<string | undefined> {
    const result = await this.runner.run("git", ["ls-remote", "--heads", "origin", branch], { cwd: root, timeoutMs: 60_000 });
    if (result.exitCode !== 0) return; return result.stdout.trim().split(/\s+/)[0] || undefined;
  }
}
