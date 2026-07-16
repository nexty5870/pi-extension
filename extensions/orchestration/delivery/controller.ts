import { randomUUID } from "node:crypto";
import type { FeatureOrBugContract, InitiativeState, ProjectContext } from "../types.ts";
import { contractHash, renderContract } from "../contracts.ts";
import type { CommandRunner } from "./command.ts";
import { GitAdapter } from "./git.ts";
import { GitHubAdapter } from "./github.ts";
import { CmuxAdapter } from "./cmux.ts";
import { DeliveryStore } from "./store.ts";
import { parseReviewerResult } from "./reviewer.ts";
import { scanPublicFiles } from "./safety.ts";
import type { DeliveryState, WorkerResult, WorkerRole } from "./types.ts";

export interface DeliveryDependencies {
  runner: CommandRunner;
  git: GitAdapter;
  github: GitHubAdapter;
  cmux: CmuxAdapter;
  store: DeliveryStore;
  worker: (role: WorkerRole, cwd: string, prompt: string, options?: { signal?: AbortSignal }) => Promise<WorkerResult>;
  now?: () => string;
  onUpdate?: (state: DeliveryState) => Promise<void> | void;
}

export class DeliveryController {
  private readonly now: () => string;
  constructor(private readonly deps: DeliveryDependencies) { this.now = deps.now ?? (() => new Date().toISOString()); }
  private async save(state: DeliveryState, phase?: DeliveryState["phase"]): Promise<void> { if (phase) state.phase = phase; await this.deps.store.write(state); await this.deps.onUpdate?.(state); await this.deps.cmux.update(state).catch(() => undefined); }
  private action(state: DeliveryState, message: string, severity: "warning" | "critical" = "critical") { const id = `${severity}:${message}`; if (!state.actions.some((item) => item.id === id)) state.actions.push({ id, severity, message, createdAt: this.now() }); }

  create(initiative: InitiativeState): DeliveryState {
    if (initiative.status !== "approved" || !initiative.contract || !initiative.approved) throw new Error("A locally approved contract is required");
    if (initiative.approved.contentHash !== contractHash(initiative.contract)) throw new Error("Approved contract hash does not match current contract");
    if (!initiative.contract.delivery) throw new Error("Approved contract has no delivery metadata");
    if ((initiative.contract.linear.team || initiative.contract.linear.issueId || initiative.contract.linear.issueIdentifier) && initiative.approved.linearPersistence !== "persisted") throw new Error("Linear-bound contract persistence is incomplete");
    const now = this.now();
    return { schemaVersion: 1, runId: randomUUID(), projectId: initiative.projectId, initiativeId: initiative.initiativeId, projectRoot: initiative.projectRoot, contractHash: initiative.approved.contentHash, metadata: initiative.contract.delivery, phase: "preflight", branchName: initiative.contract.delivery.branchName, reviewPass: 0, workers: {}, checks: [], actions: [], startedAt: now, updatedAt: now };
  }

  async run(initiative: InitiativeState, project: ProjectContext, existing?: DeliveryState, signal?: AbortSignal): Promise<DeliveryState> {
    const state = existing ?? this.create(initiative); const release = await this.deps.store.acquire(state.runId);
    try {
      await this.execute(state, initiative.contract!, project, signal);
    } catch (error) {
      state.failure = (error as Error).message;
      if (state.phase !== "aborted") { this.action(state, state.failure); await this.save(state, "failed"); await this.deps.cmux.flash("reviewer").catch(() => undefined); }
      else await this.save(state, "aborted");
    } finally { await release(); }
    return state;
  }

