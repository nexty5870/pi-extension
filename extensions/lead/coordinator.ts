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

export class LeadCoordinator {
  private readonly git: GitWorktrees;

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
        model: input.model ?? runtime.model,
        thinking: runtime.thinking,
      }));

      runtime.onStage?.("opening visible Pi session in cmux");
      const cmux = new CmuxWorkers(this.execute, gitProject.root, project.cmux.workspaceId);
      const placement = await cmux.createSurface(
        project,
        `${role === "review" ? "Review" : role === "research" ? "Research" : "Worker"} · ${task.brief.title}`,
        current.worktreePath,
        runtime.signal,
      );
      await this.store.saveProject({
        ...project,
        cmux: { ...project.cmux, helperPaneId: placement.helperPaneId },
      });
      current = await this.store.updateTask(task.projectId, id, (value) => ({
        ...value,
        promptPath,
        launchScriptPath,
        surface: placement.surface,
      }));
      await cmux.launch(placement.surface.surfaceId, launchScriptPath, runtime.signal);
      current = await this.store.updateTask(task.projectId, id, (value) => ({
        ...value,
        status: "running",
        workerStartedAt: timestamp(),
        leadObservedStatus: "running",
        leadObservedAt: timestamp(),
        failure: undefined,
      }));
      await cmux.setTaskStatus(id, "running", runtime.signal);
      return current;
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await this.store.updateTask(task.projectId, id, (value) => ({ ...value, status: "failed", failure })).catch(() => undefined);
      throw error;
    }
  }

  async list(projectId: string): Promise<TaskRecord[]> {
    return this.store.listTasks(projectId);
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
    return `${task.id.slice(0, 8)}  ${task.status.padEnd(19)}  ${task.role.padEnd(14)}  ${task.brief.title}${detail ? `\n  ${detail}` : ""}${greptileLine}${autoReview}${linear}`;
  }).join("\n");
}
