// extensions/lead-v4/supervisor-main.ts
import { createHash as createHash5, randomBytes as randomBytes2, randomUUID as randomUUID4 } from "node:crypto";
import { chmod as chmod3, mkdir as mkdir4, rm as rm2, writeFile as writeFile3 } from "node:fs/promises";
import { createServer } from "node:net";
import { basename as basename3, join as join4, resolve as resolve3 } from "node:path";

// extensions/lead-v4/runtime-adapter.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir as mkdir2, writeFile } from "node:fs/promises";
import { join } from "node:path";

// extensions/lead/git.ts
import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
var SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
async function checked(execute, command, args, cwd, signal, timeout = 6e4) {
  const result = await execute(command, args, { cwd, signal, timeout });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}
function assertSafeRef(value, label) {
  if (!SAFE_REF.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}
function slugifyBranchPart(value) {
  const slug2 = value.normalize("NFKD").replace(new RegExp("\\p{M}+", "gu"), "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
  return slug2 || "task";
}
var GitWorktrees = class {
  constructor(execute) {
    this.execute = execute;
  }
  async inspect(cwd, signal) {
    const unresolved = await checked(this.execute, "git", ["rev-parse", "--show-toplevel"], cwd, signal, 15e3).catch(() => {
      throw new Error("Lead workers require a Git repository");
    });
    const root = await realpath(unresolved).catch(() => resolve(unresolved));
    const remoteHead = await this.execute("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
      signal,
      timeout: 1e4
    });
    let defaultBaseBranch = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(/^origin\//, "") : "";
    if (!defaultBaseBranch) {
      const current = await this.execute("git", ["branch", "--show-current"], { cwd: root, signal, timeout: 1e4 });
      defaultBaseBranch = current.code === 0 && current.stdout.trim() ? current.stdout.trim() : "main";
    }
    assertSafeRef(defaultBaseBranch, "base branch");
    return { root, name: basename(root), defaultBaseBranch };
  }
  async create(project, input) {
    const baseBranch = input.baseBranch?.trim() || project.defaultBaseBranch;
    assertSafeRef(baseBranch, "base branch");
    const branchName = `pi/${slugifyBranchPart(input.title)}-${input.taskId.slice(0, 8)}`;
    assertSafeRef(branchName, "worker branch");
    const destination = resolve(input.destination);
    const warnings = [];
    await access(destination).then(
      () => {
        throw new Error(`Worker destination already exists: ${destination}`);
      },
      () => void 0
    );
    await mkdir(dirname(destination), { recursive: true, mode: 448 });
    const remote = await this.execute("git", ["remote", "get-url", "origin"], {
      cwd: project.root,
      signal: input.signal,
      timeout: 1e4
    });
    let fetched = false;
    if (remote.code === 0) {
      const fetchResult = await this.execute("git", ["fetch", "--no-tags", "origin", baseBranch], {
        cwd: project.root,
        signal: input.signal,
        timeout: 12e4
      });
      fetched = fetchResult.code === 0;
      if (!fetched) {
        warnings.push(`Could not refresh origin/${baseBranch}; using an existing local ref if available: ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`);
      }
    } else {
      warnings.push("Repository has no origin remote; the worker starts from a local base ref and cannot publish until a remote exists.");
    }
    const candidates = remote.code === 0 ? [...fetched ? ["FETCH_HEAD"] : [], `refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`, baseBranch] : [`refs/heads/${baseBranch}`, baseBranch];
    let baseSha = "";
    for (const candidate of candidates) {
      const result = await this.execute("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
        cwd: project.root,
        signal: input.signal,
        timeout: 1e4
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
      6e4
    );
    return { path: destination, baseBranch, baseSha, branchName, warnings };
  }
  async reviewPacket(worktree, baseSha, signal) {
    const [statusResult, headResult] = await Promise.all([
      this.execute("git", ["status", "--short"], { cwd: worktree, signal, timeout: 15e3 }),
      this.execute("git", ["rev-parse", "HEAD"], { cwd: worktree, signal, timeout: 15e3 })
    ]);
    if (statusResult.code !== 0) throw new Error(`Cannot inspect worker status: ${statusResult.stderr.trim()}`);
    if (headResult.code !== 0) throw new Error(`Cannot inspect worker HEAD: ${headResult.stderr.trim()}`);
    const diffArgs = ["diff", "--no-ext-diff", "--binary", "--unified=40"];
    if (baseSha) diffArgs.push(baseSha);
    diffArgs.push("--");
    const diffResult = await this.execute("git", diffArgs, { cwd: worktree, signal, timeout: 3e4 });
    if (diffResult.code !== 0) throw new Error(`Cannot prepare review diff: ${diffResult.stderr.trim()}`);
    const untrackedResult = await this.execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: worktree,
      signal,
      timeout: 15e3
    });
    if (untrackedResult.code !== 0) throw new Error(`Cannot inspect untracked files: ${untrackedResult.stderr.trim()}`);
    const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
    if (untracked.length > 100) throw new Error("Review diff contains more than 100 untracked files");
    const parts = [diffResult.stdout];
    for (const path of untracked) {
      const result = await this.execute("git", ["diff", "--no-ext-diff", "--binary", "--unified=40", "--no-index", "/dev/null", path], {
        cwd: worktree,
        signal,
        timeout: 15e3
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
};

// extensions/lead/github.ts
var GREEN = /* @__PURE__ */ new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
var FAILED = /* @__PURE__ */ new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);
var PENDING = /* @__PURE__ */ new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);
function normalized(value) {
  return (value ?? "").trim().toUpperCase();
}
function checkName(check, index) {
  return check.name?.trim() || check.context?.trim() || `${check.__typename ?? "check"}-${index + 1}`;
}
var GREPTILE = /greptile/i;
function checkUrl(check) {
  return check.detailsUrl || check.targetUrl || check.link;
}
function checkDetails(check) {
  const url = checkUrl(check);
  const summary = check.description?.trim() || check.title?.trim() || "";
  const name = `${check.name ?? ""} ${check.context ?? ""} ${url ?? ""}`;
  if (GREPTILE.test(name)) {
    return [summary, url].filter(Boolean).join(" \u2014 ") || void 0;
  }
  return url;
}
function classifyPullRequest(payload, fallbackUrl = "") {
  const url = payload.url?.trim() || fallbackUrl;
  if (!url) throw new Error("GitHub did not return a pull request URL");
  const checks = (payload.statusCheckRollup ?? []).map((check, index) => {
    const outcome = normalized(check.conclusion || check.state);
    const execution = normalized(check.status);
    let status;
    if (GREEN.has(outcome)) status = outcome === "SKIPPED" ? "skipped" : "passed";
    else if (FAILED.has(outcome)) status = "failed";
    else if (PENDING.has(outcome) || PENDING.has(execution) || !outcome) status = "pending";
    else status = "pending";
    return {
      name: checkName(check, index),
      status,
      details: checkDetails(check)
    };
  });
  const pullRequestState = normalized(payload.state);
  if (pullRequestState === "MERGED") {
    if (!payload.headRefOid?.trim() || payload.statusCheckRollup == null) {
      return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub merged state is missing head or check evidence" };
    }
    return { status: "merged", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
  }
  if (pullRequestState === "CLOSED") {
    return { status: "failed", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "Pull request is closed without merge" };
  }
  if (pullRequestState !== "OPEN") {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub returned an unknown pull request state" };
  }
  if (!payload.headRefOid?.trim()) {
    return { status: "pending", url, mergeState: payload.mergeStateStatus, checks, reason: "GitHub did not return the pull request head" };
  }
  if (payload.statusCheckRollup == null) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub check evidence is incomplete" };
  }
  if (payload.isDraft) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "Pull request is still a draft" };
  }
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      url,
      headSha: payload.headRefOid,
      mergeState: payload.mergeStateStatus,
      checks,
      reason: `CI failed: ${failed.map((check) => check.name).join(", ")}`
    };
  }
  const pending = checks.filter((check) => check.status === "pending");
  if (pending.length > 0) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
  }
  return { status: "green", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
}
async function observePullRequest(execute, cwd, url, signal) {
  const result = await execute("gh", [
    "pr",
    "view",
    url,
    "--json",
    "url,state,isDraft,mergeStateStatus,headRefOid,statusCheckRollup"
  ], { cwd, signal, timeout: 3e4 });
  if (result.code !== 0) throw new Error(`Unable to observe PR: ${result.stderr.trim() || result.stdout.trim()}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub returned malformed PR status JSON");
  }
  return classifyPullRequest(payload, url);
}

// extensions/lead-v4/topology.ts
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isStableUuid(value) {
  return Boolean(value && UUID.test(value));
}
function assertStableUuid(value, label) {
  if (!isStableUuid(value)) throw new Error(`${label} must be a stable cmux UUID; short refs are display-only and never mutation targets`);
}
function classifyIdentity(snapshot, identity) {
  if (!snapshot.complete || snapshot.error) return "unknown";
  if (![identity.windowUuid, identity.workspaceUuid, identity.paneUuid, identity.surfaceUuid].every(isStableUuid)) return "unknown";
  const workspaceWindow = snapshot.workspaceToWindow.get(identity.workspaceUuid);
  const paneWorkspace = snapshot.paneToWorkspace.get(identity.paneUuid);
  const surfacePane = snapshot.surfaceToPane.get(identity.surfaceUuid);
  if (snapshot.workspaceUuids.has(identity.workspaceUuid) && workspaceWindow === identity.windowUuid && paneWorkspace === identity.workspaceUuid && surfacePane === identity.paneUuid) return "present";
  const tuplePartiallyReused = snapshot.workspaceUuids.has(identity.workspaceUuid) || snapshot.paneToWorkspace.has(identity.paneUuid) || snapshot.surfaceToPane.has(identity.surfaceUuid);
  return tuplePartiallyReused ? "unknown" : "absent";
}
function processAttestationMatches(snapshot, identity, pid) {
  return classifyIdentity(snapshot, identity) === "present" && (snapshot.processPidsBySurface.get(identity.surfaceUuid)?.has(pid) ?? false);
}

// extensions/lead-v4/runtime-adapter.ts
var execFileAsync = promisify(execFile);
function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function string(value) {
  return typeof value === "string" && value ? value : void 0;
}
function parseJson(stdout, command) {
  try {
    const parsed = JSON.parse(stdout);
    const value = object(parsed);
    if (!value) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new Error(`cmux ${command} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function checksHash(task) {
  return createHash2("sha256").update(JSON.stringify((task.checks ?? []).map((check) => ({ name: check.name.trim(), status: check.status })).sort((left, right) => left.name.localeCompare(right.name)))).digest("hex");
}
function identityFrom(value, fallback) {
  const identity = {
    windowUuid: string(value.window_id) ?? fallback?.windowUuid ?? "",
    workspaceUuid: string(value.workspace_id) ?? fallback?.workspaceUuid ?? "",
    paneUuid: string(value.pane_id) ?? fallback?.paneUuid ?? "",
    surfaceUuid: string(value.surface_id) ?? string(value.id) ?? fallback?.surfaceUuid ?? "",
    windowRef: string(value.window_ref) ?? fallback?.windowRef,
    workspaceRef: string(value.workspace_ref) ?? fallback?.workspaceRef,
    paneRef: string(value.pane_ref) ?? fallback?.paneRef,
    surfaceRef: string(value.surface_ref) ?? string(value.ref) ?? fallback?.surfaceRef
  };
  assertStableUuid(identity.windowUuid, "windowUuid");
  assertStableUuid(identity.workspaceUuid, "workspaceUuid");
  assertStableUuid(identity.paneUuid, "paneUuid");
  assertStableUuid(identity.surfaceUuid, "surfaceUuid");
  return identity;
}
var V4RuntimeAdapter = class {
  constructor(artifactRoot, extensionPath, piCommand = "pi", failpoint = process.env.PI_LEAD_V4_FAILPOINT) {
    this.artifactRoot = artifactRoot;
    this.extensionPath = extensionPath;
    this.piCommand = piCommand;
    this.failpoint = failpoint;
    this.execute = async (command, args, options) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
          signal: options.signal,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: this.cmuxSocketPath ? { ...process.env, CMUX_SOCKET_PATH: this.cmuxSocketPath } : process.env
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const failed = error;
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, code: typeof failed.code === "number" ? failed.code : 1, killed: failed.killed };
      }
    };
    this.git = new GitWorktrees(this.execute);
  }
  git;
  agentsWorkspaceCreation;
  cmuxSocketPath = process.env.CMUX_SOCKET_PATH;
  execute;
  setCmuxSocketPath(path) {
    if (path) this.cmuxSocketPath = path;
  }
  async cmux(args, cwd, timeout = 3e4) {
    const result = await this.execute("cmux", ["--json", "--id-format", "both", ...args], { cwd, timeout });
    if (result.code !== 0) throw new Error(`cmux ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return parseJson(result.stdout, args[0]);
  }
  fail(name) {
    if (this.failpoint === name) throw new Error(`Injected V4 failpoint: ${name}`);
  }
  async ensureAgentsWorkspace(state, core) {
    if (state.agentsWorkspace) {
      assertStableUuid(state.agentsWorkspace.workspaceUuid, "persisted Agents workspaceUuid");
      if (!state.agentsWorkspace.paneUuid) throw new Error("Persisted Agents workspace has no stable pane UUID; topology is UNKNOWN");
      return state.agentsWorkspace;
    }
    if (!this.agentsWorkspaceCreation) {
      this.agentsWorkspaceCreation = this.createAgentsWorkspace(state, core).catch((error) => {
        this.agentsWorkspaceCreation = void 0;
        throw error;
      });
    }
    return this.agentsWorkspaceCreation;
  }
  async createAgentsWorkspace(state, core) {
    this.fail("before-agents-workspace-create");
    const created = await this.cmux([
      "new-workspace",
      "--name",
      `Agents \xB7 ${state.projectName}`,
      "--cwd",
      state.projectRoot,
      "--focus",
      "false"
    ], state.projectRoot);
    this.fail("after-agents-workspace-create-before-record");
    const windowUuid = string(created.window_id);
    const workspaceUuid = string(created.workspace_id) ?? string(object(created.workspace)?.id);
    assertStableUuid(windowUuid, "Agents windowUuid");
    assertStableUuid(workspaceUuid, "Agents workspaceUuid");
    const panes = await this.cmux(["list-panes", "--workspace", workspaceUuid], state.projectRoot);
    const firstPane = Array.isArray(panes.panes) ? object(panes.panes[0]) : void 0;
    const paneUuid = string(firstPane?.id);
    assertStableUuid(paneUuid, "Agents paneUuid");
    const workspace = {
      ownershipToken: randomUUID(),
      sessionGeneration: 1,
      windowUuid,
      workspaceUuid,
      paneUuid,
      workspaceRef: string(created.workspace_ref),
      paneRef: string(firstPane?.ref),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await core.recordAgentsWorkspace(workspace);
    this.fail("after-agents-workspace-record");
    return workspace;
  }
  async launchWorker(state, original, core) {
    const current = (await core.status()).tasks.find((task) => task.id === original.id);
    if (!current || current.processState !== "launching") return;
    try {
      let task = current;
      if (task.role === "implementation" && !task.baseSha) {
        this.fail("before-worktree-create");
        const project = await this.git.inspect(state.projectRoot);
        const created2 = await this.git.create(project, {
          taskId: task.id,
          title: task.title,
          baseBranch: task.baseBranch,
          destination: task.worktreePath
        });
        this.fail("after-worktree-create-before-record");
        await core.recordWorkerProvision(task.id, {
          worktreePath: created2.path,
          baseBranch: created2.baseBranch,
          baseSha: created2.baseSha,
          branchName: created2.branchName
        });
        task = (await core.status()).tasks.find((candidate) => candidate.id === task.id);
      }
      let refreshedState = await this.readState(core, state);
      let reviewEvidence = "";
      if (task.role === "review") {
        const parent = task.parentTaskId ? refreshedState.tasks[task.parentTaskId] : void 0;
        if (!parent?.baseSha) throw new Error("Review parent has no persisted base SHA");
        const capture = await this.git.reviewPacket(parent.worktreePath, parent.baseSha);
        await core.recordReviewTarget(task.id, {
          parentTaskId: parent.id,
          diffHash: capture.diffHash,
          headSha: capture.headSha,
          checksHash: checksHash(parent),
          capturedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        task = (await core.status()).tasks.find((candidate) => candidate.id === task.id);
        reviewEvidence = [
          "## Captured review target",
          `Parent: ${parent.id}`,
          `HEAD: ${capture.headSha}`,
          `Diff hash: ${capture.diffHash}`,
          `Checks hash: ${checksHash(parent)}`,
          "",
          "## Parent checks",
          ...(parent.checks ?? []).map((check) => `- ${check.name}: ${check.status}${check.details ? ` \u2014 ${check.details}` : ""}`),
          "",
          "## Exact diff",
          "```diff",
          capture.diff,
          "```"
        ].join("\n");
        refreshedState = await this.readState(core, state);
      }
      const agents = await this.ensureAgentsWorkspace(refreshedState, core);
      this.fail("before-worker-surface-create");
      const created = await this.cmux([
        "new-surface",
        "--workspace",
        agents.workspaceUuid,
        "--pane",
        agents.paneUuid,
        "--type",
        "terminal",
        "--working-directory",
        task.worktreePath,
        "--focus",
        "false"
      ], state.projectRoot);
      this.fail("after-worker-surface-create-before-record");
      const identity = identityFrom(created, {
        windowUuid: agents.windowUuid,
        workspaceUuid: agents.workspaceUuid,
        paneUuid: agents.paneUuid
      });
      await core.recordWorkerSurface(task.id, identity);
      this.fail("after-worker-surface-record-before-send");
      const artifacts = join(this.artifactRoot, "projects", state.projectId, "v4", "tasks", task.id);
      await mkdir2(artifacts, { recursive: true, mode: 448 });
      const assignmentPath = join(artifacts, `assignment-${task.id}.md`);
      const scriptPath = join(artifacts, `launch-${task.id}.sh`);
      await writeFile(assignmentPath, this.workerPrompt(task, reviewEvidence), { encoding: "utf8", mode: 384 });
      await writeFile(scriptPath, this.workerScript(task, assignmentPath, state.projectRoot), { encoding: "utf8", mode: 448 });
      await chmod(scriptPath, 448);
      const send = await this.execute("cmux", [
        "send",
        "--workspace",
        identity.workspaceUuid,
        "--surface",
        identity.surfaceUuid,
        "--",
        `exec ${quote(scriptPath)}`
      ], { cwd: state.projectRoot, timeout: 3e4 });
      if (send.code !== 0) throw new Error(`cmux send failed: ${send.stderr || send.stdout}`);
      this.fail("after-worker-send-before-enter");
      const enter = await this.execute("cmux", [
        "send-key",
        "--workspace",
        identity.workspaceUuid,
        "--surface",
        identity.surfaceUuid,
        "enter"
      ], { cwd: state.projectRoot, timeout: 3e4 });
      if (enter.code !== 0) throw new Error(`cmux send-key failed: ${enter.stderr || enter.stdout}`);
      this.fail("after-worker-enter-before-hello");
    } catch (error) {
      await core.markLaunchUnknown(original.id, error instanceof Error ? error.message : String(error));
    }
  }
  async launchLead(state, feature, core) {
    try {
      const resolved = feature.leadResolution;
      if (!resolved) throw new Error("Feature Lead has no explicit persisted model resolution");
      const artifacts = join(this.artifactRoot, "projects", state.projectId, "v4", "features", feature.id);
      await mkdir2(artifacts, { recursive: true, mode: 448 });
      const scriptPath = join(artifacts, "launch-lead.sh");
      const args = [
        "--approve",
        ...this.extensionPath ? ["--extension", this.extensionPath] : [],
        "--model",
        resolved.requestedModel,
        "--thinking",
        resolved.requestedThinking,
        `Attach as the non-focused Lead for feature: ${feature.title}`
      ];
      await writeFile(scriptPath, [
        "#!/bin/sh",
        "set -eu",
        `cd ${quote(state.projectRoot)}`,
        "export PI_LEAD_V4=1",
        `export PI_LEAD_V4_FEATURE_ID=${quote(feature.id)}`,
        `export PI_LEAD_V4_FEATURE_TOKEN=${quote(feature.ownershipToken)}`,
        `exec ${[this.piCommand, ...args].map(quote).join(" ")}`,
        ""
      ].join("\n"), { encoding: "utf8", mode: 448 });
      await chmod(scriptPath, 448);
      this.fail("before-lead-workspace-create");
      const created = await this.cmux([
        "new-workspace",
        "--name",
        `Lead \xB7 ${feature.title}`,
        "--cwd",
        state.projectRoot,
        "--command",
        `exec ${quote(scriptPath)}`,
        "--focus",
        "false"
      ], state.projectRoot);
      this.fail("after-lead-workspace-create-before-record");
      const workspaceUuid = string(created.workspace_id);
      const windowUuid = string(created.window_id);
      assertStableUuid(workspaceUuid, "Lead workspaceUuid");
      assertStableUuid(windowUuid, "Lead windowUuid");
      const panes = await this.cmux(["list-panes", "--workspace", workspaceUuid], state.projectRoot);
      const pane = Array.isArray(panes.panes) ? object(panes.panes[0]) : void 0;
      const paneUuid = string(pane?.id);
      const surfaceUuid = Array.isArray(pane?.surface_ids) ? string(pane?.surface_ids[0]) : void 0;
      assertStableUuid(paneUuid, "Lead paneUuid");
      assertStableUuid(surfaceUuid, "Lead surfaceUuid");
      await core.recordLeadSurface(feature.id, {
        windowUuid,
        workspaceUuid,
        paneUuid,
        surfaceUuid,
        windowRef: string(created.window_ref),
        workspaceRef: string(created.workspace_ref),
        paneRef: string(pane?.ref),
        surfaceRef: Array.isArray(pane?.surface_refs) ? string(pane?.surface_refs[0]) : void 0
      });
    } catch (error) {
      await core.markLeadLaunchUnknown(feature.id, error instanceof Error ? error.message : String(error));
    }
  }
  async topology(state) {
    const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const windows = await this.cmux(["list-windows"], state.projectRoot);
      if (!Array.isArray(windows.windows)) throw new Error("list-windows omitted windows");
      const workspaceUuids = /* @__PURE__ */ new Set();
      const workspaceToWindow = /* @__PURE__ */ new Map();
      for (const rawWindow of windows.windows) {
        const windowUuid = string(object(rawWindow)?.id);
        if (!windowUuid) continue;
        const workspaces = await this.cmux(["list-workspaces", "--window", windowUuid], state.projectRoot);
        if (!Array.isArray(workspaces.workspaces)) throw new Error("list-workspaces omitted workspaces");
        for (const value of workspaces.workspaces) {
          const id = string(object(value)?.id);
          if (id) {
            workspaceUuids.add(id);
            workspaceToWindow.set(id, windowUuid);
          }
        }
      }
      const paneToWorkspace = /* @__PURE__ */ new Map();
      const surfaceToPane = /* @__PURE__ */ new Map();
      for (const workspaceUuid of workspaceUuids) {
        const panes = await this.cmux(["list-panes", "--workspace", workspaceUuid], state.projectRoot);
        if (!Array.isArray(panes.panes)) throw new Error("list-panes omitted panes");
        for (const rawPane of panes.panes) {
          const pane = object(rawPane);
          const paneUuid = string(pane?.id);
          if (!paneUuid) continue;
          paneToWorkspace.set(paneUuid, workspaceUuid);
          if (!Array.isArray(pane?.surface_ids)) throw new Error("list-panes omitted stable surface_ids");
          for (const surface of pane.surface_ids) if (typeof surface === "string") surfaceToPane.set(surface, paneUuid);
        }
      }
      const top = await this.cmux(["top", "--all", "--processes"], state.projectRoot);
      const processPidsBySurface = /* @__PURE__ */ new Map();
      const groups = object(object(top.memory_diagnostic)?.children)?.groups;
      if (Array.isArray(groups)) for (const raw of groups) {
        const group = object(raw);
        const attributions = group?.attributions;
        if (!Array.isArray(attributions)) continue;
        for (const rawAttribution of attributions) {
          const attribution = object(rawAttribution);
          const surface = string(attribution?.surface_id);
          if (!surface || !Array.isArray(attribution?.pids)) continue;
          const pids = processPidsBySurface.get(surface) ?? /* @__PURE__ */ new Set();
          for (const pid of attribution.pids) if (typeof pid === "number") pids.add(pid);
          processPidsBySurface.set(surface, pids);
        }
      }
      return { complete: true, capturedAt, workspaceUuids, workspaceToWindow, paneToWorkspace, surfaceToPane, processPidsBySurface };
    } catch (error) {
      return { complete: false, capturedAt, workspaceUuids: /* @__PURE__ */ new Set(), workspaceToWindow: /* @__PURE__ */ new Map(), paneToWorkspace: /* @__PURE__ */ new Map(), surfaceToPane: /* @__PURE__ */ new Map(), processPidsBySurface: /* @__PURE__ */ new Map(), error: error instanceof Error ? error.message : String(error) };
    }
  }
  async pollPullRequests(state, core) {
    for (const task of Object.values(state.tasks).filter((candidate) => candidate.role === "implementation" && candidate.status === "pr-ready-ci-pending" && candidate.prUrl)) {
      try {
        const observation = await observePullRequest(this.execute, task.worktreePath, task.prUrl);
        if (observation.status === "pending") {
          await core.recordPullRequestObservation({ taskId: task.id, status: "pr-ready-ci-pending", checks: observation.checks, summary: `CI remains pending for ${task.id.slice(0, 8)}`, actionable: false });
          continue;
        }
        if (observation.status === "failed") {
          await core.recordPullRequestObservation({ taskId: task.id, status: "blocked", checks: observation.checks, summary: observation.reason ?? `CI failed for ${task.id.slice(0, 8)}`, actionable: true });
          continue;
        }
        const capture = await this.git.reviewPacket(task.worktreePath, task.baseSha);
        const reviewValid = task.review?.verdict === "approved" && task.review.diffHash === capture.diffHash && task.review.headSha === capture.headSha && task.review.checksHash === checksHash(task) && !capture.status && capture.headSha === observation.headSha;
        if (!reviewValid) {
          const hasApproval = task.review?.verdict === "approved";
          await core.recordPullRequestObservation({
            taskId: task.id,
            status: hasApproval ? "blocked" : "pr-ready-ci-pending",
            checks: observation.checks,
            summary: hasApproval ? `Green/merged PR for ${task.id.slice(0, 8)} no longer matches its exact clean HEAD/diff/check-bound approval` : `Green PR for ${task.id.slice(0, 8)} requires an independent exact review before it can become ready`,
            actionable: true
          });
          continue;
        }
        await core.recordPullRequestObservation({
          taskId: task.id,
          status: observation.status === "merged" ? "merged" : "pr-ready-ci-green",
          checks: observation.checks,
          summary: `${task.id.slice(0, 8)} is ${observation.status === "merged" ? "merged" : "CI green with exact independent review"}`,
          actionable: false
        });
      } catch (error) {
        await core.recordPullRequestObservation({ taskId: task.id, status: "pr-ready-ci-pending", checks: task.checks, summary: `CI observation unavailable for ${task.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`, actionable: false });
      }
    }
  }
  async reconcile(state, core) {
    const snapshot = await this.topology(state);
    for (const task of Object.values(state.tasks).filter((candidate) => candidate.processState === "running" || candidate.processState === "launching")) {
      if (!task.cmux || !task.runtime.pid) {
        const intentAge = Date.now() - Date.parse(task.updatedAt);
        if (intentAge > state.config.processHeartbeatSeconds * 1e3) {
          await core.markLaunchUnknown(task.id, "launch intent did not receive a complete generation/token/session/UUID/process hello before its deadline");
        }
        continue;
      }
      const presence = classifyIdentity(snapshot, task.cmux);
      const attested = processAttestationMatches(snapshot, task.cmux, task.runtime.pid);
      const heartbeatFresh = Date.now() - Date.parse(task.runtime.lastHeartbeatAt ?? "") <= state.config.processHeartbeatSeconds * 1e3;
      if (presence !== "present" || !attested || !heartbeatFresh) {
        await core.markLaunchUnknown(task.id, `topology=${presence}, processAttested=${attested}, heartbeatFresh=${heartbeatFresh}`);
      }
    }
  }
  async readState(core, fallback) {
    const snapshot = await core.status();
    return {
      ...fallback,
      config: snapshot.config,
      agentsWorkspace: snapshot.agentsWorkspace,
      attachments: Object.fromEntries(snapshot.attachments.map((item) => [item.id, item])),
      features: Object.fromEntries(snapshot.features.map((item) => [item.id, item])),
      tasks: Object.fromEntries(snapshot.tasks.map((item) => [item.id, item]))
    };
  }
  async bindReviewVerdict(state, input) {
    if (!input.review) return input;
    const task = state.tasks[input.taskId];
    const target = task?.reviewTarget;
    const parent = task?.parentTaskId ? state.tasks[task.parentTaskId] : void 0;
    if (!task || task.role !== "review" || !target || !parent?.baseSha) throw new Error("Review target is unavailable");
    const capture = await this.git.reviewPacket(parent.worktreePath, parent.baseSha);
    if (capture.diffHash !== target.diffHash || capture.headSha !== target.headSha || checksHash(parent) !== target.checksHash) {
      throw new Error("Implementation diff, HEAD, or validation changed after review capture; create/rebind a fresh review generation");
    }
    return { ...input, review: { ...input.review, diffHash: target.diffHash, headSha: target.headSha, checksHash: target.checksHash } };
  }
  workerPrompt(task, reviewEvidence = "") {
    return [
      "# V4 worker assignment",
      "",
      `Feature track: ${task.featureId}`,
      `Task: ${task.title}`,
      "",
      task.task,
      "",
      "## Acceptance criteria",
      ...task.acceptanceCriteria.length ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`) : ["- Report concrete completion evidence"],
      "",
      `Requested model: ${task.resolved.requestedModel}`,
      `Requested thinking: ${task.resolved.requestedThinking}`,
      "Call lead_worker_report_v4 for durable progress, blockers, checks, and handoff. Never merge, deploy, force-push, access credentials, or mutate unrelated external resources.",
      reviewEvidence
    ].filter(Boolean).join("\n");
  }
  workerScript(task, assignmentPath, projectRoot) {
    const extension = this.extensionPath ? ["--extension", this.extensionPath] : [];
    const args = [
      "--approve",
      ...extension,
      "--session-id",
      task.sessionId,
      "--name",
      `${task.role} \xB7 ${task.title}`,
      "--append-system-prompt",
      assignmentPath,
      "--model",
      task.resolved.requestedModel,
      "--thinking",
      task.resolved.requestedThinking,
      ...task.role === "implementation" ? [] : ["--tools", "read,bash,grep,find,ls,lead_worker_report_v4"],
      `Begin the assigned ${task.role} work and report through lead_worker_report_v4.`
    ];
    return [
      "#!/bin/sh",
      "set -eu",
      `cd ${quote(task.worktreePath)}`,
      `export PI_LEAD_V4=1`,
      `export PI_LEAD_V4_TASK_ID=${quote(task.id)}`,
      `export PI_LEAD_PROJECT_ROOT=${quote(projectRoot)}`,
      `export PI_LEAD_V4_FEATURE_ID=${quote(task.featureId)}`,
      `export PI_LEAD_V4_ROLE=${quote(task.role)}`,
      `export PI_LEAD_V4_TASK_TOKEN=${quote(task.runtime.ownershipToken)}`,
      `export PI_LEAD_V4_SESSION_GENERATION=${quote(String(task.runtime.sessionGeneration))}`,
      `exec ${[this.piCommand, ...args].map(quote).join(" ")}`,
      ""
    ].join("\n");
  }
};

// extensions/lead-v4/store.ts
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import { constants } from "node:fs";
import { chmod as chmod2, mkdir as mkdir3, open, readFile, readdir, rename, rm, stat, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
var LOCK_TIMEOUT_MS = 5e3;
var LOCK_STALE_MS = 3e4;
var DEFAULT_V4_CONFIG = Object.freeze({
  maxConcurrentLeads: 3,
  maxConcurrentWorkerProcesses: 4,
  attachmentLeaseSeconds: 20,
  processHeartbeatSeconds: 20,
  digestLimit: 50,
  automaticWorkerSurfaceRetirement: false
});
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function bounded(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}
function effectiveV4Config(value) {
  return {
    ...DEFAULT_V4_CONFIG,
    ...value,
    maxConcurrentLeads: bounded(value?.maxConcurrentLeads, DEFAULT_V4_CONFIG.maxConcurrentLeads, 1, 32),
    maxConcurrentWorkerProcesses: bounded(value?.maxConcurrentWorkerProcesses, DEFAULT_V4_CONFIG.maxConcurrentWorkerProcesses, 1, 128),
    attachmentLeaseSeconds: bounded(value?.attachmentLeaseSeconds, DEFAULT_V4_CONFIG.attachmentLeaseSeconds, 5, 600),
    processHeartbeatSeconds: bounded(value?.processHeartbeatSeconds, DEFAULT_V4_CONFIG.processHeartbeatSeconds, 5, 600),
    digestLimit: bounded(value?.digestLimit, DEFAULT_V4_CONFIG.digestLimit, 1, 200),
    automaticWorkerSurfaceRetirement: value?.automaticWorkerSurfaceRetirement === true
  };
}
function v4ProjectId(projectRoot) {
  return `project-${createHash3("sha256").update(resolve2(projectRoot)).digest("hex").slice(0, 16)}`;
}
async function privateDirectory(path) {
  await mkdir3(path, { recursive: true, mode: 448 });
  await chmod2(path, 448);
}
async function atomicJson(path, value) {
  await privateDirectory(dirname2(path));
  const temporary = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  await writeFile2(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
  await chmod2(temporary, 384);
  await rename(temporary, path);
  await chmod2(path, 384);
}
function livePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function pause(ms) {
  await new Promise((resolvePause) => setTimeout(resolvePause, ms));
}
async function withLock(path, operation) {
  const lock = `${path}.lock`;
  const started = Date.now();
  while (true) {
    try {
      await privateDirectory(dirname2(lock));
      const handle2 = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
      await handle2.writeFile(`${process.pid}
`, "utf8");
      await handle2.close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const [info, ownerText] = await Promise.all([
        stat(lock).catch(() => void 0),
        readFile(lock, "utf8").catch(() => "")
      ]);
      const ownerValid = /^\d+$/.test(ownerText.trim());
      const ownerPid = ownerValid ? Number(ownerText.trim()) : 0;
      const staleUnknownOwner = info && Date.now() - info.mtimeMs > LOCK_STALE_MS && !ownerValid;
      if (ownerValid && ownerPid > 0 && !livePid(ownerPid) || staleUnknownOwner) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for V4 state lock: ${path}`);
      await pause(25);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { force: true });
  }
}
async function readLegacyDescriptors(projectDirectory) {
  const tasksDirectory = join2(projectDirectory, "tasks");
  const entries = await readdir(tasksDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const importedAt = now();
  const descriptors = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const taskPath = join2(tasksDirectory, entry.name, "task.json");
    try {
      const source = await readFile(taskPath, "utf8");
      const task = JSON.parse(source);
      if (task.schemaVersion !== 2 || !task.id) return void 0;
      return {
        taskId: task.id,
        status: task.status,
        worktreePath: task.worktreePath,
        surfaceId: task.surface?.surfaceId,
        importedAt,
        sourceHash: createHash3("sha256").update(source).digest("hex"),
        resumeAllowed: false
      };
    } catch {
      return void 0;
    }
  }));
  return descriptors.flatMap((value) => value ? [{
    taskId: value.taskId,
    ...value.status ? { status: value.status } : {},
    ...value.worktreePath ? { worktreePath: value.worktreePath } : {},
    ...value.surfaceId ? { surfaceId: value.surfaceId } : {},
    importedAt: value.importedAt,
    sourceHash: value.sourceHash,
    resumeAllowed: false
  }] : []);
}
var V4Store = class {
  root;
  projectId;
  projectDirectory;
  v4Directory;
  statePath;
  socketPath;
  instancePath;
  constructor(stateDir2, projectRoot) {
    this.root = resolve2(stateDir2);
    this.projectId = v4ProjectId(projectRoot);
    this.projectDirectory = join2(this.root, "projects", this.projectId);
    this.v4Directory = join2(this.projectDirectory, "v4");
    this.statePath = join2(this.v4Directory, "state.json");
    this.socketPath = join2(this.v4Directory, "supervisor.sock");
    this.instancePath = join2(this.v4Directory, "supervisor.instance.json");
  }
  async initialize(projectRoot, projectName, config) {
    await privateDirectory(this.root);
    await privateDirectory(this.projectDirectory);
    await privateDirectory(this.v4Directory);
    return withLock(this.statePath, async () => {
      const existing = await this.read().catch(() => void 0);
      const at = now();
      const state = existing?.schemaVersion === 4 ? {
        ...existing,
        projectRoot: resolve2(projectRoot),
        projectName,
        config: effectiveV4Config({ ...existing.config, ...config }),
        legacyV2: existing.legacyV2 ?? [],
        operations: existing.operations ?? {},
        updatedAt: at
      } : {
        schemaVersion: 4,
        projectId: this.projectId,
        projectRoot: resolve2(projectRoot),
        projectName,
        supervisorGeneration: 0,
        supervisorStartedAt: at,
        config: effectiveV4Config(config),
        attachments: {},
        features: {},
        tasks: {},
        events: [],
        operations: {},
        nextEventSequence: 1,
        legacyV2: await readLegacyDescriptors(this.projectDirectory),
        createdAt: at,
        updatedAt: at
      };
      await atomicJson(this.statePath, state);
      return state;
    });
  }
  async read() {
    return JSON.parse(await readFile(this.statePath, "utf8"));
  }
  async update(operation) {
    return withLock(this.statePath, async () => {
      const current = await this.read();
      const next = { ...await operation(current), updatedAt: now() };
      await atomicJson(this.statePath, next);
      return next;
    });
  }
  async beginSupervisorGeneration() {
    return this.update((current) => ({
      ...current,
      supervisorGeneration: current.supervisorGeneration + 1,
      supervisorStartedAt: now()
    }));
  }
  async writeInstance(value) {
    await atomicJson(this.instancePath, value);
  }
};

