import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
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
      state.failure = undefined;
      state.actions = [];
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
    await this.ensureDependencies(state, signal);

    const resumedDiff = await this.deps.git.diff(state.worktreePath, state.baseSha!);
    if (state.baselineChecks === undefined) {
      if (resumedDiff.text) {
        state.baselineChecks = [];
        state.baselineUnavailable = true;
        await this.save(state);
      } else {
        await this.captureBaseline(state, signal);
      }
    }
    let approved = Boolean(resumedDiff.text && state.reviewedDiffHash === resumedDiff.hash);
    if (!approved) {
      if (state.reviewPass >= 3) state.reviewPass = 0;
      await this.runWorker(state, "implementer", `Implement this approved contract exactly.\n\n${renderContract(contract)}`, signal);
    }
    while (!approved && state.reviewPass < 3) {
      const current = await this.deps.git.diff(state.worktreePath, state.baseSha!); if (!current.text) throw new Error("Implementer produced no diff");
      state.reviewPass++; const result = await this.runWorker(state, "reviewer", `Review this diff with hash ${current.hash}. Return strict JSON only.\n\n${current.text}`, signal);
      const review = parseReviewerResult(result.text, current.hash);
      await this.deps.store.writeLog(state.runId, `review-${state.reviewPass}`, result.text);
      if (review.verdict === "approved") { state.reviewedDiffHash = current.hash; approved = true; break; }
      if (state.reviewPass >= 3) break;
      await this.runWorker(state, "implementer", `Address only these reviewer findings, then stop:\n${review.findings.map((item) => `- ${item}`).join("\n")}`, signal);
    }
    if (!approved) throw new Error("Reviewer pass limit exhausted with unresolved findings");

    let repair: { argv: string[]; output: string } | undefined;
    do {
      repair = undefined;
      await this.save(state, "checking");
      for (const argv of [...state.metadata.checks, ["git", "diff", "--check"]]) {
        const before = await this.deps.git.diff(state.worktreePath, state.baseSha!); const startedAt = this.now();
        const result = await this.deps.runner.run(argv[0], argv.slice(1), { cwd: state.worktreePath, timeoutMs: 10 * 60_000, signal });
        const output = `${result.stdout}\n${result.stderr}`;
        const outputPath = await this.deps.store.writeLog(state.runId, `check-${state.checks.length + 1}`, output);
        const after = await this.deps.git.diff(state.worktreePath, state.baseSha!);
        const baseline = argv[0] === "git" ? { exitCode: 0 } : state.baselineChecks?.find((item) => JSON.stringify(item.argv) === JSON.stringify(argv));
        const reason = result.exitCode === 0
          ? undefined
          : baseline?.exitCode !== 0
            ? "check already failed on the untouched base"
            : state.baselineUnavailable
              ? "legacy run has no base-check evidence; failure retained for PR review"
              : undefined;
        const disposition = result.exitCode === 0 ? "passed" : reason ? "blocked" : "failed";
        state.checks.push({ argv, startedAt, finishedAt: this.now(), exitCode: result.exitCode, outputPath, diffHashBefore: before.hash, diffHashAfter: after.hash, disposition, reason });
        if (reason) this.action(state, `Validation blocked (${argv.join(" ")}): ${reason}`, "warning");
        await this.save(state);
        if (result.exitCode !== 0 && !reason) { repair = { argv, output }; break; }
        if (before.hash !== after.hash) {
          state.reviewPass++;
          const reviewed = await this.runWorker(state, "reviewer", `Checks changed the diff. Review hash ${after.hash} and return strict JSON.\n\n${after.text}`, signal);
          const parsed = parseReviewerResult(reviewed.text, after.hash);
          if (parsed.verdict !== "approved") throw new Error("Check-mutated diff was not approved");
          state.reviewedDiffHash = after.hash;
        }
      }
      if (repair) await this.repairFailedCheck(state, repair.argv, repair.output, signal);
    } while (repair);
    const final = await this.deps.git.diff(state.worktreePath, state.baseSha!);
    if (final.hash !== state.reviewedDiffHash) throw new Error("Final diff was not covered by reviewer approval");
    const findings = await scanPublicFiles(state.worktreePath, final.paths); if (findings.length) throw new Error(`Publication safety scan failed: ${findings.map((item) => `${item.path}: ${item.reason}`).join(", ")}`);

    await this.save(state, "committing"); state.commitSha = await this.deps.git.commit(state.worktreePath, state.metadata.commitMessage);
    await this.publish(state);
  }

  private async captureBaseline(state: DeliveryState, signal?: AbortSignal): Promise<void> {
    state.baselineChecks = [];
    for (const argv of state.metadata.checks) {
      const result = await this.deps.runner.run(argv[0], argv.slice(1), { cwd: state.worktreePath!, timeoutMs: 10 * 60_000, signal });
      const outputPath = await this.deps.store.writeLog(state.runId, `baseline-${state.baselineChecks.length + 1}`, `${result.stdout}\n${result.stderr}`);
      state.baselineChecks.push({ argv, exitCode: result.exitCode, outputPath });
      await this.save(state);
    }
  }

  private async repairFailedCheck(state: DeliveryState, argv: string[], output: string, signal?: AbortSignal): Promise<void> {
    state.repairPass = (state.repairPass ?? 0) + 1;
    if (state.repairPass > 2) throw new Error(`Check repair limit exhausted: ${argv.join(" ")}`);
    await this.runWorker(state, "implementer", `Repair the regression from this failed check. Change only files needed for the approved work.\n\nCommand: ${argv.join(" ")}\n\nOutput:\n${output.slice(-20_000)}`, signal);
    for (let review = 0; review < 2; review++) {
      const current = await this.deps.git.diff(state.worktreePath!, state.baseSha!);
      if (!current.text) throw new Error("Check repair removed the entire implementation diff");
      const result = await this.runWorker(state, "reviewer", `Review repaired diff hash ${current.hash}. Return strict JSON only.\n\n${current.text}`, signal);
      const parsed = parseReviewerResult(result.text, current.hash);
      if (parsed.verdict === "approved") { state.reviewedDiffHash = current.hash; await this.save(state); return; }
      if (review === 1) break;
      await this.runWorker(state, "implementer", `Address only these repair-review findings:\n${parsed.findings.map((item) => `- ${item}`).join("\n")}`, signal);
    }
    throw new Error(`Check repair was not reviewer-approved: ${argv.join(" ")}`);
  }

  private async ensureDependencies(state: DeliveryState, signal?: AbortSignal): Promise<void> {
    if (state.dependencySetupComplete || !state.metadata.checks.some((argv) => argv[0] === "pnpm")) return;
    const lockPath = join(state.worktreePath!, "pnpm-lock.yaml");
    try { await access(lockPath); } catch { return; }
    const packageJson = await readFile(join(state.worktreePath!, "package.json"), "utf8").then((text) => JSON.parse(text) as { packageManager?: string }).catch(() => undefined);
    const configured = packageJson?.packageManager?.match(/^pnpm@([^+\s]+)/)?.[1];
    const lockfile = await readFile(lockPath, "utf8");
    const lockVersion = lockfile.match(/^lockfileVersion:\s*['"]?([^'"\s]+)['"]?/m)?.[1];
    const pnpmVersion = configured ?? (lockVersion?.startsWith("9") ? "9.15.9" : lockVersion?.startsWith("6") ? "8.15.9" : undefined);
    if (!pnpmVersion) throw new Error(`Dependency setup cannot select a compatible pnpm version for lockfile ${lockVersion ?? "unknown"}`);
    const modules = await readFile(join(state.worktreePath!, "node_modules", ".modules.yaml"), "utf8").catch(() => "");
    const installedPnpm = modules.match(/^packageManager:\s*pnpm@([^\s]+)$/m)?.[1];
    const args = [`pnpm@${pnpmVersion}`, "install", "--frozen-lockfile", ...(installedPnpm && installedPnpm !== pnpmVersion ? ["--force"] : [])];
    const result = await this.deps.runner.run("corepack", args, { cwd: state.worktreePath!, timeoutMs: 10 * 60_000, signal });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    await this.deps.store.writeLog(state.runId, "dependency-setup", output);
    if (result.exitCode !== 0) {
      const tail = output.split("\n").slice(-8).join(" ").slice(-800);
      throw new Error(`Dependency setup failed: corepack ${args.join(" ")}${tail ? ` — ${tail}` : ""}`);
    }
    state.dependencySetupComplete = true;
    await this.save(state);
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
    const ordinal = state.reviewPass + (state.repairPass ?? 0) + 1;
    await this.deps.store.writeLog(state.runId, `${role}-prompt-${ordinal}`, prompt);
    state.workers[role] = { role, phase: "running", task: prompt.split("\n")[0], startedAt }; await this.save(state, role === "implementer" ? "implementing" : "reviewing");
    try { const result = await this.deps.worker(role, state.worktreePath!, prompt, { signal }); state.workers[role] = { ...state.workers[role]!, phase: "passed", finishedAt: this.now(), usage: { input: result.usage.input, output: result.usage.output, cost: result.usage.cost } }; await this.deps.store.writeLog(state.runId, `${role}-${ordinal}`, result.text); await this.deps.store.writeLog(state.runId, `${role}-live`, result.text); await this.save(state); return result; }
    catch (error) { state.workers[role] = { ...state.workers[role]!, phase: "failed", finishedAt: this.now(), failure: (error as Error).message }; await this.save(state); throw error; }
  }

  async abort(state: DeliveryState): Promise<void> { if (["completed", "aborted"].includes(state.phase)) return; this.action(state, "Delivery aborted by operator", "warning"); await this.save(state, "aborted"); }
}
