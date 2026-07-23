import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktrees, type CommandExecutor } from "../lead/git.ts";
import { observePullRequest } from "../lead/github.ts";
import { assertStableUuid, classifyIdentity, processAttestationMatches, type CmuxUuidSnapshot } from "./topology.ts";
import type { AgentsWorkspace, FeatureTrack, StableCmuxIdentity, V4ProjectState, WorkerTaskV4 } from "./types.ts";
import type { V4SupervisorCore } from "./supervisor.ts";

const execFileAsync = promisify(execFile);

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseJson(stdout: string, command: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const value = object(parsed);
    if (!value) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new Error(`cmux ${command} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checksHash(task: WorkerTaskV4): string {
  return createHash("sha256").update(JSON.stringify((task.checks ?? [])
    .map((check) => ({ name: check.name.trim(), status: check.status }))
    .sort((left, right) => left.name.localeCompare(right.name)))).digest("hex");
}

function identityFrom(value: Record<string, unknown>, fallback?: Partial<StableCmuxIdentity>): StableCmuxIdentity {
  const identity: StableCmuxIdentity = {
    windowUuid: string(value.window_id) ?? fallback?.windowUuid ?? "",
    workspaceUuid: string(value.workspace_id) ?? fallback?.workspaceUuid ?? "",
    paneUuid: string(value.pane_id) ?? fallback?.paneUuid ?? "",
    surfaceUuid: string(value.surface_id) ?? string(value.id) ?? fallback?.surfaceUuid ?? "",
    windowRef: string(value.window_ref) ?? fallback?.windowRef,
    workspaceRef: string(value.workspace_ref) ?? fallback?.workspaceRef,
    paneRef: string(value.pane_ref) ?? fallback?.paneRef,
    surfaceRef: string(value.surface_ref) ?? string(value.ref) ?? fallback?.surfaceRef,
  };
  assertStableUuid(identity.windowUuid, "windowUuid");
  assertStableUuid(identity.workspaceUuid, "workspaceUuid");
  assertStableUuid(identity.paneUuid, "paneUuid");
  assertStableUuid(identity.surfaceUuid, "surfaceUuid");
  return identity;
}

export class V4RuntimeAdapter {
  private readonly git: GitWorktrees;
  private agentsWorkspaceCreation?: Promise<AgentsWorkspace>;
  private cmuxSocketPath = process.env.CMUX_SOCKET_PATH;
  readonly execute: CommandExecutor;

  constructor(
    private readonly artifactRoot: string,
    private readonly extensionPath?: string,
    private readonly piCommand = "pi",
    private readonly failpoint = process.env.PI_LEAD_V4_FAILPOINT,
  ) {
    this.execute = async (command, args, options) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
          signal: options.signal,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: this.cmuxSocketPath ? { ...process.env, CMUX_SOCKET_PATH: this.cmuxSocketPath } : process.env,
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const failed = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, code: typeof failed.code === "number" ? failed.code : 1, killed: failed.killed };
      }
    };
    this.git = new GitWorktrees(this.execute);
  }

  setCmuxSocketPath(path: string | undefined): void {
    if (path) this.cmuxSocketPath = path;
  }

  private async cmux(args: string[], cwd: string, timeout = 30_000): Promise<Record<string, unknown>> {
    const result = await this.execute("cmux", ["--json", "--id-format", "both", ...args], { cwd, timeout });
    if (result.code !== 0) throw new Error(`cmux ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return parseJson(result.stdout, args[0]);
  }

  private fail(name: string): void {
    if (this.failpoint === name) throw new Error(`Injected V4 failpoint: ${name}`);
  }

  async ensureAgentsWorkspace(state: V4ProjectState, core: V4SupervisorCore): Promise<AgentsWorkspace> {
    if (state.agentsWorkspace) {
      assertStableUuid(state.agentsWorkspace.workspaceUuid, "persisted Agents workspaceUuid");
      if (!state.agentsWorkspace.paneUuid) throw new Error("Persisted Agents workspace has no stable pane UUID; topology is UNKNOWN");
      return state.agentsWorkspace;
    }
    if (!this.agentsWorkspaceCreation) {
      this.agentsWorkspaceCreation = this.createAgentsWorkspace(state, core).catch((error) => {
        this.agentsWorkspaceCreation = undefined;
        throw error;
      });
    }
    return this.agentsWorkspaceCreation;
  }

  private async createAgentsWorkspace(state: V4ProjectState, core: V4SupervisorCore): Promise<AgentsWorkspace> {
    this.fail("before-agents-workspace-create");
    const created = await this.cmux([
      "new-workspace",
      "--name", `Agents · ${state.projectName}`,
      "--cwd", state.projectRoot,
      "--focus", "false",
    ], state.projectRoot);
    this.fail("after-agents-workspace-create-before-record");
    const windowUuid = string(created.window_id);
    const workspaceUuid = string(created.workspace_id) ?? string(object(created.workspace)?.id);
    assertStableUuid(windowUuid, "Agents windowUuid");
    assertStableUuid(workspaceUuid, "Agents workspaceUuid");
    const panes = await this.cmux(["list-panes", "--workspace", workspaceUuid], state.projectRoot);
    const firstPane = Array.isArray(panes.panes) ? object(panes.panes[0]) : undefined;
    const paneUuid = string(firstPane?.id);
    assertStableUuid(paneUuid, "Agents paneUuid");
    const workspace: AgentsWorkspace = {
      ownershipToken: randomUUID(),
      sessionGeneration: 1,
      windowUuid,
      workspaceUuid,
      paneUuid,
      workspaceRef: string(created.workspace_ref),
      paneRef: string(firstPane?.ref),
      createdAt: new Date().toISOString(),
    };
    await core.recordAgentsWorkspace(workspace);
    this.fail("after-agents-workspace-record");
    return workspace;
  }

  async launchWorker(state: V4ProjectState, original: WorkerTaskV4, core: V4SupervisorCore): Promise<void> {
    const current = (await core.status()).tasks.find((task) => task.id === original.id);
    if (!current || current.processState !== "launching") return;
    try {
      let task = current;
      if (task.role === "implementation" && !task.baseSha) {
        this.fail("before-worktree-create");
        const project = await this.git.inspect(state.projectRoot);
        const created = await this.git.create(project, {
          taskId: task.id,
          title: task.title,
          baseBranch: task.baseBranch,
          destination: task.worktreePath,
        });
        this.fail("after-worktree-create-before-record");
        await core.recordWorkerProvision(task.id, {
          worktreePath: created.path,
          baseBranch: created.baseBranch,
          baseSha: created.baseSha,
          branchName: created.branchName,
        });
        task = (await core.status()).tasks.find((candidate) => candidate.id === task.id)!;
      }
      let refreshedState = await this.readState(core, state);
      let reviewEvidence = "";
      if (task.role === "review") {
        const parent = task.parentTaskId ? refreshedState.tasks[task.parentTaskId] : undefined;
        if (!parent?.baseSha) throw new Error("Review parent has no persisted base SHA");
        const capture = await this.git.reviewPacket(parent.worktreePath, parent.baseSha);
        await core.recordReviewTarget(task.id, {
          parentTaskId: parent.id,
          diffHash: capture.diffHash,
          headSha: capture.headSha,
          checksHash: checksHash(parent),
          capturedAt: new Date().toISOString(),
        });
        task = (await core.status()).tasks.find((candidate) => candidate.id === task.id)!;
        reviewEvidence = [
          "## Captured review target",
          `Parent: ${parent.id}`,
          `HEAD: ${capture.headSha}`,
          `Diff hash: ${capture.diffHash}`,
          `Checks hash: ${checksHash(parent)}`,
          "",
          "## Parent checks",
          ...(parent.checks ?? []).map((check) => `- ${check.name}: ${check.status}${check.details ? ` — ${check.details}` : ""}`),
          "",
          "## Exact diff",
          "```diff",
          capture.diff,
          "```",
        ].join("\n");
        refreshedState = await this.readState(core, state);
      }
      const agents = await this.ensureAgentsWorkspace(refreshedState, core);
      this.fail("before-worker-surface-create");
      const created = await this.cmux([
        "new-surface",
        "--workspace", agents.workspaceUuid,
        "--pane", agents.paneUuid!,
        "--type", "terminal",
        "--working-directory", task.worktreePath,
        "--focus", "false",
      ], state.projectRoot);
      this.fail("after-worker-surface-create-before-record");
      const identity = identityFrom(created, {
        windowUuid: agents.windowUuid,
        workspaceUuid: agents.workspaceUuid,
        paneUuid: agents.paneUuid,
      });
      await core.recordWorkerSurface(task.id, identity);
      this.fail("after-worker-surface-record-before-send");
      const artifacts = join(this.artifactRoot, "projects", state.projectId, "v4", "tasks", task.id);
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      const assignmentPath = join(artifacts, `assignment-${task.id}.md`);
      const scriptPath = join(artifacts, `launch-${task.id}.sh`);
      await writeFile(assignmentPath, this.workerPrompt(task, reviewEvidence), { encoding: "utf8", mode: 0o600 });
      await writeFile(scriptPath, this.workerScript(task, assignmentPath, state.projectRoot), { encoding: "utf8", mode: 0o700 });
      await chmod(scriptPath, 0o700);
      const send = await this.execute("cmux", [
        "send", "--workspace", identity.workspaceUuid, "--surface", identity.surfaceUuid, "--", `exec ${quote(scriptPath)}`,
      ], { cwd: state.projectRoot, timeout: 30_000 });
      if (send.code !== 0) throw new Error(`cmux send failed: ${send.stderr || send.stdout}`);
      this.fail("after-worker-send-before-enter");
      const enter = await this.execute("cmux", [
        "send-key", "--workspace", identity.workspaceUuid, "--surface", identity.surfaceUuid, "enter",
      ], { cwd: state.projectRoot, timeout: 30_000 });
      if (enter.code !== 0) throw new Error(`cmux send-key failed: ${enter.stderr || enter.stdout}`);
      this.fail("after-worker-enter-before-hello");
      // Remains launching until a generation/token/session/UUID-attested hello.
    } catch (error) {
      await core.markLaunchUnknown(original.id, error instanceof Error ? error.message : String(error));
    }
  }

  async launchLead(state: V4ProjectState, feature: FeatureTrack, core: V4SupervisorCore): Promise<void> {
    try {
      const resolved = feature.leadResolution;
      if (!resolved) throw new Error("Feature Lead has no explicit persisted model resolution");
      const artifacts = join(this.artifactRoot, "projects", state.projectId, "v4", "features", feature.id);
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      const scriptPath = join(artifacts, "launch-lead.sh");
      const args = [
        "--approve",
        ...(this.extensionPath ? ["--extension", this.extensionPath] : []),
        "--model", resolved.requestedModel,
        "--thinking", resolved.requestedThinking,
        `Attach as the non-focused Lead for feature: ${feature.title}`,
      ];
      await writeFile(scriptPath, [
        "#!/bin/sh",
        "set -eu",
        `cd ${quote(state.projectRoot)}`,
        "export PI_LEAD_V4=1",
        `export PI_LEAD_V4_FEATURE_ID=${quote(feature.id)}`,
        `export PI_LEAD_V4_FEATURE_TOKEN=${quote(feature.ownershipToken)}`,
        `exec ${[this.piCommand, ...args].map(quote).join(" ")}`,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o700 });
      await chmod(scriptPath, 0o700);
      this.fail("before-lead-workspace-create");
      const created = await this.cmux([
        "new-workspace",
        "--name", `Lead · ${feature.title}`,
        "--cwd", state.projectRoot,
        "--command", `exec ${quote(scriptPath)}`,
        "--focus", "false",
      ], state.projectRoot);
      this.fail("after-lead-workspace-create-before-record");
      const workspaceUuid = string(created.workspace_id);
      const windowUuid = string(created.window_id);
      assertStableUuid(workspaceUuid, "Lead workspaceUuid");
      assertStableUuid(windowUuid, "Lead windowUuid");
      const panes = await this.cmux(["list-panes", "--workspace", workspaceUuid], state.projectRoot);
      const pane = Array.isArray(panes.panes) ? object(panes.panes[0]) : undefined;
      const paneUuid = string(pane?.id);
      const surfaceUuid = Array.isArray(pane?.surface_ids) ? string(pane?.surface_ids[0]) : undefined;
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
        surfaceRef: Array.isArray(pane?.surface_refs) ? string(pane?.surface_refs[0]) : undefined,
      });
    } catch (error) {
      // Lead launch uncertainty is retained as unowned; never close or repeat a
      // possibly-live Lead workspace automatically.
      await core.markLeadLaunchUnknown(feature.id, error instanceof Error ? error.message : String(error));
    }
  }

  async topology(state: V4ProjectState): Promise<CmuxUuidSnapshot> {
    const capturedAt = new Date().toISOString();
    try {
      const windows = await this.cmux(["list-windows"], state.projectRoot);
      if (!Array.isArray(windows.windows)) throw new Error("list-windows omitted windows");
      const workspaceUuids = new Set<string>();
      const workspaceToWindow = new Map<string, string>();
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
      const paneToWorkspace = new Map<string, string>();
      const surfaceToPane = new Map<string, string>();
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
      const processPidsBySurface = new Map<string, Set<number>>();
      const groups = object(object(top.memory_diagnostic)?.children)?.groups;
      if (Array.isArray(groups)) for (const raw of groups) {
        const group = object(raw);
        const attributions = group?.attributions;
        if (!Array.isArray(attributions)) continue;
        for (const rawAttribution of attributions) {
          const attribution = object(rawAttribution);
          const surface = string(attribution?.surface_id);
          if (!surface || !Array.isArray(attribution?.pids)) continue;
          const pids = processPidsBySurface.get(surface) ?? new Set<number>();
          for (const pid of attribution.pids) if (typeof pid === "number") pids.add(pid);
          processPidsBySurface.set(surface, pids);
        }
      }
      return { complete: true, capturedAt, workspaceUuids, workspaceToWindow, paneToWorkspace, surfaceToPane, processPidsBySurface };
    } catch (error) {
      return { complete: false, capturedAt, workspaceUuids: new Set(), workspaceToWindow: new Map(), paneToWorkspace: new Map(), surfaceToPane: new Map(), processPidsBySurface: new Map(), error: error instanceof Error ? error.message : String(error) };
    }
  }

  async pollPullRequests(state: V4ProjectState, core: V4SupervisorCore): Promise<void> {
    for (const task of Object.values(state.tasks).filter((candidate) => candidate.role === "implementation" && candidate.status === "pr-ready-ci-pending" && candidate.prUrl)) {
      try {
        const observation = await observePullRequest(this.execute, task.worktreePath, task.prUrl!);
        if (observation.status === "pending") {
          await core.recordPullRequestObservation({ taskId: task.id, status: "pr-ready-ci-pending", checks: observation.checks, summary: `CI remains pending for ${task.id.slice(0, 8)}`, actionable: false });
          continue;
        }
        if (observation.status === "failed") {
          await core.recordPullRequestObservation({ taskId: task.id, status: "blocked", checks: observation.checks, summary: observation.reason ?? `CI failed for ${task.id.slice(0, 8)}`, actionable: true });
          continue;
        }
        const capture = await this.git.reviewPacket(task.worktreePath, task.baseSha);
        const reviewValid = task.review?.verdict === "approved"
          && task.review.diffHash === capture.diffHash
          && task.review.headSha === capture.headSha
          && task.review.checksHash === checksHash(task)
          && !capture.status
          && capture.headSha === observation.headSha;
        if (!reviewValid) {
          const hasApproval = task.review?.verdict === "approved";
          await core.recordPullRequestObservation({
            taskId: task.id,
            status: hasApproval ? "blocked" : "pr-ready-ci-pending",
            checks: observation.checks,
            summary: hasApproval
              ? `Green/merged PR for ${task.id.slice(0, 8)} no longer matches its exact clean HEAD/diff/check-bound approval`
              : `Green PR for ${task.id.slice(0, 8)} requires an independent exact review before it can become ready`,
            actionable: true,
          });
          continue;
        }
        await core.recordPullRequestObservation({
          taskId: task.id,
          status: observation.status === "merged" ? "merged" : "pr-ready-ci-green",
          checks: observation.checks,
          summary: `${task.id.slice(0, 8)} is ${observation.status === "merged" ? "merged" : "CI green with exact independent review"}`,
          actionable: false,
        });
      } catch (error) {
        await core.recordPullRequestObservation({ taskId: task.id, status: "pr-ready-ci-pending", checks: task.checks, summary: `CI observation unavailable for ${task.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`, actionable: false });
      }
    }
  }

  async reconcile(state: V4ProjectState, core: V4SupervisorCore): Promise<void> {
    const snapshot = await this.topology(state);
    for (const task of Object.values(state.tasks).filter((candidate) => candidate.processState === "running" || candidate.processState === "launching")) {
      if (!task.cmux || !task.runtime.pid) {
        const intentAge = Date.now() - Date.parse(task.updatedAt);
        if (intentAge > state.config.processHeartbeatSeconds * 1_000) {
          await core.markLaunchUnknown(task.id, "launch intent did not receive a complete generation/token/session/UUID/process hello before its deadline");
        }
        continue;
      }
      const presence = classifyIdentity(snapshot, task.cmux);
      const attested = processAttestationMatches(snapshot, task.cmux, task.runtime.pid);
      const heartbeatFresh = Date.now() - Date.parse(task.runtime.lastHeartbeatAt ?? "") <= state.config.processHeartbeatSeconds * 1_000;
      if (presence !== "present" || !attested || !heartbeatFresh) {
        await core.markLaunchUnknown(task.id, `topology=${presence}, processAttested=${attested}, heartbeatFresh=${heartbeatFresh}`);
      }
    }
  }

  private async readState(core: V4SupervisorCore, fallback: V4ProjectState): Promise<V4ProjectState> {
    const snapshot = await core.status();
    return {
      ...fallback,
      config: snapshot.config,
      agentsWorkspace: snapshot.agentsWorkspace,
      attachments: Object.fromEntries(snapshot.attachments.map((item) => [item.id, item])),
      features: Object.fromEntries(snapshot.features.map((item) => [item.id, item])),
      tasks: Object.fromEntries(snapshot.tasks.map((item) => [item.id, item])),
    };
  }

  async bindReviewVerdict(state: V4ProjectState, input: {
    taskId: string;
    review?: NonNullable<WorkerTaskV4["review"]>;
  }): Promise<typeof input> {
    if (!input.review) return input;
    const task = state.tasks[input.taskId];
    const target = task?.reviewTarget;
    const parent = task?.parentTaskId ? state.tasks[task.parentTaskId] : undefined;
    if (!task || task.role !== "review" || !target || !parent?.baseSha) throw new Error("Review target is unavailable");
    const capture = await this.git.reviewPacket(parent.worktreePath, parent.baseSha);
    if (capture.diffHash !== target.diffHash || capture.headSha !== target.headSha || checksHash(parent) !== target.checksHash) {
      throw new Error("Implementation diff, HEAD, or validation changed after review capture; create/rebind a fresh review generation");
    }
    return { ...input, review: { ...input.review, diffHash: target.diffHash, headSha: target.headSha, checksHash: target.checksHash } };
  }

  private workerPrompt(task: WorkerTaskV4, reviewEvidence = ""): string {
    return [
      "# V4 worker assignment",
      "",
      `Feature track: ${task.featureId}`,
      `Task: ${task.title}`,
      "",
      task.task,
      "",
      "## Acceptance criteria",
      ...(task.acceptanceCriteria.length ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`) : ["- Report concrete completion evidence"]),
      "",
      `Requested model: ${task.resolved.requestedModel}`,
      `Requested thinking: ${task.resolved.requestedThinking}`,
      "Call lead_worker_report_v4 for durable progress, blockers, checks, and handoff. Never merge, deploy, force-push, access credentials, or mutate unrelated external resources.",
      reviewEvidence,
    ].filter(Boolean).join("\n");
  }

  private workerScript(task: WorkerTaskV4, assignmentPath: string, projectRoot: string): string {
    const extension = this.extensionPath ? ["--extension", this.extensionPath] : [];
    const args = [
      "--approve",
      ...extension,
      "--session-id", task.sessionId,
      "--name", `${task.role} · ${task.title}`,
      "--append-system-prompt", assignmentPath,
      "--model", task.resolved.requestedModel,
      "--thinking", task.resolved.requestedThinking,
      ...(task.role === "implementation" ? [] : ["--tools", "read,bash,grep,find,ls,lead_worker_report_v4"]),
      `Begin the assigned ${task.role} work and report through lead_worker_report_v4.`,
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
      "",
    ].join("\n");
  }
}
