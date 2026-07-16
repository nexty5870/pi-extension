import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PiInvocation } from "./launcher.ts";
import { currentPiInvocation, renderLaunchScript, writeLaunchScript } from "./launcher.ts";
import { CmuxWorkers } from "./cmux.ts";
import type { CommandExecutor, GitProject } from "./git.ts";
import { GitWorktrees } from "./git.ts";
import { observePullRequest } from "./github.ts";
import { reviewPacket, workerPrompt } from "./prompt.ts";
import { createTaskId, LeadStore } from "./store.ts";
import type {
  AcceptanceEvidence,
  CheckEvidence,
  ProjectRecord,
  ReviewEvidence,
  TaskRecord,
  TaskStatus,
  WorkerMessage,
  WorkerRole,
} from "./types.ts";

export interface DelegateInput {
  title: string;
  task: string;
  role?: WorkerRole;
  issue?: string;
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
      current = await this.store.updateTask(task.projectId, id, (value) => ({ ...value, status: "running", failure: undefined }));
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

  async report(projectId: string, taskId: string, input: WorkerReportInput, signal?: AbortSignal): Promise<TaskRecord> {
    const status = input.status;
    if (status === "blocked" && !input.blockedReason?.trim()) throw new Error("blocked status requires blockedReason");
    const reportingTask = await this.store.requireTask(projectId, taskId);
    let review: ReviewEvidence | undefined;
    if (input.reviewVerdict) {
      if (reportingTask.role !== "review" || !reportingTask.parentTaskId || !reportingTask.reviewTarget) {
        throw new Error("Only a bound review worker can report a review verdict");
      }
      const parent = await this.store.requireTask(projectId, reportingTask.parentTaskId);
      const currentDiff = await this.git.reviewPacket(parent.worktreePath, parent.baseSha, signal);
      if (currentDiff.diffHash !== reportingTask.reviewTarget.diffHash) {
        throw new Error("Implementation diff changed after this review started; create a fresh review worker for the current diff");
      }
      const acceptance = input.acceptance ?? [];
      const missing = parent.brief.acceptanceCriteria.filter((criterion) =>
        !acceptance.some((entry) => normalizedCriterion(entry.criterion) === normalizedCriterion(criterion)));
      if (missing.length > 0) throw new Error(`Review acceptance matrix is missing: ${missing.join("; ")}`);
      if (input.reviewVerdict === "approved" && acceptance.some((entry) => entry.status !== "met")) {
        throw new Error("An approved review cannot contain not-met or unclear acceptance criteria");
      }
      review = {
        verdict: input.reviewVerdict,
        reviewedAt: timestamp(),
        diffBaseSha: parent.baseSha,
        diffHash: currentDiff.diffHash,
        headSha: currentDiff.headSha,
        acceptance,
        findings: input.findings ?? [],
      };
    }

    let retainedReview = reportingTask.review;
    if (reportingTask.role === "implementation" && retainedReview) {
      const currentDiff = await this.git.reviewPacket(reportingTask.worktreePath, reportingTask.baseSha, signal);
      if (currentDiff.diffHash !== retainedReview.diffHash) retainedReview = undefined;
    }

    const task = await this.store.updateTask(projectId, reportingTask.id, (current) => {
      let nextStatus = taskStatusAfterReport(current, input);
      let blockedReason = nextStatus === "blocked" ? input.blockedReason?.trim() : undefined;
      const effectiveReview = review ?? retainedReview;
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
        checks: input.checks ?? current.checks,
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
    return task;
  }

  async refreshPullRequest(projectId: string, taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    const task = await this.store.requireTask(projectId, taskId);
    if (!task.pullRequest?.url) throw new Error(`Worker ${task.id.slice(0, 8)} has not reported a pull request`);
    const observation = await observePullRequest(this.execute, task.worktreePath, task.pullRequest.url, signal);
    let status: TaskStatus = observation.status === "green"
      ? "pr-ready-ci-green"
      : observation.status === "pending"
        ? "pr-ready-ci-pending"
        : observation.status === "merged"
          ? "merged"
          : "blocked";
    let blockedReason = observation.status === "failed" ? observation.reason : undefined;

    if (observation.status === "green") {
      const currentDiff = await this.git.reviewPacket(task.worktreePath, task.baseSha, signal);
      if (currentDiff.status) {
        status = "blocked";
        blockedReason = "CI is green, but the worker worktree has unpublished changes";
      } else if (task.review?.verdict !== "approved") {
        status = "blocked";
        blockedReason = "CI is green, but the current diff still requires independent review";
      } else if (task.review.diffHash !== currentDiff.diffHash) {
        status = "blocked";
        blockedReason = "The implementation changed after independent review";
      } else if (observation.headSha && currentDiff.headSha !== observation.headSha) {
        status = "blocked";
        blockedReason = "The pull request head does not match the reviewed worker HEAD";
      }
    }

    const updated = await this.store.updateTask(projectId, task.id, (current) => ({
      ...current,
      status,
      blockedReason,
      pullRequest: {
        url: observation.url,
        headSha: observation.headSha,
        mergeState: observation.mergeState,
        checks: observation.checks,
        observedAt: timestamp(),
      },
    }));
    if (updated.surface) {
      const cmux = new CmuxWorkers(this.execute, updated.worktreePath, updated.surface.workspaceId);
      await cmux.setTaskStatus(updated.id, updated.status, signal);
      if (observation.status !== "pending") await cmux.flash(updated.surface.surfaceId, signal);
    }
    return updated;
  }
}

export function workerLabel(task: TaskRecord): string {
  return `${task.id.slice(0, 8)} ${task.role} · ${task.brief.title}`;
}

export function summarizeTasks(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return "No delegated workers yet.";
  return tasks.map((task) => {
    const detail = task.blockedReason || task.failure || task.pullRequest?.url || task.summary;
    return `${task.id.slice(0, 8)}  ${task.status.padEnd(19)}  ${task.role.padEnd(14)}  ${task.brief.title}${detail ? `\n  ${detail}` : ""}`;
  }).join("\n");
}

