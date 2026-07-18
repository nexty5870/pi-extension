import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LeadCoordinator, validationEvidenceHash, validationEvidenceIsComplete } from "../extensions/lead/coordinator.ts";
import type { CommandExecutor } from "../extensions/lead/git.ts";
import { LeadStore } from "../extensions/lead/store.ts";

const execFileAsync = promisify(execFile);

test("validation evidence requires at least one pass and no pending/failing checks", () => {
  assert.equal(validationEvidenceIsComplete([]), false);
  assert.equal(validationEvidenceIsComplete([{ name: "not applicable", status: "skipped" }]), false);
  assert.equal(validationEvidenceIsComplete([{ name: "test", status: "passed" }, { name: "optional", status: "skipped" }]), true);
  assert.equal(validationEvidenceIsComplete([{ name: "test", status: "passed" }, { name: "lint", status: "failed" }]), false);
});

class HarnessExecutor {
  calls: Array<{ command: string; args: string[] }> = [];
  helperPane = false;
  surface = 10;
  ci: "pending" | "green" = "pending";
  merged = false;
  headSha = "abc123";
  onGh?: () => Promise<void>;

  execute: CommandExecutor = async (command, args, options) => {
    this.calls.push({ command, args });
    if (command === "cmux") {
      if (args[0] === "list-panes") {
        return {
          stdout: JSON.stringify({ panes: this.helperPane ? [{ ref: "pane:workers", surface_refs: ["surface:10"] }] : [{ ref: "pane:caller" }] }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "new-pane") {
        this.helperPane = true;
        return { stdout: "pane:workers surface:10", stderr: "", code: 0 };
      }
      if (args[0] === "new-surface") {
        this.surface++;
        return { stdout: `surface:${this.surface}`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (command === "gh") {
      const onGh = this.onGh;
      this.onGh = undefined;
      await onGh?.();
      return {
        stdout: JSON.stringify({
          url: "https://github.com/example/repo/pull/7",
          state: this.merged ? "MERGED" : "OPEN",
          headRefOid: this.headSha,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{
            name: "test",
            status: this.ci === "pending" ? "IN_PROGRESS" : "COMPLETED",
            conclusion: this.ci === "pending" ? "" : "SUCCESS",
          }],
        }),
        stderr: "",
        code: 0,
      };
    }
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout,
        signal: options.signal,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1 };
    }
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

test("V2 delegates a visible implementation and gives review the issue, diff, criteria, and checks", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-lead-e2e-"));
  const repo = join(fixture, "repo");
  const remote = join(fixture, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "feature.ts"), "export const enabled = false;\n");
  await git(repo, "add", "feature.ts");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");

  const harness = new HarnessExecutor();
  const store = new LeadStore(join(fixture, "state"));
  const coordinator = new LeadCoordinator(store, harness.execute, { command: "pi", leadingArgs: [] }, "/opt/pi-extension/extensions/lead/index.ts");
  const runtime = {
    cwd: repo,
    sessionFile: join(fixture, "lead.jsonl"),
    cmuxWorkspaceId: "workspace:2",
    cmuxSurfaceId: "surface:caller",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "high",
  };
  const research = await Promise.all([
    coordinator.delegate({ title: "Inspect API", task: "Find the API entry points.", role: "research" }, runtime),
    coordinator.delegate({ title: "Inspect tests", task: "Find the relevant tests.", role: "research" }, runtime),
  ]);
  assert.notEqual(research[0].surface?.surfaceId, research[1].surface?.surfaceId);
  assert.equal(research[0].linear, undefined);
  assert.equal(research[1].linear, undefined);
  assert.equal(harness.calls.filter((call) => call.command === "cmux" && call.args[0] === "new-pane").length, 1);

  const implementation = await coordinator.delegate({
    title: "Preserve imported record ownership",
    task: "Implement the issue completely and prepare a green PR.",
    issue: "APP-41 — Preserve ownership across imported records.",
    linearIssue: "APP-41",
    acceptanceCriteria: ["Every imported record has an owner", "Parent records are synchronized", "Malformed input has regression coverage"],
  }, runtime);
  assert.equal(implementation.status, "running");
  assert.ok(implementation.workerStartedAt);
  assert.equal(implementation.leadObservedStatus, "running");
  assert.equal(implementation.linear?.issueIdentifier, "APP-41");
  assert.equal(implementation.linear?.status, "pending");
  const promptClaims = await Promise.all([
    coordinator.claimLinearLifecyclePrompt(implementation.projectId, implementation.id),
    coordinator.claimLinearLifecyclePrompt(implementation.projectId, implementation.id),
  ]);
  assert.equal(promptClaims.filter(Boolean).length, 1);
  assert.equal(await coordinator.claimLinearLifecyclePrompt(implementation.projectId, implementation.id), undefined);
  await coordinator.updateLinearLifecycle(implementation.projectId, implementation.id, (current) => ({
    ...current,
    promptClaimId: undefined,
    promptClaimedAt: undefined,
    promptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  assert.equal(await coordinator.claimLinearLifecyclePrompt(implementation.projectId, implementation.id), undefined);
  const evidenceTime = new Date().toISOString();
  await coordinator.updateLinearLifecycle(implementation.projectId, implementation.id, (current) => ({
    ...current,
    teamId: "team-app",
    issueObservedAt: evidenceTime,
    candidateStateId: "state-progress",
    candidateStateName: "In Progress",
    candidateTeamId: "team-app",
    candidateObservedAt: evidenceTime,
    updatedAt: evidenceTime,
  }));
  const writeClaims = await Promise.all([
    coordinator.claimLinearLifecycleWrite(implementation.projectId, implementation.id, { issue: "APP-41", stateId: "state-progress" }),
    coordinator.claimLinearLifecycleWrite(implementation.projectId, implementation.id, { issue: "APP-41", stateId: "state-progress" }),
  ]);
  assert.equal(writeClaims.filter(Boolean).length, 1);
  await coordinator.updateLinearLifecycle(implementation.projectId, implementation.id, (current) => ({
    ...current,
    writeClaimId: undefined,
    writeClaimedAt: undefined,
    updatedAt: new Date().toISOString(),
  }));
  assert.equal(implementation.surface?.workspaceId, "workspace:2");
  await assert.rejects(() => coordinator.report(implementation.projectId, implementation.id, { status: "starting" }), /coordinator-owned/);
  await assert.rejects(() => coordinator.report(implementation.projectId, implementation.id, { status: "merged" }), /authoritative GitHub/);
  assert.ok(implementation.worktreePath.startsWith(store.root));
  const launch = await readFile(implementation.launchScriptPath!, "utf8");
  assert.match(launch, /--session-id/);
  assert.match(launch, /--append-system-prompt/);
  assert.match(launch, /--extension.*extensions\/lead\/index\.ts/);
  assert.doesNotMatch(launch, /--no-skills|--no-extensions|--no-session/);
  assert.ok(harness.calls.some((call) => call.command === "cmux" && call.args[0] === "new-pane" && call.args.includes("false")));
  assert.ok(harness.calls.some((call) => call.command === "cmux" && call.args[0] === "send" && call.args.at(-1)?.startsWith("exec ")));

  await coordinator.message(implementation.projectId, implementation.id, "Check the edge case before finishing.");
  const inbox = await coordinator.claimMessages(implementation.projectId, implementation.id);
  assert.deepEqual(inbox.map((message) => message.text), ["Check the edge case before finishing."]);
  assert.deepEqual(await coordinator.claimMessages(implementation.projectId, implementation.id), []);
  await coordinator.acknowledgeMessage(implementation.projectId, implementation.id, inbox[0].id);
  assert.deepEqual((await store.requireTask(implementation.projectId, implementation.id)).messages, []);

  await writeFile(join(implementation.worktreePath, "feature.ts"), "export const enabled = true;\n");
  await git(implementation.worktreePath, "add", "feature.ts");
  await git(implementation.worktreePath, "commit", "-m", "enable feature");
  harness.headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: implementation.worktreePath, encoding: "utf8" })).stdout.trim();
  const reported = await coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    summary: "Implemented ownership",
    handoff: "Changed feature.ts and covered malformed ownership.",
    prUrl: "https://github.com/example/repo/pull/7",
    commitSha: harness.headSha,
    checks: [{ name: "npm test", status: "passed", details: "42 tests" }],
  });
  assert.equal(reported.pullRequest?.url, "https://github.com/example/repo/pull/7");
  assert.equal(reported.leadObservedStatus, "running");
  await assert.rejects(() => coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-green",
    prUrl: "https://github.com/example/repo/pull/7",
  }), /authoritative GitHub/);
  await coordinator.markLeadObserved(implementation.projectId, implementation.id, "running");
  assert.equal((await store.requireTask(implementation.projectId, implementation.id)).leadObservedStatus, "running");
  await coordinator.markLeadObserved(implementation.projectId, implementation.id, "pr-ready-ci-pending");
  const legacyMarked = await store.requireTask(implementation.projectId, implementation.id);
  assert.equal(legacyMarked.leadObservedStatus, "pr-ready-ci-pending");
  const pendingEvent = legacyMarked.leadEvents?.find((event) => event.status === "pr-ready-ci-pending" && !event.observedAt);
  assert.ok(pendingEvent);
  const deliveryClaims = await Promise.all([
    coordinator.claimLeadEvent(implementation.projectId, implementation.id, pendingEvent!),
    coordinator.claimLeadEvent(implementation.projectId, implementation.id, pendingEvent!),
  ]);
  assert.equal(deliveryClaims.filter(Boolean).length, 1);
  assert.equal(deliveryClaims.find(Boolean)?.observedAt, undefined);
  await coordinator.markLeadEventsObserved(implementation.projectId, implementation.id, [pendingEvent!.id]);
  assert.ok((await store.requireTask(implementation.projectId, implementation.id)).leadEvents?.find((event) => event.id === pendingEvent!.id)?.observedAt);
  harness.ci = "green";
  const unreviewedGreen = await coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(unreviewedGreen.status, "blocked");
  assert.match(unreviewedGreen.blockedReason ?? "", /independent review/);
  harness.ci = "pending";

  const review = await coordinator.delegate({
    title: "Review APP-41 implementation",
    task: "Independently verify the complete issue and request changes for any missing branch.",
    role: "review",
    parentTaskId: implementation.id.slice(0, 8),
  }, runtime);
  assert.equal(review.status, "running");
  assert.equal(review.linear, undefined);
  assert.equal(review.worktreePath, implementation.worktreePath);
  const packet = await readFile(join(store.taskArtifactDirectory(review.projectId, review.id), "review-packet.md"), "utf8");
  assert.match(packet, /APP-41/);
  assert.match(packet, /Every imported record has an owner/);
  assert.match(packet, /npm test: passed/);
  assert.match(packet, /-export const enabled = false/);
  assert.match(packet, /\+export const enabled = true/);
  const reviewLaunch = await readFile(review.launchScriptPath!, "utf8");
  assert.match(reviewLaunch, /read,bash,grep,find,ls,lead_worker_report/);

  const skippedChecks = [{ name: "not applicable", status: "skipped" as const }];
  await store.updateTask(implementation.projectId, implementation.id, (current) => ({ ...current, checks: skippedChecks }));
  await store.updateTask(review.projectId, review.id, (current) => ({
    ...current,
    reviewTarget: current.reviewTarget ? { ...current.reviewTarget, checksHash: validationEvidenceHash(skippedChecks) } : undefined,
  }));
  await assert.rejects(() => coordinator.report(review.projectId, review.id, {
    reviewVerdict: "approved",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "met" as const, evidence: "code inspection" })),
    findings: [],
  }), /complete validation/);
  const passingChecks = [{ name: "npm test", status: "passed" as const, details: "42 tests" }];
  await store.updateTask(implementation.projectId, implementation.id, (current) => ({ ...current, checks: passingChecks }));
  await store.updateTask(review.projectId, review.id, (current) => ({
    ...current,
    reviewTarget: current.reviewTarget ? { ...current.reviewTarget, checksHash: validationEvidenceHash(passingChecks) } : undefined,
  }));

  await writeFile(join(implementation.worktreePath, "feature.ts"), "export const enabled = false;\n");
  await assert.rejects(() => coordinator.report(review.projectId, review.id, {
    reviewVerdict: "changes-requested",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "not-met" as const, evidence: "diff moved" })),
    findings: ["Diff changed during review"],
  }), /diff or HEAD changed/);
  await writeFile(join(implementation.worktreePath, "feature.ts"), "export const enabled = true;\n");

  await assert.rejects(() => coordinator.report(review.projectId, review.id, {
    reviewVerdict: "approved",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion, index) => ({
      criterion,
      status: index === 0 ? "unclear" as const : "met" as const,
      evidence: "review evidence",
    })),
    findings: [],
  }), /approved review cannot/);
  await git(implementation.worktreePath, "commit", "--allow-empty", "-m", "metadata-only change");
  await assert.rejects(() => coordinator.report(review.projectId, review.id, {
    reviewVerdict: "changes-requested",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "not-met" as const, evidence: "HEAD moved" })),
    findings: ["HEAD changed"],
  }), /diff or HEAD changed/);
  await git(implementation.worktreePath, "reset", "--hard", "HEAD^");
  await assert.rejects(() => coordinator.report(review.projectId, review.id, {
    reviewVerdict: "approved",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "met" as const, evidence: "" })),
    findings: [],
  }), /concrete evidence/);
  await coordinator.report(review.projectId, review.id, {
    reviewVerdict: "approved",
    summary: "All criteria met",
    acceptance: implementation.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: "feature.ts diff and tests" })),
    findings: [],
  });
  const parentAfterReview = await store.requireTask(implementation.projectId, implementation.id);
  assert.equal(parentAfterReview.review?.verdict, "approved");
  assert.equal(parentAfterReview.review?.acceptance.length, 3);

  const pending = await coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(pending.status, "pr-ready-ci-pending");
  harness.ci = "green";
  const green = await coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(green.status, "pr-ready-ci-green");

  harness.merged = true;
  harness.headSha = "unrelated-merged-head";
  const unrelatedMerged = await coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(unrelatedMerged.status, "blocked");
  assert.match(unrelatedMerged.blockedReason ?? "", /revision|head/i);
  harness.merged = false;
  harness.headSha = green.pullRequest?.headSha ?? harness.headSha;

  const evidenceChanged = await coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    checks: [{ name: "npm test", status: "passed", details: "43 tests" }],
  });
  assert.equal(evidenceChanged.review, undefined);
  const staleEvidence = await coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(staleEvidence.status, "blocked");
  assert.match(staleEvidence.blockedReason ?? "", /independent review/);

  harness.onGh = async () => {
    await store.updateTask(implementation.projectId, implementation.id, (current) => ({
      ...current,
      checks: [{ name: "npm test", status: "passed", details: "changed during GitHub observation" }],
    }));
  };
  await assert.rejects(
    () => coordinator.refreshPullRequest(implementation.projectId, implementation.id),
    /evidence changed during pull request observation/,
  );
});