// extensions/lead-v4/supervisor.ts
import { createHash as createHash4, randomBytes, randomUUID as randomUUID3 } from "node:crypto";
import { basename as basename2, join as join3 } from "node:path";

// extensions/lead-v4/model.ts
var SOURCES = [
  { source: "explicit-operator", value: "explicit" },
  { source: "spawning-lead", value: "spawningLead" },
  { source: "feature-preset", value: "featurePreset" },
  { source: "role-project", value: "roleProject" },
  { source: "inherited-lead", value: "inheritedLead" }
];
function choice(input, field) {
  for (const candidate of SOURCES) {
    const selected = input[candidate.value]?.[field];
    if (selected !== void 0) return { value: selected, source: candidate.source };
  }
  return void 0;
}
function canonicalModelId(requested, availableModels) {
  const normalized2 = requested.trim();
  if (!normalized2) throw new Error("A provider/model selection is required; V4 never chooses an arbitrary fallback model");
  const exact = availableModels.filter((model) => model === normalized2);
  if (exact.length === 1) return exact[0];
  if (normalized2.includes("/")) throw new Error(`Requested model ${normalized2} is unavailable; V4 refuses silent fallback`);
  const aliases = availableModels.filter((model) => model.slice(model.indexOf("/") + 1) === normalized2);
  if (aliases.length === 0) throw new Error(`Requested model alias ${normalized2} is unavailable; provide an exact provider/model ID`);
  if (aliases.length > 1) throw new Error(`Requested model alias ${normalized2} is ambiguous (${aliases.join(", ")}); choose an exact provider/model ID`);
  return aliases[0];
}
function resolveModelSelection(input) {
  const modelChoice = choice(input, "model");
  if (!modelChoice) throw new Error("No model was resolved; select an explicit provider/model or configure a V4 policy");
  const model = canonicalModelId(modelChoice.value, [...new Set(input.availableModels)]);
  const thinkingChoice = choice(input, "thinking") ?? { value: "off", source: "inherited-lead" };
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error(`Canonical model ID must be provider/model, received ${model}`);
  return {
    model: { value: model, source: modelChoice.source },
    thinking: thinkingChoice,
    requestedModel: model,
    requestedThinking: thinkingChoice.value,
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function attestActualModel(resolved, actualModel, actualThinking) {
  if (actualModel !== resolved.requestedModel) {
    throw new Error(`Worker started with ${actualModel}, not requested ${resolved.requestedModel}; generation is quarantined`);
  }
  return { ...resolved, actualModel, actualThinking };
}

// extensions/lead-v4/scheduler.ts
var CAPACITY_STATES = /* @__PURE__ */ new Set(["launching", "running", "unknown", "quarantined"]);
function workerProcessCapacityUsed(tasks) {
  let used = 0;
  for (const task of tasks) if (CAPACITY_STATES.has(task.processState)) used++;
  return used;
}
function fairWorkerLaunches(state) {
  const tasks = Object.values(state.tasks);
  const available = Math.max(0, state.config.maxConcurrentWorkerProcesses - workerProcessCapacityUsed(tasks));
  if (available === 0) return [];
  const queuedByFeature = /* @__PURE__ */ new Map();
  for (const task of tasks.filter((candidate) => {
    if (candidate.processState !== "queued") return false;
    if (candidate.role !== "review") return true;
    const parent = candidate.parentTaskId ? state.tasks[candidate.parentTaskId] : void 0;
    return Boolean(parent && ["pr-ready-ci-pending", "pr-ready-ci-green", "completed"].includes(parent.status));
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const queue = queuedByFeature.get(task.featureId) ?? [];
    queue.push(task);
    queuedByFeature.set(task.featureId, queue);
  }
  const features = Object.values(state.features).filter((feature) => (queuedByFeature.get(feature.id)?.length ?? 0) > 0).sort((a, b) => a.schedulerSequence - b.schedulerSequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (features.length === 0) return [];
  const cursor = state.schedulerCursor;
  const cursorIndex = cursor ? features.findIndex((feature) => feature.id === cursor) : -1;
  const ordered = cursorIndex < 0 ? features : [...features.slice(cursorIndex + 1), ...features.slice(0, cursorIndex + 1)];
  const selected = [];
  let progress = true;
  while (selected.length < available && progress) {
    progress = false;
    for (const feature of ordered) {
      const task = queuedByFeature.get(feature.id)?.shift();
      if (!task) continue;
      selected.push(task);
      progress = true;
      if (selected.length >= available) break;
    }
  }
  return selected;
}
function activeLeadProcessCount(state) {
  const attached = Object.values(state.attachments).filter((attachment) => attachment.state === "attached").length;
  const unattachedLaunches = Object.values(state.features).filter((feature) => (feature.leadLaunchState === "launching" || feature.leadLaunchState === "launched") && !feature.ownerAttachmentId).length;
  return attached + unattachedLaunches;
}
function fairLeadLaunches(state) {
  const available = Math.max(0, state.config.maxConcurrentLeads - activeLeadProcessCount(state));
  return Object.values(state.features).filter((feature) => feature.leadLaunchState === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, available);
}

// extensions/lead-v4/supervisor.ts
function now2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function token() {
  return randomBytes(32).toString("hex");
}
function normalizedTitle(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function issueKey(value) {
  const direct = value?.trim().match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/)?.[1];
  const url = value?.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$|[?#])/i)?.[1];
  return (direct ?? url)?.toUpperCase();
}
function slug(value) {
  return normalizedTitle(value).replaceAll(" ", "-").slice(0, 42) || "feature";
}
function sameIdentity(left, right) {
  return left.windowUuid === right.windowUuid && left.workspaceUuid === right.workspaceUuid && left.paneUuid === right.paneUuid && left.surfaceUuid === right.surfaceUuid;
}
function assertIdentity(identity) {
  assertStableUuid(identity.windowUuid, "windowUuid");
  assertStableUuid(identity.workspaceUuid, "workspaceUuid");
  assertStableUuid(identity.paneUuid, "paneUuid");
  assertStableUuid(identity.surfaceUuid, "surfaceUuid");
}
function roleProjectSelection(state, role) {
  return { ...state.config.project, ...state.config.roles?.[role] };
}
function validationHash(task) {
  return createHash4("sha256").update(JSON.stringify((task.checks ?? []).map((check) => ({ name: check.name.trim(), status: check.status })).sort((left, right) => left.name.localeCompare(right.name)))).digest("hex");
}
function operationKey(attachmentId, clientOperationId) {
  return `${attachmentId}:${clientOperationId}`;
}
function appendEvent(state, event) {
  const created = {
    ...event,
    id: randomUUID3(),
    sequence: state.nextEventSequence,
    createdAt: now2()
  };
  return { ...state, events: [...state.events, created], nextEventSequence: state.nextEventSequence + 1 };
}
var V4SupervisorCore = class {
  constructor(store, worktreeRoot = store.root) {
    this.store = store;
    this.worktreeRoot = worktreeRoot;
  }
  async attach(input) {
    assertIdentity(input.cmux);
    if (!input.sessionId || !input.clientIncarnation) throw new Error("Lead identity requires Pi session ID and client incarnation");
    let attached;
    const state = await this.store.update((current) => {
      const selected = resolveModelSelection({
        explicit: { model: input.model, thinking: input.thinking },
        inheritedLead: input.inherited,
        availableModels: input.availableModels
      });
      selected.actualModel = input.model;
      selected.actualThinking = input.thinking;
      const id = input.attachmentId ?? randomUUID3();
      const previous = current.attachments[id];
      if (previous && (previous.ownershipToken !== input.attachmentOwnershipToken || previous.sessionId !== input.sessionId)) {
        throw new Error("Attachment ID is fenced to another token or Pi session");
      }
      attached = {
        id,
        ownershipToken: previous?.ownershipToken ?? token(),
        sessionGeneration: input.sessionGeneration,
        sessionId: input.sessionId,
        sessionFile: input.sessionFile,
        pid: input.pid,
        attachedAt: previous?.attachedAt ?? now2(),
        lastSeenAt: now2(),
        state: "attached",
        featureId: input.featureId,
        cmux: input.cmux,
        selected,
        availableModels: [...new Set(input.availableModels)].sort(),
        inherited: input.inherited
      };
      const attachments = { ...current.attachments, [id]: attached };
      let features = current.features;
      if (input.featureId && current.features[input.featureId]) {
        const feature = current.features[input.featureId];
        if (feature.ownershipToken !== input.featureOwnershipToken) throw new Error("Spawned Lead feature ownership token is invalid");
        const priorOwner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : void 0;
        if (!feature.ownerAttachmentId || feature.ownerAttachmentId === id || priorOwner?.state === "detached" || priorOwner?.state === "dead") {
          features = {
            ...features,
            [feature.id]: {
              ...feature,
              ownerAttachmentId: id,
              ownerAssignedAt: now2(),
              ownerGeneration: feature.ownerGeneration + Number(feature.ownerAttachmentId !== id),
              leadLaunchState: "attached",
              leadCmux: input.cmux,
              updatedAt: now2()
            }
          };
        }
      } else {
        for (const feature of Object.values(features)) {
          const priorOwner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : void 0;
          if (priorOwner?.state !== "detached" || priorOwner.sessionId !== input.sessionId) continue;
          features = {
            ...features,
            [feature.id]: { ...feature, ownerAttachmentId: id, ownerGeneration: feature.ownerGeneration + 1, ownerAssignedAt: now2(), leadCmux: input.cmux, updatedAt: now2() }
          };
        }
      }
      return { ...current, attachments, features };
    });
    return { attachment: attached, snapshot: this.snapshot(state) };
  }
  async heartbeat(input) {
    assertIdentity(input.cmux);
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      if (attachment.sessionId !== input.sessionId || attachment.sessionGeneration !== input.sessionGeneration || !sameIdentity(attachment.cmux, input.cmux)) {
        throw new Error("Lead heartbeat identity mismatch; stale or replaced Pi session is fenced");
      }
      return {
        ...current,
        attachments: {
          ...current.attachments,
          [attachment.id]: { ...attachment, lastSeenAt: now2(), state: "attached", detachedAt: void 0 }
        }
      };
    });
  }
  async detach(attachmentId, ownershipToken) {
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, attachmentId, ownershipToken);
      return {
        ...current,
        attachments: {
          ...current.attachments,
          [attachment.id]: { ...attachment, state: "detached", detachedAt: now2(), lastSeenAt: now2() }
        }
      };
    });
  }
  async createFeature(input) {
    let result;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const opKey = operationKey(attachment.id, input.clientOperationId);
      const prior = current.operations[opKey];
      if (prior) {
        const existing = current.features[prior.resultId];
        if (!existing || prior.kind !== "feature") throw new Error("Idempotency operation record is inconsistent");
        result = existing;
        return current;
      }
      const canonicalIssue = issueKey(input.issue);
      const exact = Object.values(current.features).find((feature) => canonicalIssue && feature.key === `issue:${canonicalIssue}`);
      if (exact) {
        result = exact;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: exact.id, createdAt: now2() } }
        };
      }
      if (input.existingFeatureId) {
        const existing = current.features[input.existingFeatureId];
        if (!existing) throw new Error(`Unknown existing feature ${input.existingFeatureId}`);
        result = existing;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: existing.id, createdAt: now2() } }
        };
      }
      if (!canonicalIssue) {
        const possible = Object.values(current.features).filter((feature) => normalizedTitle(feature.title) === normalizedTitle(input.title));
        if (possible.length > 0 && input.duplicateChoice !== "new") {
          throw new Error(`Possible existing feature track(s): ${possible.map((feature) => `${feature.id}:${feature.title}`).join(", ")}. Natural-language goals are not auto-deduplicated; choose existingFeatureId or duplicateChoice=new.`);
        }
      }
      const id = randomUUID3();
      const inheritedSelection = {
        model: attachment.selected.actualModel ?? attachment.selected.model.value,
        thinking: attachment.selected.actualThinking ?? attachment.selected.thinking.value
      };
      const leadResolution = resolveModelSelection({
        explicit: input.leadSelection,
        featurePreset: input.preset,
        roleProject: roleProjectSelection(current, "lead"),
        inheritedLead: attachment.inherited ?? inheritedSelection,
        availableModels: attachment.availableModels
      });
      const at = now2();
      result = {
        id,
        key: canonicalIssue ? `issue:${canonicalIssue}` : `goal:${id}`,
        title: input.title.trim(),
        task: input.task.trim(),
        issue: input.issue?.trim(),
        acceptanceCriteria: [...new Set((input.acceptanceCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean))].slice(0, 100),
        ownershipToken: token(),
        ownerAttachmentId: input.spawnLead ? void 0 : attachment.id,
        ownerGeneration: 1,
        ownerAssignedAt: input.spawnLead ? void 0 : at,
        preset: input.preset,
        leadResolution,
        leadLaunchState: input.spawnLead ? "queued" : "attached",
        leadCmux: input.spawnLead ? void 0 : attachment.cmux,
        taskIds: [],
        eventCursors: {},
        schedulerSequence: Object.keys(current.features).length + 1,
        createdAt: at,
        updatedAt: at
      };
      let next = {
        ...current,
        features: { ...current.features, [id]: result },
        operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "feature", resultId: id, createdAt: at } }
      };
      next = appendEvent(next, { featureId: id, kind: "ownership", actionable: false, summary: `Feature track created${input.spawnLead ? "; non-focused Lead queued" : ` and owned by Lead ${attachment.id.slice(0, 8)}`}` });
      return next;
    });
    return result;
  }
  async claimFeature(input) {
    let claimed;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const feature = current.features[input.featureId];
      if (!feature) throw new Error(`Unknown feature ${input.featureId}`);
      if (feature.ownerGeneration !== input.expectedOwnerGeneration) throw new Error("Feature owner generation changed; refresh before failover");
      const owner = feature.ownerAttachmentId ? current.attachments[feature.ownerAttachmentId] : void 0;
      if (owner?.state === "attached" && Date.now() - Date.parse(owner.lastSeenAt) <= current.config.attachmentLeaseSeconds * 1e3) {
        throw new Error(`Feature is still owned by attached Lead ${owner.id}`);
      }
      claimed = { ...feature, ownerAttachmentId: attachment.id, ownerGeneration: feature.ownerGeneration + 1, ownerAssignedAt: now2(), leadLaunchState: "attached", leadCmux: attachment.cmux, updatedAt: now2() };
      return appendEvent({ ...current, features: { ...current.features, [feature.id]: claimed } }, {
        featureId: feature.id,
        kind: "ownership",
        actionable: true,
        summary: `Feature ownership failed over to Lead ${attachment.id.slice(0, 8)} at generation ${claimed.ownerGeneration}`
      });
    });
    return claimed;
  }
  async createTask(input) {
    let result;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const feature = current.features[input.featureId];
      if (!feature) throw new Error(`Unknown feature ${input.featureId}`);
      if (feature.ownerAttachmentId !== attachment.id) throw new Error("Only the fenced owning Lead can initiate work for this feature");
      const opKey = operationKey(attachment.id, input.clientOperationId);
      const prior = current.operations[opKey];
      if (prior) {
        const existing = current.tasks[prior.resultId];
        if (!existing || prior.kind !== "task") throw new Error("Idempotency operation record is inconsistent");
        result = existing;
        return current;
      }
      const parent = input.parentTaskId ? current.tasks[input.parentTaskId] : void 0;
      if (input.role === "review" && !parent) throw new Error("Review tasks require an exact parentTaskId in the same feature");
      if (parent && parent.featureId !== feature.id) throw new Error("Review parent belongs to another feature track");
      if (input.newGeneration && input.role !== "review") throw new Error("Only review tasks may request an explicit new generation");
      const canonicalIssue = issueKey(input.issue ?? feature.issue);
      const baseUniqueKey = `${feature.id}:${input.role}:${input.parentTaskId ?? canonicalIssue ?? normalizedTitle(input.title)}`;
      const uniqueKey = input.newGeneration ? `${baseUniqueKey}:generation:${input.clientOperationId}` : baseUniqueKey;
      const duplicate = Object.values(current.tasks).find((task) => task.uniqueKey === uniqueKey);
      if (duplicate) {
        result = duplicate;
        return {
          ...current,
          operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "task", resultId: duplicate.id, createdAt: now2() } }
        };
      }
      const inheritedSelection = {
        model: attachment.selected.actualModel ?? attachment.selected.model.value,
        thinking: attachment.selected.actualThinking ?? attachment.selected.thinking.value
      };
      const resolved = resolveModelSelection({
        explicit: input.selection,
        spawningLead: attachment.featureId === feature.id ? inheritedSelection : void 0,
        featurePreset: feature.preset,
        roleProject: roleProjectSelection(current, input.role),
        inheritedLead: attachment.inherited ?? inheritedSelection,
        availableModels: attachment.availableModels
      });
      const id = randomUUID3();
      const at = now2();
      const worktreePath = input.role === "review" ? parent.worktreePath : input.role === "research" ? current.projectRoot : join3(this.worktreeRoot, "worktrees", current.projectId, id);
      result = {
        id,
        featureId: feature.id,
        uniqueKey,
        role: input.role,
        parentTaskId: parent?.id,
        title: input.title.trim(),
        task: input.task.trim(),
        issue: input.issue?.trim() || feature.issue,
        acceptanceCriteria: [...new Set((input.acceptanceCriteria ?? feature.acceptanceCriteria).map((criterion) => criterion.trim()).filter(Boolean))].slice(0, 100),
        status: "queued",
        processState: "queued",
        baseBranch: parent?.baseBranch,
        baseSha: parent?.baseSha,
        branchName: parent?.branchName ?? (input.role === "implementation" ? `pi/${slug(input.title)}-${id.slice(0, 8)}` : void 0),
        worktreePath,
        sessionId: id,
        resolved,
        runtime: { ownershipToken: token(), sessionGeneration: 1 },
        createdAt: at,
        updatedAt: at
      };
      const updatedFeature = { ...feature, taskIds: [...feature.taskIds, id], updatedAt: at };
      let next = {
        ...current,
        features: { ...current.features, [feature.id]: updatedFeature },
        tasks: { ...current.tasks, [id]: result },
        operations: { ...current.operations, [opKey]: { attachmentId: attachment.id, clientOperationId: input.clientOperationId, kind: "task", resultId: id, createdAt: at } }
      };
      next = appendEvent(next, { featureId: feature.id, taskId: id, kind: "telemetry", actionable: false, summary: `${input.role} task queued with model ${resolved.requestedModel}/${resolved.requestedThinking}` });
      return next;
    });
    return result;
  }
  async workerHello(input) {
    assertIdentity(input.cmux);
    let result;
    let mismatch;
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown V4 worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration || task.sessionId !== input.sessionId) {
        throw new Error("Worker hello failed generation/token/session fencing; generation is quarantined");
      }
      if (task.cmux && !sameIdentity(task.cmux, input.cmux)) {
        mismatch = "Worker hello cmux UUID tuple differs from the persisted launch result";
      }
      let resolved = task.resolved;
      if (!mismatch) {
        try {
          resolved = attestActualModel(task.resolved, input.actualModel, input.actualThinking);
        } catch (error) {
          mismatch = error instanceof Error ? error.message : String(error);
        }
      }
      if (mismatch) {
        result = {
          ...task,
          status: "blocked",
          processState: "quarantined",
          blockedReason: `${mismatch}; generation is quarantined`,
          resolved: { ...task.resolved, actualModel: input.actualModel, actualThinking: input.actualThinking },
          runtime: { ...task.runtime, pid: input.pid, processIncarnation: input.processIncarnation, lastHeartbeatAt: now2() },
          updatedAt: now2()
        };
        return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: result } }, {
          featureId: task.featureId,
          taskId: task.id,
          kind: "runtime",
          actionable: true,
          summary: result.blockedReason
        });
      }
      result = {
        ...task,
        cmux: input.cmux,
        resolved,
        status: "running",
        processState: "running",
        runtime: { ...task.runtime, pid: input.pid, processIncarnation: input.processIncarnation, lastHeartbeatAt: now2() },
        updatedAt: now2()
      };
      return { ...current, tasks: { ...current.tasks, [task.id]: result } };
    });
    if (mismatch) throw new Error(result.blockedReason);
    return result;
  }
  async workerAgentStart(input) {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker agent-start failed ownership fencing");
      }
      return {
        ...current,
        tasks: {
          ...current.tasks,
          [task.id]: { ...task, runtime: { ...task.runtime, reportBaselineAt: task.runtime.lastReportAt } }
        }
      };
    });
  }
  async workerHeartbeat(input) {
    assertIdentity(input.cmux);
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration || task.sessionId !== input.sessionId || task.runtime.processIncarnation !== input.processIncarnation || task.runtime.pid !== input.pid || !task.cmux || !sameIdentity(task.cmux, input.cmux)) {
        throw new Error("Worker heartbeat attestation mismatch; liveness is UNKNOWN and replacement is forbidden");
      }
      return {
        ...current,
        tasks: { ...current.tasks, [task.id]: { ...task, runtime: { ...task.runtime, lastHeartbeatAt: now2() } } }
      };
    });
  }
  async quarantineWorkerModel(input) {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker model-change quarantine failed ownership fencing");
      }
      const updated = {
        ...task,
        processState: "quarantined",
        status: "blocked",
        blockedReason: `Worker model/thinking changed to ${input.actualModel}/${input.actualThinking}; start a visible new worker generation with a durable handoff`,
        resolved: { ...task.resolved, actualModel: input.actualModel, actualThinking: input.actualThinking },
        updatedAt: now2()
      };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: updated } }, {
        featureId: task.featureId,
        taskId: task.id,
        kind: "runtime",
        actionable: true,
        summary: updated.blockedReason
      });
    });
  }
  async report(input) {
    let result;
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown worker ${input.taskId}`);
      if (task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration) {
        throw new Error("Worker report failed ownership fencing");
      }
      if (input.status === "blocked" && !input.blockedReason?.trim()) throw new Error("blocked reports require blockedReason");
      if (input.status === "pr-ready-ci-green" || input.status === "merged") throw new Error(`${input.status} is supervisor-observed, not worker-reported`);
      if (input.review) {
        if (task.role !== "review" || !task.parentTaskId || !task.reviewTarget) throw new Error("Only a review worker with a captured target may report a verdict");
        const parent = current.tasks[task.parentTaskId];
        if (!parent) throw new Error("Review parent is missing");
        const rows = input.review.acceptance;
        const missing = parent.acceptanceCriteria.filter((criterion) => !rows.some((row) => normalizedTitle(row.criterion) === normalizedTitle(criterion)));
        if (missing.length > 0) throw new Error(`Review acceptance matrix is missing: ${missing.join("; ")}`);
        if (rows.some((row) => !row.evidence.trim())) throw new Error("Every review acceptance row requires concrete evidence");
        if (input.review.verdict === "approved" && rows.some((row) => row.status !== "met")) throw new Error("Approved reviews require every acceptance criterion to be met");
        if (input.review.verdict === "approved" && (!(parent.checks ?? []).some((check) => check.status === "passed") || (parent.checks ?? []).some((check) => check.status === "failed" || check.status === "pending"))) {
          throw new Error("Approved reviews require complete non-failing validation with at least one passing check");
        }
        if (input.review.diffHash !== task.reviewTarget.diffHash || input.review.headSha !== task.reviewTarget.headSha || input.review.checksHash !== task.reviewTarget.checksHash || input.review.checksHash !== validationHash(parent)) {
          throw new Error("Review verdict is not bound to the captured diff/HEAD/check evidence");
        }
      }
      const reportedAt = now2();
      const status = input.status ?? (input.review ? "completed" : task.status);
      const terminal = ["completed", "failed", "stopped", "merged"].includes(status);
      result = {
        ...task,
        status,
        processState: task.processState,
        blockedReason: status === "blocked" ? input.blockedReason?.trim() : void 0,
        summary: input.summary?.trim() || task.summary,
        handoff: input.handoff?.trim() || task.handoff,
        prUrl: input.prUrl?.trim() || task.prUrl,
        checks: input.checks ?? task.checks,
        review: input.review ?? task.review,
        runtime: {
          ...task.runtime,
          lastReportAt: reportedAt,
          // V2.1 hotfix: reportBaselineAt belongs to agent-start and must not
          // be overwritten here. A valid running/blocked report therefore
          // suppresses the reportless-settle nudge for that run.
          terminalAt: terminal ? task.runtime.terminalAt ?? reportedAt : task.runtime.terminalAt
        },
        updatedAt: reportedAt
      };
      let tasks = { ...current.tasks, [task.id]: result };
      if (input.review && task.parentTaskId) {
        const parent = current.tasks[task.parentTaskId];
        tasks = {
          ...tasks,
          [parent.id]: {
            ...parent,
            review: input.review,
            status: input.review.verdict === "changes-requested" ? "blocked" : parent.status,
            blockedReason: input.review.verdict === "changes-requested" ? `Review requested changes: ${input.review.findings.join("; ")}` : parent.blockedReason,
            updatedAt: reportedAt
          }
        };
      }
      let next = { ...current, tasks };
      const actionable = status === "blocked" || status === "failed" || input.review?.verdict === "changes-requested";
      next = appendEvent(next, {
        featureId: task.featureId,
        taskId: task.id,
        kind: input.review ? "review" : actionable ? "status" : "telemetry",
        actionable,
        summary: `${task.role} ${task.id.slice(0, 8)}: ${status}${input.blockedReason ? ` \u2014 ${input.blockedReason}` : input.summary ? ` \u2014 ${input.summary}` : ""}`
      });
      return next;
    });
    return result;
  }
  async recordPullRequestObservation(input) {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.role !== "implementation" || !task.prUrl) return current;
      const nextBlockedReason = input.status === "blocked" ? input.summary : void 0;
      if (task.pullRequestChecks !== void 0 && task.status === input.status && JSON.stringify(task.pullRequestChecks) === JSON.stringify(input.checks ?? []) && task.pullRequestSummary === input.summary && task.blockedReason === nextBlockedReason) return current;
      const updated = {
        ...task,
        status: input.status,
        pullRequestChecks: input.checks,
        pullRequestSummary: input.summary,
        blockedReason: nextBlockedReason,
        updatedAt: now2()
      };
      const duplicate = current.events.some((event) => !event.observedAt && event.taskId === task.id && event.summary === input.summary);
      const next = { ...current, tasks: { ...current.tasks, [task.id]: updated } };
      return duplicate ? next : appendEvent(next, {
        featureId: task.featureId,
        taskId: task.id,
        kind: input.actionable ? "status" : "telemetry",
        actionable: input.actionable,
        summary: input.summary
      });
    });
  }
  async claimDigest(input) {
    let batch;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const owned = new Set(Object.values(current.features).filter((feature) => feature.ownerAttachmentId === attachment.id).map((feature) => feature.id));
      const existingClaim = current.events.filter((event) => !event.observedAt && event.claim?.attachmentId === attachment.id);
      const candidates = existingClaim.length > 0 ? existingClaim : current.events.filter((event) => {
        if (event.observedAt || !owned.has(event.featureId)) return false;
        if (!input.includeTelemetry && !event.actionable) return false;
        if (!event.claim) return true;
        return Date.now() - Date.parse(event.claim.claimedAt) > 3e4;
      });
      if (candidates.length === 0) return current;
      const batchId = existingClaim[0]?.claim?.batchId ?? randomUUID3();
      const claimedAt = now2();
      const ids = new Set(candidates.map((event) => event.id));
      const events = current.events.map((event) => ids.has(event.id) ? { ...event, claim: { batchId, attachmentId: attachment.id, claimedAt } } : event);
      const limit = current.config.digestLimit;
      const visible = candidates.slice(0, limit);
      const omitted = candidates.length - visible.length;
      const lines = visible.map((event) => {
        const summary = event.summary.length <= 2e3 ? event.summary : `${event.summary.slice(0, 2e3)}\u2026`;
        return `- [${event.kind}] ${summary}`;
      });
      if (omitted > 0) lines.push(`- \u2026 ${omitted} more event(s) retained in this same claimed batch`);
      batch = {
        id: batchId,
        attachmentId: attachment.id,
        eventIds: candidates.map((event) => event.id),
        actionable: candidates.some((event) => event.actionable),
        content: [`# V4 supervisor digest (${candidates.length} event${candidates.length === 1 ? "" : "s"})`, ...lines].join("\n"),
        truncated: omitted > 0,
        createdAt: claimedAt
      };
      return { ...current, events };
    });
    return batch;
  }
  async acknowledgeDigest(input) {
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const ids = new Set(input.eventIds);
      const observedAt = now2();
      const acknowledged = current.events.filter((event) => ids.has(event.id) && event.claim?.batchId === input.batchId && event.claim.attachmentId === attachment.id);
      const features = { ...current.features };
      for (const event of acknowledged) {
        const feature = features[event.featureId];
        if (!feature) continue;
        features[event.featureId] = {
          ...feature,
          eventCursors: {
            ...feature.eventCursors ?? {},
            [attachment.id]: Math.max(feature.eventCursors?.[attachment.id] ?? 0, event.sequence)
          }
        };
      }
      return {
        ...current,
        features,
        events: current.events.map((event) => ids.has(event.id) && event.claim?.batchId === input.batchId && event.claim.attachmentId === attachment.id ? { ...event, observedAt, observedBy: attachment.id, claim: void 0 } : event)
      };
    });
  }
  async workerExited(input) {
    await this.store.update((current) => {
      const task = current.tasks[input.taskId];
      if (!task || task.runtime.ownershipToken !== input.ownershipToken || task.runtime.sessionGeneration !== input.sessionGeneration || task.runtime.processIncarnation !== input.processIncarnation) {
        throw new Error("Worker exit failed process-incarnation fencing");
      }
      return {
        ...current,
        tasks: {
          ...current.tasks,
          [task.id]: { ...task, processState: "offline", runtime: { ...task.runtime, terminalAt: task.runtime.terminalAt ?? now2() }, updatedAt: now2() }
        }
      };
    });
  }
  async stopTask(input) {
    let stopped;
    await this.store.update((current) => {
      const attachment = this.requireAttachment(current, input.attachmentId, input.ownershipToken);
      const task = current.tasks[input.taskId];
      if (!task) throw new Error(`Unknown task ${input.taskId}`);
      const feature = current.features[task.featureId];
      if (feature?.ownerAttachmentId !== attachment.id) throw new Error("Only the feature owner may stop its worker");
      stopped = { ...task, status: "stopped", summary: input.reason, runtime: { ...task.runtime, terminalAt: now2() }, updatedAt: now2() };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: stopped } }, { featureId: task.featureId, taskId: task.id, kind: "telemetry", actionable: false, summary: `Stop requested for ${task.id.slice(0, 8)}; surface retention remains enabled` });
    });
    return stopped;
  }
  async tick() {
    let leads = [];
    let workers = [];
    await this.store.update((current) => {
      const cutoff = Date.now() - current.config.attachmentLeaseSeconds * 1e3;
      let attachments = current.attachments;
      for (const attachment of Object.values(current.attachments)) {
        if (attachment.state === "attached" && Date.parse(attachment.lastSeenAt) < cutoff) {
          attachments = { ...attachments, [attachment.id]: { ...attachment, state: "dead", detachedAt: now2() } };
        }
      }
      let next = {
        ...current,
        attachments,
        // A Lead killed at the claim/ack boundary releases its lease only after
        // attachment expiry. The next owner may then receive the same batch,
        // which is deliberate at-least-once delivery.
        events: current.events.map((event) => event.claim && attachments[event.claim.attachmentId]?.state !== "attached" ? { ...event, claim: void 0 } : event)
      };
      for (const feature of Object.values(next.features)) {
        if (!feature.ownerAttachmentId) continue;
        const owner = attachments[feature.ownerAttachmentId];
        if (owner?.state === "attached") continue;
        const already = next.events.some((event) => event.kind === "ownership" && !event.observedAt && event.summary.includes(`generation ${feature.ownerGeneration}`));
        next = {
          ...next,
          features: { ...next.features, [feature.id]: { ...feature, ownerAttachmentId: void 0, leadLaunchState: "unowned", updatedAt: now2() } }
        };
        if (!already) next = appendEvent(next, { featureId: feature.id, kind: "ownership", actionable: true, summary: `Feature owner lease expired at generation ${feature.ownerGeneration}; workers remain unchanged and a replacement Lead may claim it` });
      }
      leads = fairLeadLaunches(next);
      workers = fairWorkerLaunches(next);
      const features = { ...next.features };
      for (const feature of leads) features[feature.id] = { ...feature, leadLaunchState: "launching", updatedAt: now2() };
      const tasks = { ...next.tasks };
      for (const task of workers) tasks[task.id] = { ...task, status: "starting", processState: "launching", updatedAt: now2() };
      return { ...next, features, tasks, schedulerCursor: workers.at(-1)?.featureId ?? next.schedulerCursor };
    });
    return { leads, workers };
  }
  async recordAgentsWorkspace(workspace) {
    if (!workspace) throw new Error("Agents workspace identity is required");
    assertStableUuid(workspace.windowUuid, "agents windowUuid");
    assertStableUuid(workspace.workspaceUuid, "agents workspaceUuid");
    if (workspace.paneUuid) assertStableUuid(workspace.paneUuid, "agents paneUuid");
    await this.store.update((current) => ({ ...current, agentsWorkspace: workspace }));
  }
  async recordWorkerProvision(taskId, provision) {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.processState !== "launching") throw new Error("Worker launch intent is not active");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, ...provision, updatedAt: now2() } } };
    });
  }
  async recordReviewTarget(taskId, target) {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.role !== "review" || task.processState !== "launching") throw new Error("Review launch intent is not active");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, reviewTarget: target, updatedAt: now2() } } };
    });
  }
  async recordWorkerSurface(taskId, identity) {
    assertIdentity(identity);
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task || task.processState !== "launching") throw new Error("Worker launch intent is not active");
      if (current.agentsWorkspace?.workspaceUuid !== identity.workspaceUuid) throw new Error("Worker surface is outside the dedicated Agents workspace");
      return { ...current, tasks: { ...current.tasks, [task.id]: { ...task, cmux: identity, updatedAt: now2() } } };
    });
  }
  async recordLeadSurface(featureId, identity) {
    assertIdentity(identity);
    await this.store.update((current) => {
      const feature = current.features[featureId];
      if (!feature || feature.leadLaunchState !== "launching") throw new Error("Lead launch intent is not active");
      return { ...current, features: { ...current.features, [feature.id]: { ...feature, leadCmux: identity, leadLaunchState: "launched", updatedAt: now2() } } };
    });
  }
  async recoverAfterSupervisorRestart() {
    await this.store.update((current) => {
      let next = current;
      for (const task of Object.values(current.tasks).filter((candidate) => candidate.processState === "launching")) {
        const updated = { ...task, processState: "unknown", runtime: { ...task.runtime, crashReason: "Supervisor restarted with an incomplete durable launch saga" }, updatedAt: now2() };
        next = appendEvent({ ...next, tasks: { ...next.tasks, [task.id]: updated } }, { featureId: task.featureId, taskId: task.id, kind: "runtime", actionable: true, summary: `Incomplete launch for ${task.id.slice(0, 8)} is UNKNOWN after supervisor restart; no duplicate launch is allowed` });
      }
      for (const feature of Object.values(next.features).filter((candidate) => candidate.leadLaunchState === "launching")) {
        const updated = { ...feature, leadLaunchState: "unowned", updatedAt: now2() };
        next = appendEvent({ ...next, features: { ...next.features, [feature.id]: updated } }, {
          featureId: feature.id,
          kind: "runtime",
          actionable: true,
          summary: `Incomplete feature Lead launch is UNKNOWN after supervisor restart; any possibly-live Lead workspace is retained`
        });
      }
      return next;
    });
  }
  async markLeadLaunchUnknown(featureId, reason) {
    await this.store.update((current) => {
      const feature = current.features[featureId];
      if (!feature) return current;
      const updated = { ...feature, leadLaunchState: "unowned", updatedAt: now2() };
      return appendEvent({ ...current, features: { ...current.features, [feature.id]: updated } }, {
        featureId: feature.id,
        kind: "runtime",
        actionable: true,
        summary: `Feature Lead launch outcome UNKNOWN: ${reason}. A possibly-live Lead workspace is never closed or relaunched automatically.`
      });
    });
  }
  async markLaunchUnknown(taskId, reason) {
    await this.store.update((current) => {
      const task = current.tasks[taskId];
      if (!task) return current;
      const updated = { ...task, processState: "unknown", runtime: { ...task.runtime, crashReason: reason }, updatedAt: now2() };
      return appendEvent({ ...current, tasks: { ...current.tasks, [task.id]: updated } }, { featureId: task.featureId, taskId: task.id, kind: "runtime", actionable: true, summary: `Launch outcome UNKNOWN: ${reason}. Duplicate launch, resume, reuse, and cleanup are forbidden.` });
    });
  }
  async status() {
    return this.snapshot(await this.store.read());
  }
  requireAttachment(state, id, ownershipToken) {
    const attachment = state.attachments[id];
    if (!attachment || attachment.ownershipToken !== ownershipToken) throw new Error("Lead attachment ownership token is invalid or stale");
    if (attachment.state !== "attached") throw new Error(`Lead attachment is ${attachment.state}; reattach with a new client incarnation`);
    return attachment;
  }
  snapshot(state) {
    return {
      projectId: state.projectId,
      supervisorGeneration: state.supervisorGeneration,
      config: state.config,
      agentsWorkspace: state.agentsWorkspace,
      attachments: Object.values(state.attachments).sort((a, b) => a.attachedAt.localeCompare(b.attachedAt)),
      features: Object.values(state.features).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      tasks: Object.values(state.tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      pendingActionable: state.events.filter((event) => !event.observedAt && event.actionable).length,
      pendingTelemetry: state.events.filter((event) => !event.observedAt && !event.actionable).length
    };
  }
};

