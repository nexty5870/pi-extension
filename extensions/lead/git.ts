import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface CommandExecutor {
  (command: string, args: string[], options: { cwd: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
}

export interface GitProject {
  root: string;
  name: string;
  defaultBaseBranch: string;
}

export interface CreatedWorktree {
  path: string;
  baseBranch: string;
  baseSha: string;
  branchName: string;
  warnings: string[];
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

async function checked(
  execute: CommandExecutor,
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 60_000,
): Promise<string> {
  const result = await execute(command, args, { cwd, signal, timeout });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function assertSafeRef(value: string, label: string): void {
  if (!SAFE_REF.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function slugifyBranchPart(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return slug || "task";
}

export class GitWorktrees {
  constructor(private readonly execute: CommandExecutor) {}

  async inspect(cwd: string, signal?: AbortSignal): Promise<GitProject> {
    const unresolved = await checked(this.execute, "git", ["rev-parse", "--show-toplevel"], cwd, signal, 15_000)
      .catch(() => { throw new Error("Lead workers require a Git repository"); });
    const root = await realpath(unresolved).catch(() => resolve(unresolved));
    const remoteHead = await this.execute("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
      signal,
      timeout: 10_000,
    });
    let defaultBaseBranch = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(/^origin\//, "") : "";
    if (!defaultBaseBranch) {
      const current = await this.execute("git", ["branch", "--show-current"], { cwd: root, signal, timeout: 10_000 });
      defaultBaseBranch = current.code === 0 && current.stdout.trim() ? current.stdout.trim() : "main";
    }
    assertSafeRef(defaultBaseBranch, "base branch");
    return { root, name: basename(root), defaultBaseBranch };
  }

  async create(
    project: GitProject,
    input: { taskId: string; title: string; baseBranch?: string; destination: string; signal?: AbortSignal },
  ): Promise<CreatedWorktree> {
    const baseBranch = input.baseBranch?.trim() || project.defaultBaseBranch;
    assertSafeRef(baseBranch, "base branch");
    const branchName = `pi/${slugifyBranchPart(input.title)}-${input.taskId.slice(0, 8)}`;
    assertSafeRef(branchName, "worker branch");
    const destination = resolve(input.destination);
    const warnings: string[] = [];

    await access(destination).then(
      () => { throw new Error(`Worker destination already exists: ${destination}`); },
      () => undefined,
    );
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

    const remote = await this.execute("git", ["remote", "get-url", "origin"], {
      cwd: project.root,
      signal: input.signal,
      timeout: 10_000,
    });
    let fetched = false;
    if (remote.code === 0) {
      const fetchResult = await this.execute("git", ["fetch", "--no-tags", "origin", baseBranch], {
        cwd: project.root,
        signal: input.signal,
        timeout: 120_000,
      });
      fetched = fetchResult.code === 0;
      if (!fetched) {
        warnings.push(`Could not refresh origin/${baseBranch}; using an existing local ref if available: ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`);
      }
    } else {
      warnings.push("Repository has no origin remote; the worker starts from a local base ref and cannot publish until a remote exists.");
    }

    const candidates = remote.code === 0
      ? [...(fetched ? ["FETCH_HEAD"] : []), `refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`, baseBranch]
      : [`refs/heads/${baseBranch}`, baseBranch];
    let baseSha = "";
    for (const candidate of candidates) {
      const result = await this.execute("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
        cwd: project.root,
        signal: input.signal,
        timeout: 10_000,
      });
      if (result.code === 0) {
        baseSha = result.stdout.trim();
        break;
      }
    }
    if (!baseSha) throw new Error(`Cannot resolve base branch ${baseBranch}`);

    await checked(
      this.execute,
      "git",
      ["worktree", "add", "-b", branchName, destination, baseSha],
      project.root,
      input.signal,
      60_000,
    );

    return { path: destination, baseBranch, baseSha, branchName, warnings };
  }

  async reviewPacket(
    worktree: string,
    baseSha: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ status: string; diff: string; truncated: boolean; diffHash: string; headSha: string }> {
    const [statusResult, headResult] = await Promise.all([
      this.execute("git", ["status", "--short"], { cwd: worktree, signal, timeout: 15_000 }),
      this.execute("git", ["rev-parse", "HEAD"], { cwd: worktree, signal, timeout: 15_000 }),
    ]);
    if (statusResult.code !== 0) throw new Error(`Cannot inspect worker status: ${statusResult.stderr.trim()}`);
    if (headResult.code !== 0) throw new Error(`Cannot inspect worker HEAD: ${headResult.stderr.trim()}`);
    const diffArgs = ["diff", "--no-ext-diff", "--binary", "--unified=40"];
    if (baseSha) diffArgs.push(baseSha);
    diffArgs.push("--");
    const diffResult = await this.execute("git", diffArgs, { cwd: worktree, signal, timeout: 30_000 });
    if (diffResult.code !== 0) throw new Error(`Cannot prepare review diff: ${diffResult.stderr.trim()}`);

    const untrackedResult = await this.execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: worktree,
      signal,
      timeout: 15_000,
    });
    if (untrackedResult.code !== 0) throw new Error(`Cannot inspect untracked files: ${untrackedResult.stderr.trim()}`);
    const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
    if (untracked.length > 100) throw new Error("Review diff contains more than 100 untracked files");
    const parts = [diffResult.stdout];
    for (const path of untracked) {
      const result = await this.execute("git", ["diff", "--no-ext-diff", "--binary", "--unified=40", "--no-index", "/dev/null", path], {
        cwd: worktree,
        signal,
        timeout: 15_000,
      });
      if (result.code !== 0 && result.code !== 1) throw new Error(`Cannot capture untracked file ${path}: ${result.stderr.trim()}`);
      parts.push(result.stdout);
    }

    const source = parts.filter(Boolean).join("\n");
    const status = statusResult.stdout.trim();
    const diffHash = createHash("sha256").update(status).update("\0").update(source).digest("hex");
    const headSha = headResult.stdout.trim();
    const maximumBytes = 200 * 1024;
    if (Buffer.byteLength(source, "utf8") <= maximumBytes) {
      return { status, diff: source, truncated: false, diffHash, headSha };
    }
    let diff = source.slice(0, maximumBytes);
    while (Buffer.byteLength(diff, "utf8") > maximumBytes) diff = diff.slice(0, -1);
    return { status, diff, truncated: true, diffHash, headSha };
  }
}
