import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PiInvocation } from "./launcher.ts";
import { currentPiInvocation, renderLaunchScript, writeLaunchScript } from "./launcher.ts";
import { CmuxWorkers } from "./cmux.ts";
import type { CommandExecutor, GitProject } from "./git.ts";
import { GitWorktrees } from "./git.ts";
import { isGreptileEvidence, observePullRequest } from "./github.ts";
import {
  automaticLinearUpdateSafetyReason,
  linearLifecycleHasPendingWriteScope,
  linearLifecycleIsActionable,
  normalizeLinearIssueReference,
} from "./linear-lifecycle.ts";
import { effectiveWorkerPolicy, resolveWorkerPolicy } from "./policy.ts";
import { reviewPacket, workerPrompt } from "./prompt.ts";
import { createTaskId, LeadStore } from "./store.ts";
import {
  isTerminalTaskStatus,
  type AcceptanceEvidence,
  type CheckEvidence,
  type LeadTaskEvent,
  type LinearLifecycleState,
  type ProjectRecord,
  type ReviewEvidence,
  type ReviewTarget,
  type TaskRecord,
  type TaskStatus,
  type WorkerMessage,
  type WorkerRole,
} from "./types.ts";

export interface DelegateInput {
  title: string;
  task: string;
  role?: WorkerRole;
  issue?: string;
  linearIssue?: string;
  acceptanceCriteria?: string[];
  baseBranch?: string;
  parentTaskId?: string;
  model?: string;
  thinking?: import("./types.ts").ThinkingLevel;
}