// extensions/lead-v4/transport.ts
var V4_PROTOCOL_VERSION = 4;
var V4_SCHEMA_VERSION = 4;
var V4_BUILD_ID = "lead-v4.0.0";
var MAX_FRAME_BYTES = 256 * 1024;

// extensions/lead-v4/supervisor-main.ts
var runtimeDir = resolve3(process.env.PI_LEAD_V4_RUNTIME_DIR ?? "");
var stateDir = resolve3(process.env.PI_LEAD_V4_STATE_DIR ?? "");
var socketPath = join4(runtimeDir, "supervisor.sock");
var tokenPath = join4(runtimeDir, "transport.token");
var MAX_FRAME_BYTES2 = 256 * 1024;
var epoch = randomUUID4();
var transportToken = randomBytes2(32).toString("hex");
var stateRootHash = createHash5("sha256").update(stateDir).digest("hex");
var projects = /* @__PURE__ */ new Map();
var ticking = false;
var tickTimer;
var reconcileCounter = 0;
var daemonReady = false;
function response(socket, id, value) {
  const encoded = `${JSON.stringify({ id, ok: true, result: value })}
`;
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES2) {
    socket.end(`${JSON.stringify({ id, ok: false, error: "V4 RPC response exceeds 256 KiB; request a narrower record", code: "E2BIG" })}
`);
    return;
  }
  socket.end(encoded);
}
function failure(socket, id, error, code) {
  const message = error instanceof Error ? error.message : String(error);
  socket.end(`${JSON.stringify({ id, ok: false, error: message, code })}
`);
}
async function projectRuntime(params) {
  const projectRoot = typeof params.projectRoot === "string" ? resolve3(params.projectRoot) : void 0;
  if (!projectRoot) throw new Error("V4 RPC requires projectRoot");
  let pending = projects.get(projectRoot);
  if (!pending) {
    pending = (async () => {
      const store = new V4Store(stateDir, projectRoot);
      await store.initialize(projectRoot, typeof params.projectName === "string" ? params.projectName : basename3(projectRoot), params.config);
      await store.beginSupervisorGeneration();
      const core = new V4SupervisorCore(store, stateDir);
      await core.recoverAfterSupervisorRestart();
      const adapter = new V4RuntimeAdapter(
        stateDir,
        process.env.PI_LEAD_V4_EXTENSION_PATH,
        process.env.PI_LEAD_V4_PI_COMMAND || "pi"
      );
      return { store, core, adapter };
    })();
    projects.set(projectRoot, pending);
    void pending.catch(() => {
      if (projects.get(projectRoot) === pending) projects.delete(projectRoot);
    });
  }
  return pending;
}
async function dispatch(method, params) {
  const runtime = await projectRuntime(params);
  runtime.adapter.setCmuxSocketPath(typeof params.cmuxSocketPath === "string" ? params.cmuxSocketPath : void 0);
  switch (method) {
    case "initializeProject":
      return runtime.core.status();
    case "attach":
      return runtime.core.attach(params.input);
    case "heartbeat":
      return runtime.core.heartbeat(params.input);
    case "detach":
      return runtime.core.detach(String(params.attachmentId), String(params.ownershipToken));
    case "createFeature":
      return runtime.core.createFeature(params.input);
    case "claimFeature":
      return runtime.core.claimFeature(params.input);
    case "createTask":
      return runtime.core.createTask(params.input);
    case "workerHello":
      return runtime.core.workerHello(params.input);
    case "workerAgentStart":
      return runtime.core.workerAgentStart(params.input);
    case "workerHeartbeat":
      return runtime.core.workerHeartbeat(params.input);
    case "quarantineWorkerModel":
      return runtime.core.quarantineWorkerModel(params.input);
    case "workerExited":
      return runtime.core.workerExited(params.input);
    case "report": {
      const state = await runtime.store.read();
      const input = await runtime.adapter.bindReviewVerdict(state, params.input);
      return runtime.core.report(input);
    }
    case "claimDigest":
      return runtime.core.claimDigest(params.input);
    case "acknowledgeDigest":
      return runtime.core.acknowledgeDigest(params.input);
    case "stopTask":
      return runtime.core.stopTask(params.input);
    case "status":
      return runtime.core.status();
    case "rollbackCheck": {
      const snapshot = await runtime.core.status();
      const unsafe = snapshot.tasks.filter((task) => ["launching", "running", "unknown", "quarantined"].includes(task.processState));
      if (unsafe.length > 0) throw new Error(`Rollback to V2 is unsafe while V4 generations are active/uncertain: ${unsafe.map((task) => task.id).join(", ")}`);
      return { safe: true };
    }
    default:
      throw new Error(`Unknown V4 supervisor method: ${method}`);
  }
}
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    reconcileCounter++;
    for (const pending of projects.values()) {
      const runtime = await pending;
      const before = await runtime.store.read();
      const scheduled = await runtime.core.tick();
      for (const feature of scheduled.leads) void runtime.adapter.launchLead(before, feature, runtime.core);
      for (const task of scheduled.workers) void runtime.adapter.launchWorker(before, task, runtime.core);
      if (reconcileCounter % 5 === 0) {
        const current = await runtime.store.read();
        await runtime.adapter.reconcile(current, runtime.core);
      }
      if (reconcileCounter % 30 === 0) {
        const current = await runtime.store.read();
        await runtime.adapter.pollPullRequests(current, runtime.core);
      }
    }
  } finally {
    ticking = false;
  }
}
async function handle(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    failure(socket, "parse", error, "EBADMSG");
    return;
  }
  const id = typeof request.id === "string" ? request.id : "unknown";
  if (request.protocolVersion !== V4_PROTOCOL_VERSION) {
    failure(socket, id, `Protocol mismatch: supervisor=${V4_PROTOCOL_VERSION}`, "EPROTO");
    return;
  }
  if (request.method === "handshake") {
    if (!daemonReady) {
      failure(socket, id, "Supervisor bind is not ready", "EAGAIN");
      return;
    }
    const params2 = request.params;
    if (params2?.schemaVersion !== V4_SCHEMA_VERSION || params2?.buildId !== V4_BUILD_ID || params2?.stateRootHash !== stateRootHash) {
      failure(socket, id, `Build/schema/state-root mismatch: supervisor=${V4_BUILD_ID}/${V4_SCHEMA_VERSION}`, "EPROTO");
      return;
    }
    response(socket, id, { protocolVersion: V4_PROTOCOL_VERSION, schemaVersion: V4_SCHEMA_VERSION, buildId: V4_BUILD_ID, epoch, pid: process.pid });
    return;
  }
  if (request.epoch !== epoch) {
    failure(socket, id, "Supervisor fencing epoch is stale", "ESTALE");
    return;
  }
  if (request.token !== transportToken) {
    failure(socket, id, "Supervisor transport authentication failed", "EACCES");
    return;
  }
  const method = typeof request.method === "string" ? request.method : "";
  const params = request.params !== null && typeof request.params === "object" ? request.params : {};
  try {
    response(socket, id, await dispatch(method, params));
  } catch (error) {
    failure(socket, id, error);
  }
}
async function main() {
  if (!runtimeDir || !stateDir) throw new Error("V4 supervisor runtime/state directories are required");
  await mkdir4(runtimeDir, { recursive: true, mode: 448 });
  await chmod3(runtimeDir, 448);
  await mkdir4(stateDir, { recursive: true, mode: 448 });
  await chmod3(stateDir, 448);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES2) {
        failure(socket, "oversize", "V4 RPC frame exceeds 256 KiB", "E2BIG");
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = "";
      void handle(socket, line);
    });
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") process.exitCode = 2;
    else process.exitCode = 1;
  });
  server.listen(socketPath, async () => {
    await chmod3(socketPath, 384);
    await writeFile3(tokenPath, `${transportToken}
`, { encoding: "utf8", mode: 384 });
    await chmod3(tokenPath, 384);
    daemonReady = true;
    tickTimer = setInterval(() => void tick(), 1e3);
    tickTimer.unref();
  });
  const shutdown = () => {
    if (tickTimer) clearInterval(tickTimer);
    server.close(() => {
      void rm2(socketPath, { force: true }).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
void main().catch(() => {
  process.exitCode = 1;
});