  private async execute(state: DeliveryState, contract: FeatureOrBugContract, project: ProjectContext, signal?: AbortSignal): Promise<void> {
    if (contractHash(contract) !== state.contractHash) throw new Error("Contract drift detected before delivery");
    await this.deps.github.assertPublishable(state.projectRoot);
    const hadTopology = Boolean(state.cmux?.implementerSurfaceId && state.cmux?.reviewerSurfaceId);
    state.cmux = await this.deps.cmux.ensureTopology(state.cmux);
    await this.save(state, "preflight");
    if (!hadTopology) {
      const implementerLog = await this.deps.store.writeLog(state.runId, "implementer-live", "");
      const reviewerLog = await this.deps.store.writeLog(state.runId, "reviewer-live", "");
      await this.deps.cmux.attachLogs(state.cmux, implementerLog, reviewerLog);
    }
    if (!state.baseSha) { const preflight = await this.deps.git.preflight(state.projectRoot, state.metadata); state.baseSha = preflight.baseSha; await this.save(state, "worktree"); }
    if (!state.worktreePath) { state.worktreePath = await this.deps.git.createWorktree(state.projectRoot, this.deps.store.statePath(state.runId).replace(/\/state\.json$/, ""), state.branchName, state.baseSha!); await this.save(state); }
    if (state.commitSha) { await this.publish(state); return; }

    await this.runWorker(state, "implementer", `Implement this approved contract exactly.\n\n${renderContract(contract)}`, signal);
    let approved = false;
    while (state.reviewPass < 3) {
      const current = await this.deps.git.diff(state.worktreePath, state.baseSha!); if (!current.text) throw new Error("Implementer produced no diff");
      state.reviewPass++; const result = await this.runWorker(state, "reviewer", `Review this diff with hash ${current.hash}. Return strict JSON only.\n\n${current.text}`, signal);
      const review = parseReviewerResult(result.text, current.hash);
      await this.deps.store.writeLog(state.runId, `review-${state.reviewPass}`, result.text);
      if (review.verdict === "approved") { state.reviewedDiffHash = current.hash; approved = true; break; }
      if (state.reviewPass >= 3) break;
      await this.runWorker(state, "implementer", `Address only these reviewer findings, then stop:\n${review.findings.map((item) => `- ${item}`).join("\n")}`, signal);
    }
    if (!approved) throw new Error("Reviewer pass limit exhausted with unresolved findings");

    await this.save(state, "checking");
    for (const argv of [...state.metadata.checks, ["git", "diff", "--check"]]) {
      const before = await this.deps.git.diff(state.worktreePath, state.baseSha!); const startedAt = this.now();
      const result = await this.deps.runner.run(argv[0], argv.slice(1), { cwd: state.worktreePath, timeoutMs: 10 * 60_000, signal });
      const outputPath = await this.deps.store.writeLog(state.runId, `check-${state.checks.length + 1}`, `${result.stdout}\n${result.stderr}`);
      const after = await this.deps.git.diff(state.worktreePath, state.baseSha!);
      state.checks.push({ argv, startedAt, finishedAt: this.now(), exitCode: result.exitCode, outputPath, diffHashBefore: before.hash, diffHashAfter: after.hash }); await this.save(state);
      if (result.exitCode !== 0) throw new Error(`Approved check failed: ${argv.join(" ")}`);
      if (before.hash !== after.hash) {
        if (state.reviewPass >= 3) throw new Error("Checks mutated the diff after the final available review pass");
        state.reviewPass++; const reviewed = await this.runWorker(state, "reviewer", `Checks changed the diff. Review hash ${after.hash} and return strict JSON.\n\n${after.text}`, signal);
        const parsed = parseReviewerResult(reviewed.text, after.hash); if (parsed.verdict !== "approved") throw new Error("Check-mutated diff was not approved"); state.reviewedDiffHash = after.hash;
      }
    }
    const final = await this.deps.git.diff(state.worktreePath, state.baseSha!);
    if (final.hash !== state.reviewedDiffHash) throw new Error("Final diff was not covered by reviewer approval");
    const findings = await scanPublicFiles(state.worktreePath, final.paths); if (findings.length) throw new Error(`Publication safety scan failed: ${findings.map((item) => `${item.path}: ${item.reason}`).join(", ")}`);

    await this.save(state, "committing"); state.commitSha = await this.deps.git.commit(state.worktreePath, state.metadata.commitMessage);
    await this.publish(state);
  }

  private async publish(state: DeliveryState): Promise<void> {
    await this.save(state, "pushing");
    const remoteSha = await this.deps.git.pushedSha(state.worktreePath!, state.branchName);
    if (remoteSha && remoteSha !== state.commitSha) throw new Error("Remote branch exists at an unexpected commit");
    if (!remoteSha) await this.deps.git.push(state.worktreePath!, state.branchName); state.pushed = true;
    await this.save(state, "pull-request"); state.prUrl = state.prUrl ?? await this.deps.github.reconcilePr(state.worktreePath!, state.branchName, state.metadata.baseBranch, state.metadata.prTitle, state.metadata.prBody);
    await this.save(state, "ci"); state.ciState = await this.deps.github.observeCi(state.worktreePath!, state.prUrl);
    this.action(state, `Review PR ${state.prUrl}; merge and deployment remain operator-controlled.`, state.ciState === "failure" ? "critical" : "warning");
    await this.save(state, state.ciState === "failure" || state.ciState === "timed-out" ? "action-required" : "completed");
  }

  private async runWorker(state: DeliveryState, role: WorkerRole, prompt: string, signal?: AbortSignal): Promise<WorkerResult> {
    const startedAt = this.now();
    await this.deps.store.writeLog(state.runId, `${role}-prompt-${state.reviewPass + 1}`, prompt);
    state.workers[role] = { role, phase: "running", task: prompt.split("\n")[0], startedAt }; await this.save(state, role === "implementer" ? "implementing" : "reviewing");
    try { const result = await this.deps.worker(role, state.worktreePath!, prompt, { signal }); state.workers[role] = { ...state.workers[role]!, phase: "passed", finishedAt: this.now(), usage: { input: result.usage.input, output: result.usage.output, cost: result.usage.cost } }; await this.deps.store.writeLog(state.runId, `${role}-${state.reviewPass + 1}`, result.text); await this.deps.store.writeLog(state.runId, `${role}-live`, result.text); await this.save(state); return result; }
    catch (error) { state.workers[role] = { ...state.workers[role]!, phase: "failed", finishedAt: this.now(), failure: (error as Error).message }; await this.save(state); throw error; }
  }

  async abort(state: DeliveryState): Promise<void> { if (["completed", "aborted"].includes(state.phase)) return; this.action(state, "Delivery aborted by operator", "warning"); await this.save(state, "aborted"); }
}