export interface DelegateRuntime {
  cwd: string;
  sessionFile?: string;
  cmuxWorkspaceId?: string;
  cmuxSurfaceId?: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export interface WorkerReportInput {
  status?: TaskStatus;
  summary?: string;
  blockedReason?: string;
  handoff?: string;
  prUrl?: string;
  commitSha?: string;
  checks?: CheckEvidence[];
  reviewVerdict?: "approved" | "changes-requested";
  rebindReviewTarget?: boolean;
  acceptance?: AcceptanceEvidence[];
  findings?: string[];
}

const projectQueues = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (projectQueues.get(key) === current) projectQueues.delete(key);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function cleanCriteria(criteria: string[] | undefined): string[] {
  return [...new Set((criteria ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 50);
}

function normalizedCriterion(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function validationEvidenceHash(checks: CheckEvidence[]): string {
  // Hash name + status of non-Greptile checks only: cosmetic re-reports (new CI
  // run IDs, refreshed details) and additive Greptile evidence must not
  // invalidate an otherwise-valid review fingerprint. Greptile stays on the task
  // for display/readiness reporting, but never joins any fingerprint.
  const normalized = checks
    .filter((check) => !isGreptileEvidence(check))
    .map((check) => ({ name: check.name.trim(), status: check.status }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function validationEvidenceIsComplete(checks: CheckEvidence[]): boolean {
  // Greptile is additive evidence: it cannot satisfy the passing-check
  // requirement on its own, and terminal Greptile entries never block.
  const validation = checks.filter((check) => !isGreptileEvidence(check));
  return validation.some((check) => check.status === "passed")
    && validation.every((check) => check.name.trim() && check.status !== "failed" && check.status !== "pending");
}

export function readinessEvidenceHash(task: TaskRecord): string {
  const evidence = {
    status: task.status,
    blockedReason: task.blockedReason,
    baseSha: task.baseSha,
    worktreePath: task.worktreePath,
    checksHash: validationEvidenceHash(task.checks),
    review: task.review ? {
      verdict: task.review.verdict,
      reviewedAt: task.review.reviewedAt,
      diffHash: task.review.diffHash,
      headSha: task.review.headSha,
      checksHash: task.review.checksHash,
    } : undefined,
    pullRequest: task.pullRequest ? {
      url: task.pullRequest.url,
      headSha: task.pullRequest.headSha,
      mergeState: task.pullRequest.mergeState,
      checksHash: validationEvidenceHash(task.pullRequest.checks),
      // observedAt is intentionally excluded: it changes on every CI poll and
      // would otherwise spuriously invalidate verdict/rebind re-checks.
    } : undefined,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

async function privateText(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function taskStatusAfterReport(current: TaskRecord, input: WorkerReportInput): TaskStatus {
  if (input.status) return input.status;
  if (input.reviewVerdict) return "completed";
  if (input.prUrl) return "pr-ready-ci-pending";
  return current.status;
}

const LAUNCH_CLAIM_LEASE_MS = 5 * 60_000;

export class LeadCoordinator {
  private readonly git: GitWorktrees;
  private readonly lastTopologyPollAt = new Map<string, number>();

  constructor(
    readonly store: LeadStore,
    private readonly execute: CommandExecutor,
    private readonly invocation: PiInvocation = currentPiInvocation(),
    private readonly extensionPath?: string,
  ) {
    this.git = new GitWorktrees(execute);
  }

  async project(runtime: DelegateRuntime): Promise<{ git: GitProject; record: ProjectRecord }> {
    const git = await this.git.inspect(runtime.cwd, runtime.signal);
    const record = await this.store.ensureProject({
      projectRoot: git.root,
      projectName: git.name,
      leadSessionFile: runtime.sessionFile,
      cmuxWorkspaceId: runtime.cmuxWorkspaceId,
      cmuxSurfaceId: runtime.cmuxSurfaceId,
    });
    return { git, record };
  }

  async delegate(input: DelegateInput, runtime: DelegateRuntime): Promise<TaskRecord> {
    const context = await this.project(runtime);
    return serialized(context.record.projectId, () => this.delegateSerialized(input, runtime, context.git, context.record));
  }

  private async delegateSerialized(
    input: DelegateInput,
    runtime: DelegateRuntime,
    gitProject: GitProject,
    initialProject: ProjectRecord,
  ): Promise<TaskRecord> {
    const latestProject = await this.store.readProject(initialProject.projectId);
    let project: ProjectRecord = initialProject;
    if (latestProject?.cmux && initialProject.cmux && latestProject.cmux.workspaceId === initialProject.cmux.workspaceId) {
      project = {
        ...initialProject,
        cmux: { ...initialProject.cmux, helperPaneId: latestProject.cmux.helperPaneId },
      };
    }
    if (!project.cmux?.workspaceId || !project.cmux.callerSurfaceId) {
      throw new Error("Visible workers require CMUX_WORKSPACE_ID and CMUX_SURFACE_ID from the caller session");
    }
    const role = input.role ?? "implementation";
    if (role === "review" && !input.parentTaskId) throw new Error("Review workers require parentTaskId");
    if (role !== "review" && input.parentTaskId) throw new Error("parentTaskId is only valid for review workers");

    const parent = input.parentTaskId
      ? await this.store.requireTask(project.projectId, input.parentTaskId)
      : undefined;
    if (parent && !parent.baseSha) throw new Error("The implementation task has no review base SHA");

    const linearIssueIdentifier = normalizeLinearIssueReference(input.linearIssue);
    if (input.linearIssue && !linearIssueIdentifier) {
      throw new Error(`Invalid Linear issue identifier or URL: ${input.linearIssue}`);
    }
    const id = createTaskId();
    const createdAt = timestamp();
    const resolvedWorker = resolveWorkerPolicy(project, { role, model: input.model, thinking: input.thinking }, runtime);
    const task: TaskRecord = {
      schemaVersion: 2,
      id,
      projectId: project.projectId,
      role,
      parentTaskId: parent?.id,
      brief: {
        title: input.title.trim(),
        task: input.task.trim(),
        issue: input.issue?.trim() || parent?.brief.issue,
        acceptanceCriteria: cleanCriteria(input.acceptanceCriteria ?? parent?.brief.acceptanceCriteria),
      },
      status: "starting",
      runtime: { state: "starting", surfaceHealth: "missing" },
      resolvedWorker,
      launchState: "queued",
      baseBranch: parent?.baseBranch,
      baseSha: parent?.baseSha,
      branchName: parent?.branchName,
      worktreePath: parent?.worktreePath ?? (role === "research" ? gitProject.root : this.store.worktreeDirectory(project.projectId, id)),
      sessionId: id,
      checks: [],
      messages: [],
      linear: role === "implementation" && linearIssueIdentifier ? {
        issueIdentifier: linearIssueIdentifier,
        desiredStateType: "started",
        status: "pending",
        attempts: 0,
        promptCount: 0,
        updatedAt: createdAt,
      } : undefined,
      leadObservedStatus: "starting",
      leadObservedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
    if (!task.brief.title || !task.brief.task) throw new Error("Worker title and task are required");
    await this.store.createTask(task);

    let current = task;
    try {
      if (role === "implementation") {
        runtime.onStage?.("creating isolated worktree");
        const worktree = await this.git.create(gitProject, {
          taskId: id,
          title: task.brief.title,
          baseBranch: input.baseBranch,
          destination: task.worktreePath,
          signal: runtime.signal,
        });
        current = await this.store.updateTask(task.projectId, id, (value) => ({
          ...value,
          baseBranch: worktree.baseBranch,
          baseSha: worktree.baseSha,
          branchName: worktree.branchName,
          worktreePath: worktree.path,
          setupWarnings: worktree.warnings,
        }));
      }

      const artifactDirectory = this.store.taskArtifactDirectory(task.projectId, id);
      let packetPath: string | undefined;
      if (role === "review" && parent) {
        runtime.onStage?.("capturing issue, diff, and validation evidence");
        const git = await this.git.reviewPacket(parent.worktreePath, parent.baseSha, runtime.signal);
        current = await this.store.updateTask(task.projectId, id, (value) => ({
          ...value,
          reviewTarget: {
            parentTaskId: parent.id,
            diffBaseSha: parent.baseSha!,
            diffHash: git.diffHash,
            headSha: git.headSha,
            checksHash: validationEvidenceHash(parent.checks),
            capturedAt: timestamp(),
          },
        }));
        packetPath = join(artifactDirectory, "review-packet.md");
        await privateText(packetPath, reviewPacket(current, parent, git));
      }
      const promptPath = join(artifactDirectory, "assignment.md");
      await privateText(promptPath, workerPrompt(current, packetPath));
      const launchScriptPath = join(artifactDirectory, "launch-worker.sh");
      await writeLaunchScript(launchScriptPath, renderLaunchScript({
        task: current,
        stateDir: this.store.root,
        projectRoot: gitProject.root,
        promptPath,
        invocation: this.invocation,
        extensionPath: this.extensionPath,
        model: resolvedWorker.model,
        thinking: resolvedWorker.thinking,
      }));
      current = await this.store.updateTask(task.projectId, id, (value) => ({
        ...value,
        promptPath,
        launchScriptPath,
      }));

      await this.reclaimEligible(project, runtime.signal);
      const visible = (await this.store.listTasks(project.projectId)).filter((candidate) => candidate.surface && candidate.launchState !== "retired" && candidate.runtime?.surfaceHealth !== "missing").length;
      if (visible >= effectiveWorkerPolicy(project.workers).maxVisibleSurfaces) {
        runtime.onStage?.("worker queued: visible surface cap is full");
        return current;
      }
      runtime.onStage?.("opening visible Pi session in cmux");
      return this.launchTask(project, current, runtime.signal);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await this.store.updateTask(task.projectId, id, (value) => ({ ...value, status: "failed", failure })).catch(() => undefined);
      await this.store.updateRuntime(task.projectId, id, (runtimeState) => ({
        ...runtimeState,
        state: "offline",
        terminalAt: runtimeState.terminalAt ?? timestamp(),
        shutdownReason: `Worker launch failed: ${failure}`,
      })).catch(() => undefined);
      throw error;
    }
  }

  async list(projectId: string): Promise<TaskRecord[]> {
    return this.store.listTasks(projectId);
  }

  private async launchTask(project: ProjectRecord, task: TaskRecord, signal?: AbortSignal, queuedLaunch = false): Promise<TaskRecord> {
    if (!project.cmux?.workspaceId || !task.launchScriptPath) throw new Error("Queued worker is missing cmux or launch script identity");
    if (task.surface) return task;
    const reserved = await this.store.updateProject(project.projectId, async (current) => {
      const tasks = await this.store.listTasks(project.projectId);
      const claims = Object.fromEntries(Object.entries(current.surfaceLaunchClaims ?? {}).filter(([, value]) => {
        const claimedAt = Date.parse(value);
        return Number.isFinite(claimedAt) && Date.now() - claimedAt < LAUNCH_CLAIM_LEASE_MS;
      }));
      const visible = tasks.filter((candidate) => candidate.surface && candidate.launchState !== "retired" && candidate.runtime?.surfaceHealth !== "missing").length;
      if (!claims[task.id] && visible + Object.keys(claims).length >= effectiveWorkerPolicy(current.workers).maxVisibleSurfaces) {
        return { ...current, surfaceLaunchClaims: claims };
      }
      return { ...current, surfaceLaunchClaims: { ...claims, [task.id]: timestamp() } };
    });
    if (!reserved.surfaceLaunchClaims?.[task.id]) return task;
    const cmux = new CmuxWorkers(this.execute, project.projectRoot, project.cmux.workspaceId);
    const claimId = createTaskId();
    const claimed = await this.store.updateTask(project.projectId, task.id, (current) => {
      const claimedAt = Date.parse(current.launchClaimedAt ?? "");
      if (current.surface || (current.launchState === "launching" && Number.isFinite(claimedAt) && Date.now() - claimedAt < LAUNCH_CLAIM_LEASE_MS)) return current;
      return { ...current, launchState: "launching", launchClaimId: claimId, launchClaimedAt: timestamp() };
    });
    if (claimed.surface || claimed.launchClaimId !== claimId) return claimed;
    const placement = await cmux.createSurface(
      project,
      `${task.role === "review" ? "Review" : task.role === "research" ? "Research" : "Worker"} · ${task.brief.title}`,
      task.worktreePath,
      signal,
    );
    const renewedAt = timestamp();
    await this.store.updateProject(project.projectId, (current) => ({
      ...current,
      surfaceLaunchClaims: { ...(current.surfaceLaunchClaims ?? {}), [task.id]: renewedAt },
      cmux: current.cmux ? { ...current.cmux, helperPaneId: placement.helperPaneId } : current.cmux,
    }));
    let current = await this.store.updateTask(project.projectId, task.id, (value) => ({
      ...value,
      surface: placement.surface,
      launchState: "launching",
      launchClaimedAt: value.launchClaimId === claimId ? renewedAt : value.launchClaimedAt,
      runtime: {
        ...(value.runtime ?? { state: "starting" }),
        state: "starting",
        surfaceHealth: "healthy",
        telemetryError: undefined,
        retiredAt: undefined,
        retiredSurfaceId: undefined,
      },
    }));
    await cmux.launch(placement.surface.surfaceId, task.launchScriptPath, signal);
    const launchedAt = timestamp();
    const launchReasonKey = `queued-launched:${task.id}`;
    current = await this.store.updateTask(project.projectId, task.id, (value) => {
      const launchReason = `Queued worker launched exactly once in ${placement.surface.surfaceId}; runtime is starting${value.linear ? ` and Linear ${value.linear.issueIdentifier} lifecycle is ready to resume` : ""}`;
      const hasLaunchEvent = (value.leadEvents ?? []).some((event) => event.runtimeReasonKey === launchReasonKey);
      return {
        ...value,
        status: "running",
        launchState: "launched",
        launchClaimId: undefined,
        launchClaimedAt: undefined,
        workerStartedAt: launchedAt,
        leadObservedStatus: "running",
        leadObservedAt: launchedAt,
        failure: undefined,
        runtime: {
          ...(value.runtime ?? { state: "starting" }),
          state: "starting",
          surfaceHealth: "healthy",
          telemetryError: undefined,
          retiredAt: undefined,
          retiredSurfaceId: undefined,
        },
        leadEvents: queuedLaunch && !hasLaunchEvent ? [...(value.leadEvents ?? []), {
          id: createTaskId(),
          kind: "runtime" as const,
          status: "running" as const,
          createdAt: launchedAt,
          summary: launchReason,
          runtimeReasonKey: launchReasonKey,
          runtimeState: "starting" as const,
          runtimeReason: launchReason,
        }] : value.leadEvents,
      };
    });
    await cmux.setTaskStatus(task.id, "running", signal);
    await this.store.updateProject(project.projectId, (value) => {
      const claims = { ...(value.surfaceLaunchClaims ?? {}) };
      delete claims[task.id];
      return { ...value, surfaceLaunchClaims: claims };
    });
    return this.store.requireTask(project.projectId, task.id);
  }

  async reconcile(projectId: string, signal?: AbortSignal): Promise<TaskRecord[]> {
    const project = await this.store.readProject(projectId);
    if (!project?.cmux?.workspaceId) return this.store.listTasks(projectId);
    const cmux = new CmuxWorkers(this.execute, project.projectRoot, project.cmux.workspaceId);
    let topology: Awaited<ReturnType<CmuxWorkers["topology"]>>;
    try {
      topology = await cmux.topology(signal);
    } catch (error) {
      const telemetryError = `cmux topology unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const tasks = await this.store.listTasks(projectId);
      for (const task of tasks.filter((candidate) => Boolean(candidate.surface) && candidate.launchState !== "retired")) {
        await this.store.updateRuntime(projectId, task.id, (runtime) => ({ ...runtime, telemetryError }));
      }
      return this.store.listTasks(projectId);
    }
    if (project.cmux.helperPaneId && !topology.paneIds.has(project.cmux.helperPaneId)) {
      await this.store.updateProject(projectId, (current) => ({
        ...current,
        cmux: current.cmux ? { ...current.cmux, helperPaneId: undefined } : undefined,
      }));
    }
    const tasks = await this.store.listTasks(projectId);
    for (const task of tasks) {
      if (!task.surface || task.launchState === "retired") continue;
      const inPane = topology.surfacesByPane.get(task.surface.paneId)?.has(task.surface.surfaceId) ?? false;
      const health = !inPane || !topology.health.has(task.surface.surfaceId)
        ? "missing" as const
        : topology.health.get(task.surface.surfaceId) === "detached"
          ? "detached" as const
          : "healthy" as const;
      if (health === "healthy") {
        await this.store.updateRuntime(projectId, task.id, (runtime) => ({
          ...runtime,
          surfaceHealth: "healthy",
          telemetryError: undefined,
          state: runtime.state === "detached" ? "idle" : runtime.state,
          attentionReason: runtime.state === "detached" ? undefined : runtime.attentionReason,
          surfaceTransitionKey: undefined,
        }));
      } else if (!isTerminalTaskStatus(task.status)) {
        const reason = health === "missing"
          ? `Persisted worker surface ${task.surface.surfaceId} is missing; session ${task.sessionId} is resumable`
          : `Worker surface ${task.surface.surfaceId} is detached or non-windowed; session ${task.sessionId} is resumable`;
        const transitionKey = task.runtime?.surfaceHealth === health && task.runtime.surfaceTransitionKey
          ? task.runtime.surfaceTransitionKey
          : `surface:${health}:${task.surface.surfaceId}:${timestamp()}`;
        await this.store.updateRuntime(projectId, task.id, (runtime) => ({ ...runtime, surfaceHealth: health, surfaceTransitionKey: transitionKey, telemetryError: undefined }));
        await this.store.runtimeAttention(projectId, task.id, transitionKey, reason, "detached");
      } else {
        await this.store.updateRuntime(projectId, task.id, (runtime) => ({ ...runtime, surfaceHealth: health, telemetryError: undefined }));
      }
    }
    return this.store.listTasks(projectId);
  }

  async reclaimEligible(project: ProjectRecord, signal?: AbortSignal): Promise<number> {
    if (!project.cmux?.workspaceId) return 0;
    const policy = effectiveWorkerPolicy(project.workers);
    const cutoff = Date.now() - policy.terminalSurfaceRetentionMinutes * 60_000;
    const tasks = await this.store.listTasks(project.projectId);
    let closed = 0;
    for (const task of tasks) {
      if (!task.surface || task.launchState === "retired" || task.status === "blocked" || !isTerminalTaskStatus(task.status)) continue;
      const terminalAt = Date.parse(task.runtime?.terminalAt ?? task.updatedAt);
      if (!Number.isFinite(terminalAt) || terminalAt > cutoff || task.runtime?.state !== "offline") continue;
      const retired = await this.retire(project.projectId, task.id, false, signal);
      if (retired.launchState === "retired") closed++;
    }
    return closed;
  }

  async supervise(projectId: string, signal?: AbortSignal, forceTopology = false): Promise<TaskRecord[]> {
    const project = await this.store.readProject(projectId);
    if (!project) return this.store.listTasks(projectId);
    const policy = effectiveWorkerPolicy(project.workers);
    const lastPoll = this.lastTopologyPollAt.get(projectId) ?? 0;
    let tasks: TaskRecord[];
    if (forceTopology || Date.now() - lastPoll >= policy.supervisionSeconds * 1_000) {
      this.lastTopologyPollAt.set(projectId, Date.now());
      tasks = await this.reconcile(projectId, signal);
    } else {
      tasks = await this.store.listTasks(projectId);
    }
    const nowMs = Date.now();
    for (const task of tasks) {
      if (!isTerminalTaskStatus(task.status) && task.workerStartedAt && task.runtime?.state === "offline"
        && !["reload", "new", "resume", "fork"].includes(task.runtime.shutdownReason ?? "")) {
        await this.store.runtimeAttention(projectId, task.id, `offline:${task.workerStartedAt}`, task.runtime.attentionReason ?? "Worker runtime is offline without a terminal handoff", "offline");
      }
      if (isTerminalTaskStatus(task.status) || !task.workerStartedAt || task.runtime?.state === "offline" || task.runtime?.state === "detached") continue;
      const heartbeat = Date.parse(task.runtime?.lastHeartbeatAt ?? task.workerStartedAt);
      if (Number.isFinite(heartbeat) && nowMs - heartbeat > policy.staleAfterSeconds * 1_000) {
        const reason = `No deterministic worker heartbeat for ${Math.floor((nowMs - heartbeat) / 1_000)}s`;
        await this.store.runtimeAttention(projectId, task.id, `stale:${task.runtime?.lastHeartbeatAt ?? task.workerStartedAt}`, reason, "stale");
      }
    }
    await this.reclaimEligible(project, signal);
    tasks = await this.store.listTasks(projectId);
    let visible = tasks.filter((task) => task.surface && task.launchState !== "retired" && task.runtime?.surfaceHealth !== "missing").length;
    for (const queued of tasks.filter((task) => {
      if (!task.launchScriptPath) return false;
      if (task.launchState === "queued") return true;
      const claimedAt = Date.parse(task.launchClaimedAt ?? "");
      return task.launchState === "launching" && (!Number.isFinite(claimedAt) || Date.now() - claimedAt >= LAUNCH_CLAIM_LEASE_MS);
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (visible >= policy.maxVisibleSurfaces) break;
      const launched = await this.launchTask(await this.store.readProject(projectId) ?? project, queued, signal, true);
      if (launched.surface && launched.launchState === "launched") visible++;
    }
    return this.store.listTasks(projectId);
  }

  async requestStop(projectId: string, taskId: string, reason = "Graceful stop requested by operator"): Promise<TaskRecord> {
    const task = await this.store.requireTask(projectId, taskId);
    const stopped = await this.store.updateTask(projectId, task.id, (current) => ({ ...current, status: "stopped", summary: reason }));
    await this.store.updateRuntime(projectId, task.id, (runtime) => ({
      ...runtime,
      shutdownRequestedAt: timestamp(),
      shutdownReason: reason,
      terminalAt: runtime.terminalAt ?? timestamp(),
    }));
    return this.store.requireTask(projectId, stopped.id);
  }

  async retire(projectId: string, taskId: string, explicit = true, signal?: AbortSignal): Promise<TaskRecord> {
    const task = await this.store.requireTask(projectId, taskId);
    if (!task.surface) return task;
    if (explicit && task.runtime?.state !== "offline") throw new Error("Gracefully stop the Pi worker and wait for offline runtime state before retiring its surface");
    if (!explicit && task.status === "blocked") throw new Error("Blocked workers are never auto-retired");
    const cmux = new CmuxWorkers(this.execute, task.worktreePath, task.surface.workspaceId);
    try {
      await cmux.closeSurface(task.surface.surfaceId, signal);
    } catch (error) {
      if (explicit) throw error;
      return task;
    }
    const surfaceId = task.surface.surfaceId;
    const retiredAt = timestamp();
    return this.store.updateTask(projectId, task.id, (current) => ({
      ...current,
      surface: undefined,
      launchState: "retired",
      runtime: {
        ...(current.runtime ?? { state: "offline" }),
        state: "offline",
        surfaceHealth: "missing",
        retiredAt,
        retiredSurfaceId: surfaceId,
      },
    }));
  }

  async resume(projectId: string, taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    const project = await this.store.readProject(projectId);
    if (!project?.cmux?.workspaceId) throw new Error("Lead project cmux identity is unavailable");
    const task = await this.store.requireTask(projectId, taskId);
    if (!task.launchScriptPath) throw new Error("Worker has no persisted launch script to resume");

    // A stale semantic/runtime label is never enough to launch a second Pi. A
    // fresh exact topology + health snapshot must prove the old owned surface
    // absent or non-windowed. Non-windowed surfaces are closed by exact ID and
    // verified absent before the persistent session ID is launched again.
    const cmux = new CmuxWorkers(this.execute, task.worktreePath, project.cmux.workspaceId);
    const storedSurfaceId = task.surface?.surfaceId ?? task.runtime?.retiredSurfaceId;
    let topology = await cmux.topology(signal);
    const contains = (surfaceId: string) => [...topology.surfacesByPane.values()].some((surfaces) => surfaces.has(surfaceId));
    if (storedSurfaceId && (contains(storedSurfaceId) || topology.health.has(storedSurfaceId))) {
      if (topology.health.get(storedSurfaceId) !== "detached") {
        throw new Error(`Refusing to resume while owned surface ${storedSurfaceId} is still live and healthy`);
      }
      await cmux.closeSurface(storedSurfaceId, signal);
      topology = await cmux.topology(signal);
      if ([...topology.surfacesByPane.values()].some((surfaces) => surfaces.has(storedSurfaceId)) || topology.health.has(storedSurfaceId)) {
        throw new Error(`Refusing to resume because detached surface ${storedSurfaceId} could not be retired exactly`);
      }
    } else if (!storedSurfaceId && task.launchState !== "retired") {
      throw new Error("Refusing to resume without a persisted old surface identity or retired-session record");
    }

    await this.reclaimEligible(project, signal);
    const queued = await this.store.updateTask(projectId, task.id, (current) => ({
      ...current,
      surface: undefined,
      launchState: "queued",
      runtime: {
        ...(current.runtime ?? { state: "offline" }),
        state: "offline",
        surfaceHealth: "missing",
        telemetryError: undefined,
        retiredSurfaceId: storedSurfaceId ?? current.runtime?.retiredSurfaceId,
      },
    }));
    const tasks = await this.store.listTasks(projectId);
    if (tasks.filter((candidate) => candidate.id !== task.id && candidate.surface && candidate.launchState !== "retired" && candidate.runtime?.surfaceHealth !== "missing").length >= effectiveWorkerPolicy(project.workers).maxVisibleSurfaces) {
      return queued;
    }
    return this.launchTask(await this.store.readProject(projectId) ?? project, queued, signal, true);
  }

  async focus(projectId: string, taskId: string, signal?: AbortSignal): Promise<void> {
    const task = await this.store.requireTask(projectId, taskId);
    if (!task.surface) throw new Error("Worker has no visible surface; resume it first");
    await new CmuxWorkers(this.execute, task.worktreePath, task.surface.workspaceId).focusSurface(task.surface.surfaceId, signal);
  }

  async updateLinearLifecycle(
    projectId: string,
    taskId: string,
    update: (current: LinearLifecycleState) => LinearLifecycleState,
  ): Promise<TaskRecord> {
    return this.store.updateTask(projectId, taskId, (current) => {
      if (!current.linear) return current;
      return { ...current, linear: update(current.linear) };
    });
  }

  async claimLinearLifecyclePrompt(projectId: string, taskId: string, cooldownMs = 5 * 60_000): Promise<TaskRecord | undefined> {
    const claimId = createTaskId();
    const claimedAt = timestamp();
    const updated = await this.store.updateTask(projectId, taskId, (current) => {
      if (!linearLifecycleIsActionable(current) || !current.linear) return current;
      const existingClaim = Date.parse(current.linear.promptClaimedAt ?? "");
      const prompted = Date.parse(current.linear.promptedAt ?? "");
      if ((Number.isFinite(existingClaim) && Date.now() - existingClaim < cooldownMs)
        || (Number.isFinite(prompted) && Date.now() - prompted < cooldownMs)) return current;
      return {
        ...current,
        linear: { ...current.linear, promptClaimId: claimId, promptClaimedAt: claimedAt, updatedAt: claimedAt },
      };
    });
    return updated.linear?.promptClaimId === claimId ? updated : undefined;
  }

  async claimLinearLifecycleWrite(
    projectId: string,
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<TaskRecord | undefined> {
    const claimId = createTaskId();
    const claimedAt = timestamp();
    const updated = await this.store.updateTask(projectId, taskId, (current) => {
      if (!linearLifecycleHasPendingWriteScope(current) || automaticLinearUpdateSafetyReason([current], input)) return current;
      if (!current.linear) return current;
      return {
        ...current,
        linear: { ...current.linear, writeClaimId: claimId, writeClaimedAt: claimedAt, updatedAt: claimedAt },
      };
    });
    return updated.linear?.writeClaimId === claimId ? updated : undefined;
  }

  async markLeadObserved(projectId: string, taskId: string, expectedStatus?: TaskStatus): Promise<TaskRecord> {
    return this.store.updateTask(projectId, taskId, (current) => {
      if (expectedStatus && current.status !== expectedStatus) return current;
      return { ...current, leadObservedStatus: current.status, leadObservedAt: timestamp() };
    });
  }

  async claimLeadEvent(projectId: string, taskId: string, candidate: LeadTaskEvent, leaseMs = 5 * 60_000): Promise<LeadTaskEvent | undefined> {
    const claimId = createTaskId();
    const claimedAt = timestamp();
    const updated = await this.store.updateTask(projectId, taskId, (current) => {
      let events = current.leadEvents ?? [];
      if (!events.some((event) => event.id === candidate.id) && candidate.id.startsWith(`legacy:${current.id}:`)) {
        events = [...events, candidate];
      }
      return {
        ...current,
        leadEvents: events.map((event) => {
          if (event.id !== candidate.id || event.observedAt) return event;
          const existing = Date.parse(event.deliveryClaimedAt ?? "");
          if (event.deliveryClaimId && Number.isFinite(existing) && Date.now() - existing < leaseMs) return event;
          return { ...event, deliveryClaimId: claimId, deliveryClaimedAt: claimedAt };
        }),
      };
    });
    const claimed = updated.leadEvents?.find((event) => event.id === candidate.id);
    return claimed?.deliveryClaimId === claimId ? claimed : undefined;
  }

  async markLeadEventsObserved(projectId: string, taskId: string, eventIds: string[]): Promise<TaskRecord> {
    const observedAt = timestamp();
    const ids = new Set(eventIds);
    return this.store.updateTask(projectId, taskId, (current) => {
      const leadEvents = (current.leadEvents ?? []).map((event) =>
        ids.has(event.id) && !event.observedAt
          ? { ...event, observedAt, deliveryClaimId: undefined, deliveryClaimedAt: undefined }
          : event);
      const legacyObserved = eventIds.some((id) => id.startsWith(`legacy:${current.id}:`));
      const allObserved = leadEvents.every((event) => Boolean(event.observedAt));
      return {
        ...current,
        leadEvents,
        leadObservedStatus: legacyObserved || allObserved ? current.status : current.leadObservedStatus,
        leadObservedAt: legacyObserved || allObserved ? observedAt : current.leadObservedAt,
      };
    });
  }

  async message(projectId: string, taskId: string, message: string, signal?: AbortSignal): Promise<TaskRecord> {
    const text = message.trim();
    if (!text) throw new Error("Worker message cannot be empty");
    const task = await this.store.requireTask(projectId, taskId);
    const queued: WorkerMessage = { id: createTaskId(), text, createdAt: timestamp() };
    const updated = await this.store.updateTask(projectId, task.id, (current) => ({
      ...current,
      messages: [...(current.messages ?? []).slice(-99), queued],
    }));
    if (updated.surface) {
      const cmux = new CmuxWorkers(this.execute, updated.worktreePath, updated.surface.workspaceId);
      await cmux.flash(updated.surface.surfaceId, signal);
    }
    return updated;
  }

  async claimMessages(projectId: string, taskId: string, limit = 5): Promise<WorkerMessage[]> {
    const claimed: WorkerMessage[] = [];
    await this.store.updateTask(projectId, taskId, (current) => ({
      ...current,
      messages: (current.messages ?? []).map((message) => {
        if (message.deliveredAt || claimed.length >= limit) return message;
        const delivered = { ...message, deliveredAt: timestamp() };
        claimed.push(delivered);
        return delivered;
      }),
    }));
    return claimed;
  }

  async acknowledgeMessage(projectId: string, taskId: string, messageId: string): Promise<void> {
    await this.store.updateTask(projectId, taskId, (current) => ({
      ...current,
      messages: (current.messages ?? []).filter((message) => message.id !== messageId),
    }));
  }

  async releaseMessage(projectId: string, taskId: string, messageId: string): Promise<void> {
    await this.store.updateTask(projectId, taskId, (current) => ({
      ...current,
      messages: (current.messages ?? []).map((message) =>
        message.id === messageId ? { ...message, deliveredAt: undefined } : message),
    }));
  }

  async rebindReviewTarget(projectId: string, taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    const task = await this.store.requireTask(projectId, taskId);
    if (task.role !== "review" || !task.parentTaskId) {
      throw new Error("Only a bound review worker can rebind its review target");
    }
    const parent = await this.store.requireTask(projectId, task.parentTaskId);
    if (!parent.baseSha) throw new Error("The implementation task has no review base SHA");
    const expectedParentHash = readinessEvidenceHash(parent);
    const capture = await this.git.reviewPacket(parent.worktreePath, parent.baseSha, signal);
    // Verify the parent readiness fingerprint before touching durable state so a
    // concurrent mutation cannot leave a persisted target pointing at a stale packet.
    const parentAfter = await this.store.requireTask(projectId, parent.id);
    if (readinessEvidenceHash(parentAfter) !== expectedParentHash) {
      throw new Error("Implementation evidence changed during the rebind; retry the rebind against the current HEAD");
    }
    const target: ReviewTarget = {
      parentTaskId: parent.id,
      diffBaseSha: parent.baseSha,
      diffHash: capture.diffHash,
      headSha: capture.headSha,
      checksHash: validationEvidenceHash(parentAfter.checks),
      capturedAt: timestamp(),
    };
    const packetPath = join(this.store.taskArtifactDirectory(projectId, task.id), "review-packet.md");
    await privateText(packetPath, reviewPacket(task, parentAfter, capture));
    return this.store.updateTask(projectId, task.id, (current) => {
      if (JSON.stringify(current.reviewTarget) !== JSON.stringify(task.reviewTarget)) {
        throw new Error("Review target changed while rebinding; retry the rebind");
      }
      return { ...current, reviewTarget: target };
    });
  }

  async maybeAutoReview(projectId: string, parentTaskId: string, signal?: AbortSignal): Promise<TaskRecord | undefined> {
    const project = await this.store.readProject(projectId);
    if (!project || project.autoReview === false) return undefined;
    return serialized(projectId, async () => {
      const parent = await this.store.readTask(projectId, parentTaskId);
      if (!parent || parent.role !== "implementation" || !parent.pullRequest?.url || !parent.baseSha) return undefined;
      if (parent.status !== "pr-ready-ci-pending" && parent.status !== "completed") return undefined;
      if (parent.review?.verdict === "approved") return undefined;
      const siblings = await this.store.listTasks(projectId);
      const active = siblings.some((candidate) =>
        candidate.role === "review" && candidate.parentTaskId === parent.id && !isTerminalTaskStatus(candidate.status));
      if (active) return undefined;
      if (!project.cmux?.workspaceId || !project.cmux.callerSurfaceId) {
        return this.store.updateTask(projectId, parent.id, (current) => ({
          ...current,
          autoReview: { attemptedAt: timestamp(), error: "Auto-review requires a persisted cmux workspace and caller surface" },
        })).then(() => undefined);
      }
      const attemptedAt = timestamp();
      try {
        const gitProject = await this.git.inspect(project.projectRoot, signal);
        const review = await this.delegateSerialized({
          title: `Review · ${parent.brief.title}`,
          task: [
            `Independently review the implementation "${parent.brief.title}" (task ${parent.id.slice(0, 8)}).`,
            "Verify the issue, every acceptance criterion, the exact current diff, and the validation evidence.",
            "Report a verdict with findings and an acceptance matrix covering every criterion.",
          ].join(" "),
          role: "review",
          parentTaskId: parent.id,
        }, {
          cwd: project.projectRoot,
          sessionFile: project.leadSessionFile,
          cmuxWorkspaceId: project.cmux.workspaceId,
          cmuxSurfaceId: project.cmux.callerSurfaceId,
          signal,
        }, gitProject, project);
        await this.store.updateTask(projectId, parent.id, (current) => ({
          ...current,
          autoReview: { spawnedTaskId: review.id, attemptedAt },
        }));
        return review;
      } catch (error) {
        await this.store.updateTask(projectId, parent.id, (current) => ({
          ...current,
          autoReview: {
            attemptedAt,
            error: `Auto-review spawn failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        })).catch(() => undefined);
        return undefined;
      }
    });
  }

  async report(projectId: string, taskId: string, input: WorkerReportInput, signal?: AbortSignal): Promise<TaskRecord> {
    const status = input.status;
    if (status === "starting") throw new Error("starting is coordinator-owned and cannot be worker-reported");
    if (status === "pr-ready-ci-green" || status === "merged") {
      throw new Error(`${status} state must come from authoritative GitHub observation`);
    }
    if (status === "blocked" && !input.blockedReason?.trim()) throw new Error("blocked status requires blockedReason");
    const reportingTask = await this.store.requireTask(projectId, taskId);
    if (input.rebindReviewTarget) {
      if (input.reviewVerdict || input.status || input.checks) {
        throw new Error("Rebind the review target first, then report status or the verdict in a separate call");
      }
      return this.rebindReviewTarget(projectId, reportingTask.id, signal);
    }
    let review: ReviewEvidence | undefined;
    let reviewedParentEvidenceHash: string | undefined;
    if (input.reviewVerdict) {
      if (reportingTask.role !== "review" || !reportingTask.parentTaskId || !reportingTask.reviewTarget) {
        throw new Error("Only a bound review worker can report a review verdict");
      }
      const parent = await this.store.requireTask(projectId, reportingTask.parentTaskId);
      reviewedParentEvidenceHash = readinessEvidenceHash(parent);
      const currentDiff = await this.git.reviewPacket(parent.worktreePath, parent.baseSha, signal);
      if (currentDiff.diffHash !== reportingTask.reviewTarget.diffHash || currentDiff.headSha !== reportingTask.reviewTarget.headSha) {
        throw new Error(`Implementation diff or HEAD changed after this review started; ${REBIND_GUIDANCE}`);
      }
      if (validationEvidenceHash(parent.checks) !== reportingTask.reviewTarget.checksHash) {
        throw new Error(`Implementation validation evidence changed after this review started; ${REBIND_GUIDANCE}`);
      }
      const acceptance = input.acceptance ?? [];
      if (acceptance.some((entry) => !entry.criterion.trim() || !entry.evidence.trim())) {
        throw new Error("Every review acceptance row requires a criterion and concrete evidence");
      }
      if (input.reviewVerdict === "approved" && parent.brief.acceptanceCriteria.length === 0) {
        throw new Error("An implementation cannot be approved without acceptance criteria");
      }
      const missing = parent.brief.acceptanceCriteria.filter((criterion) =>
        !acceptance.some((entry) => normalizedCriterion(entry.criterion) === normalizedCriterion(criterion)));
      if (missing.length > 0) throw new Error(`Review acceptance matrix is missing: ${missing.join("; ")}`);
      if (input.reviewVerdict === "approved" && acceptance.some((entry) => entry.status !== "met")) {
        throw new Error("An approved review cannot contain not-met or unclear acceptance criteria");
      }
      if (input.reviewVerdict === "approved" && !validationEvidenceIsComplete(parent.checks)) {
        throw new Error("An implementation cannot be approved without complete validation including at least one passing check");
      }
      review = {
        verdict: input.reviewVerdict,
        reviewedAt: timestamp(),
        diffBaseSha: parent.baseSha,
        diffHash: currentDiff.diffHash,
        headSha: currentDiff.headSha,
        checksHash: validationEvidenceHash(parent.checks),
        acceptance,
        findings: input.findings ?? [],
      };
    }

    let retainedReview = reportingTask.review;
    if (reportingTask.role === "implementation" && retainedReview) {
      const currentDiff = await this.git.reviewPacket(reportingTask.worktreePath, reportingTask.baseSha, signal);
      if (currentDiff.diffHash !== retainedReview.diffHash || currentDiff.headSha !== retainedReview.headSha) retainedReview = undefined;
    }

    const task = await this.store.updateTask(projectId, reportingTask.id, (current) => {
      if (review && JSON.stringify(current.reviewTarget) !== JSON.stringify(reportingTask.reviewTarget)) {
        throw new Error(`Review target changed while the verdict was being recorded; ${REBIND_GUIDANCE}`);
      }
      let nextStatus = taskStatusAfterReport(current, input);
      let blockedReason = nextStatus === "blocked" ? input.blockedReason?.trim() : undefined;
      // Worker check re-reports replace prior worker evidence. Greptile entries
      // merged from the GitHub rollup persist for display until the next rollup
      // observation and never join the review fingerprint.
      const nextChecks = input.checks
        ? [...current.checks.filter(isGreptileEvidence), ...input.checks.filter((check) => !isGreptileEvidence(check))]
        : current.checks;
      let effectiveReview = review ?? retainedReview;
      if (current.role === "implementation" && effectiveReview?.checksHash !== validationEvidenceHash(nextChecks)) {
        effectiveReview = undefined;
      }
      if (current.role === "implementation" && (nextStatus === "pr-ready-ci-green" || nextStatus === "merged")) {
        if (input.prUrl || current.pullRequest?.url) {
          nextStatus = "pr-ready-ci-pending";
          blockedReason = undefined;
        } else {
          nextStatus = "blocked";
          blockedReason = "A PR URL is required before GitHub state can be verified";
        }
      }
      return {
        ...current,
        status: nextStatus,
        blockedReason,
        summary: input.summary?.trim() || current.summary,
        handoff: input.handoff?.trim() || current.handoff,
        checks: nextChecks,
        review: effectiveReview,
        pullRequest: input.prUrl
          ? {
              ...(current.pullRequest ?? { checks: [] }),
              url: input.prUrl.trim(),
              headSha: input.commitSha?.trim() || current.pullRequest?.headSha,
            }
          : current.pullRequest,
        failure: nextStatus === "failed" ? input.blockedReason?.trim() || current.failure : undefined,
      };
    });

    const reportedAt = timestamp();
    await this.store.updateRuntime(projectId, reportingTask.id, (runtime) => ({
      ...runtime,
      lastReportAt: reportedAt,
      reportNudgeState: undefined,
      reportNudgeAt: undefined,
      reportBaselineAt: reportedAt,
      terminalAt: isTerminalTaskStatus(task.status) ? runtime.terminalAt ?? reportedAt : runtime.terminalAt,
      shutdownRequestedAt: isTerminalTaskStatus(task.status) ? runtime.shutdownRequestedAt ?? reportedAt : runtime.shutdownRequestedAt,
      shutdownReason: isTerminalTaskStatus(task.status) ? `Terminal ${task.status} report persisted` : runtime.shutdownReason,
    }));

    if (review && task.parentTaskId) {
      const parent = await this.store.updateTask(projectId, task.parentTaskId, (current) => {
        if (!reviewedParentEvidenceHash || readinessEvidenceHash(current) !== reviewedParentEvidenceHash) {
          throw new Error(`Implementation evidence changed while review approval was being recorded; ${REBIND_GUIDANCE}`);
        }
        const reviewWasOnlyBlock = current.blockedReason?.startsWith("Review requested changes") || current.blockedReason?.includes("independent review");
        return {
          ...current,
          review,
          status: review.verdict === "changes-requested"
            ? "blocked"
            : reviewWasOnlyBlock && current.pullRequest?.url
              ? "pr-ready-ci-pending"
              : current.status,
          blockedReason: review.verdict === "changes-requested"
            ? `Review requested changes${review.findings.length ? `: ${review.findings.join("; ")}` : ""}`
            : reviewWasOnlyBlock
              ? undefined
              : current.blockedReason,
        };
      });
      if (parent.surface) {
        const parentCmux = new CmuxWorkers(this.execute, parent.worktreePath, parent.surface.workspaceId);
        await parentCmux.setTaskStatus(parent.id, parent.status, signal);
        await parentCmux.flash(parent.surface.surfaceId, signal);
      }
    }
    if (task.surface) {
      const cmux = new CmuxWorkers(this.execute, task.worktreePath, task.surface.workspaceId);
      await cmux.setTaskStatus(task.id, task.status, signal);
      if (["blocked", "failed", "completed", "pr-ready-ci-green", "merged"].includes(task.status)) {
        await cmux.flash(task.surface.surfaceId, signal);
      }
    }
    if (reportingTask.role === "implementation") {
      const chained = await this.maybeAutoReview(projectId, task.id, signal);
      if (chained) return this.store.requireTask(projectId, task.id);
    }
    return task;
  }

  async refreshPullRequest(projectId: string, taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    const task = await this.store.requireTask(projectId, taskId);
    const expectedEvidenceHash = readinessEvidenceHash(task);
    if (!task.pullRequest?.url) throw new Error(`Worker ${task.id.slice(0, 8)} has not reported a pull request`);
    const observation = await observePullRequest(this.execute, task.worktreePath, task.pullRequest.url, signal);
    // Greptile results in the GitHub check rollup become first-class validation
    // evidence on the task. Only terminal outcomes are merged so a still-running
    // Greptile never gates approval; failed Greptile checks stay visible on the
    // pull request checks where the green path already blocks.
    const greptile = observation.checks.filter((check) =>
      isGreptileEvidence(check) && (check.status === "passed" || check.status === "skipped"));
    const effectiveChecks = greptile.length > 0
      ? [...task.checks.filter((check) => !isGreptileEvidence(check)), ...greptile]
      : task.checks;
    let status: TaskStatus = observation.status === "green"
      ? "pr-ready-ci-green"
      : observation.status === "pending"
        ? "pr-ready-ci-pending"
        : observation.status === "merged"
          ? "merged"
          : "blocked";
    let blockedReason = observation.status === "failed" ? observation.reason : undefined;

    if (observation.status === "green" || observation.status === "merged") {
      const currentDiff = await this.git.reviewPacket(task.worktreePath, task.baseSha, signal);
      const evidenceLabel = observation.status === "merged" ? "The merged PR" : "CI";
      if (observation.checks.some((check) => check.status === "failed" || check.status === "pending")) {
        status = "blocked";
        blockedReason = `${evidenceLabel} has non-green GitHub checks`;
      } else if (currentDiff.status) {
        status = "blocked";
        blockedReason = `${evidenceLabel} does not match a clean published worker worktree`;
      } else if (task.review?.verdict !== "approved") {
        status = "blocked";
        blockedReason = `${evidenceLabel} still requires independent review of this task`;
      } else if (task.review.diffHash !== currentDiff.diffHash || task.review.headSha !== currentDiff.headSha) {
        status = "blocked";
        blockedReason = "The implementation revision changed after independent review";
      } else if (task.review.checksHash !== validationEvidenceHash(effectiveChecks)) {
        status = "blocked";
        blockedReason = "Validation evidence changed after independent review";
      } else if (!validationEvidenceIsComplete(effectiveChecks)) {
        status = "blocked";
        blockedReason = "Independent review lacks at least one passing check and complete non-failing validation evidence";
      } else if (currentDiff.headSha !== observation.headSha) {
        status = "blocked";
        blockedReason = "The pull request head does not match the reviewed worker HEAD";
      }
    }

    const updated = await this.store.updateTask(projectId, task.id, (current) => {
      if (readinessEvidenceHash(current) !== expectedEvidenceHash) {
        throw new Error("Task evidence changed during pull request observation; refresh again");
      }
      return {
        ...current,
        status,
        blockedReason,
        checks: effectiveChecks,
        pullRequest: {
          url: observation.url,
          headSha: observation.headSha,
          mergeState: observation.mergeState,
          checks: observation.checks,
          observedAt: timestamp(),
        },
      };
    });
    if (updated.surface) {
      const cmux = new CmuxWorkers(this.execute, updated.worktreePath, updated.surface.workspaceId);
      await cmux.setTaskStatus(updated.id, updated.status, signal);
      if (observation.status !== "pending") await cmux.flash(updated.surface.surfaceId, signal);
    }
    return updated;
  }
}

const REBIND_GUIDANCE = "call lead_worker_report with rebindReviewTarget: true to re-capture the review target at the parent's current HEAD, review the refreshed packet delta, then report the verdict again";

export function workerLabel(task: TaskRecord): string {
  return `${task.id.slice(0, 8)} ${task.role} · ${task.brief.title}`;
}

export function summarizeTasks(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return "No delegated workers yet.";
  return tasks.map((task) => {
    const detail = task.blockedReason || task.failure || task.pullRequest?.url || task.summary;
    const linear = task.linear ? `\n  Linear ${task.linear.issueIdentifier}: ${task.linear.status}${task.linear.stateName ? ` (${task.linear.stateName})` : ""}${task.linear.lastError ? ` — ${task.linear.lastError}` : ""}` : "";
    const greptile = [...task.checks, ...(task.pullRequest?.checks ?? [])].find(isGreptileEvidence);
    const greptileLine = greptile ? `\n  Greptile: ${greptile.status}${greptile.details ? ` — ${greptile.details}` : ""}` : "";
    const autoReview = task.role === "implementation" && task.autoReview
      ? `\n  Auto-review: ${task.autoReview.error ?? `spawned ${task.autoReview.spawnedTaskId?.slice(0, 8) ?? "unknown"}`}`
      : "";
    const runtime = task.runtime ? `\n  Runtime: ${task.runtime.state}${task.runtime.attentionReason ? ` — ${task.runtime.attentionReason}` : ""}${task.runtime.contextPercent !== undefined ? ` · ctx ${task.runtime.contextPercent}%` : ""}` : "";
    const selection = task.resolvedWorker?.model || task.resolvedWorker?.thinking
      ? `\n  Worker: ${task.resolvedWorker.model ?? "inherited model"}${task.resolvedWorker.thinking ? ` · thinking ${task.resolvedWorker.thinking}` : ""}`
      : "";
    const launch = task.launchState === "queued" ? "\n  Surface: queued (capacity opens automatically)" : "";
    return `${task.id.slice(0, 8)}  ${task.status.padEnd(19)}  ${task.role.padEnd(14)}  ${task.brief.title}${detail ? `\n  ${detail}` : ""}${runtime}${selection}${launch}${greptileLine}${autoReview}${linear}`;
  }).join("\n");
}
