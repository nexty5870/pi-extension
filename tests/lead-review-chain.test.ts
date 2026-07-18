import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LeadCoordinator, summarizeTasks, validationEvidenceHash } from "../extensions/lead/coordinator.ts";
import type { CommandExecutor } from "../extensions/lead/git.ts";
import { classifyPullRequest, isGreptileEvidence } from "../extensions/lead/github.ts";
import { LeadStore } from "../extensions/lead/store.ts";
import type { TaskRecord } from "../extensions/lead/types.ts";

const execFileAsync = promisify(execFile);

type CheckRollupPayload = Record<string, unknown>;

class HarnessExecutor {
  helperPane = false;
  surface = 10;
  ci: "pending" | "green" = "green";
  headSha = "abc123";
  extraChecks: CheckRollupPayload[] = [];

  execute: CommandExecutor = async (command, args, options) => {
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
      return {
        stdout: JSON.stringify({
          url: "https://github.com/example/repo/pull/7",
          state: "OPEN",
          headRefOid: this.headSha,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { name: "test", status: this.ci === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: this.ci === "pending" ? "" : "SUCCESS" },
            ...this.extraChecks,
          ],
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

interface Fixture {
  store: LeadStore;
  coordinator: LeadCoordinator;
  harness: HarnessExecutor;
  runtime: {
    cwd: string;
    sessionFile: string;
    cmuxWorkspaceId: string;
    cmuxSurfaceId: string;
  };
}

async function createFixture(): Promise<Fixture> {
  const fixture = await mkdtemp(join(tmpdir(), "pi-lead-chain-"));
  const repo = join(fixture, "repo");
  const remote = join(fixture, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "feature.ts"), "export const value = 1;\n");
  await git(repo, "add", "feature.ts");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  const harness = new HarnessExecutor();
  const store = new LeadStore(join(fixture, "state"));
  const coordinator = new LeadCoordinator(store, harness.execute, { command: "pi", leadingArgs: [] }, "/opt/pi-extension/extensions/lead/index.ts");
  return {
    store,
    coordinator,
    harness,
    runtime: {
      cwd: repo,
      sessionFile: join(fixture, "lead.jsonl"),
      cmuxWorkspaceId: "workspace:2",
      cmuxSurfaceId: "surface:caller",
    },
  };
}

async function delegateImplementation(fixture: Fixture): Promise<TaskRecord> {
  return fixture.coordinator.delegate({
    title: "Implement the feature",
    task: "Implement the issue completely and prepare a green PR.",
    issue: "#7 — Implement the feature.",
    acceptanceCriteria: ["Feature works", "Tests cover it"],
  }, fixture.runtime);
}

async function commitValue(worktreePath: string, value: number): Promise<string> {
  await writeFile(join(worktreePath, "feature.ts"), `export const value = ${value};\n`);
  await git(worktreePath, "add", "feature.ts");
  await git(worktreePath, "commit", "-m", `value ${value}`);
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" })).stdout.trim();
}

function acceptance(task: TaskRecord) {
  return task.brief.acceptanceCriteria.map((criterion) => ({ criterion, status: "met" as const, evidence: "diff and test run" }));
}

test("validation evidence hash ignores check details", () => {
  const before = [{ name: "npm test", status: "passed" as const, details: "run 1 · 42 tests" }];
  const after = [{ name: "npm test", status: "passed" as const, details: "run 2 · 43 tests" }];
  assert.equal(validationEvidenceHash(before), validationEvidenceHash(after));
  assert.notEqual(
    validationEvidenceHash(before),
    validationEvidenceHash([{ name: "npm test", status: "failed" as const, details: "run 1 · 42 tests" }]),
  );
  assert.notEqual(validationEvidenceHash(before), validationEvidenceHash([...before, { name: "lint", status: "skipped" as const }]));
});

test("implementation PR-ready report auto-spawns one bound review worker; opt-out honored", async () => {
  const fixture = await createFixture();
  const implementation = await delegateImplementation(fixture);
  const head = await commitValue(implementation.worktreePath, 2);
  fixture.harness.headSha = head;

  const reported = await fixture.coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    summary: "Implemented",
    prUrl: "https://github.com/example/repo/pull/7",
    commitSha: head,
    checks: [{ name: "npm test", status: "passed" }],
  });
  assert.ok(reported.autoReview?.spawnedTaskId);
  const tasks = await fixture.coordinator.list(implementation.projectId);
  const reviews = tasks.filter((task) => task.role === "review");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].parentTaskId, implementation.id);
  assert.equal(reviews[0].status, "running");
  assert.equal(reviews[0].reviewTarget?.headSha, head);
  assert.deepEqual(reviews[0].brief.acceptanceCriteria, implementation.brief.acceptanceCriteria);
  const parent = await fixture.store.requireTask(implementation.projectId, implementation.id);
  assert.equal(parent.autoReview?.spawnedTaskId, reviews[0].id);
  const packet = await readFile(join(fixture.store.taskArtifactDirectory(reviews[0].projectId, reviews[0].id), "review-packet.md"), "utf8");
  assert.match(packet, /\+export const value = 2/);
  assert.match(packet, /Feature works/);
  assert.match(packet, /npm test: passed/);

  // A second PR-ready report does not duplicate the active review worker.
  await fixture.coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    checks: [{ name: "npm test", status: "passed", details: "re-run" }],
  });
  const after = await fixture.coordinator.list(implementation.projectId);
  assert.equal(after.filter((task) => task.role === "review").length, 1);

  const optedOut = await createFixture();
  const optedOutImplementation = await delegateImplementation(optedOut);
  const project = await optedOut.store.readProject(optedOutImplementation.projectId);
  await optedOut.store.saveProject({ ...project!, autoReview: false });
  const optedOutHead = await commitValue(optedOutImplementation.worktreePath, 2);
  await optedOut.coordinator.report(optedOutImplementation.projectId, optedOutImplementation.id, {
    status: "completed",
    prUrl: "https://github.com/example/repo/pull/8",
    commitSha: optedOutHead,
    checks: [{ name: "npm test", status: "passed" }],
  });
  const optedOutTasks = await optedOut.coordinator.list(optedOutImplementation.projectId);
  assert.equal(optedOutTasks.filter((task) => task.role === "review").length, 0);

  // Re-enabling auto-review lets a completed-with-PR report chain the review.
  await optedOut.store.saveProject({ ...project!, autoReview: true });
  await optedOut.coordinator.report(optedOutImplementation.projectId, optedOutImplementation.id, {
    status: "completed",
    checks: [{ name: "npm test", status: "passed" }],
  });
  const reenabled = await optedOut.coordinator.list(optedOutImplementation.projectId);
  assert.equal(reenabled.filter((task) => task.role === "review").length, 1);
});

test("reviewer rejected for stale evidence rebinds to the current HEAD and approves", async () => {
  const fixture = await createFixture();
  const implementation = await delegateImplementation(fixture);
  const first = await commitValue(implementation.worktreePath, 2);
  fixture.harness.headSha = first;
  await fixture.coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    prUrl: "https://github.com/example/repo/pull/7",
    commitSha: first,
    checks: [{ name: "npm test", status: "passed", details: "42 tests" }],
  });
  const review = (await fixture.coordinator.list(implementation.projectId)).find((task) => task.role === "review")!;
  assert.ok(review);

  // The implementation moves after the review target was captured.
  const second = await commitValue(implementation.worktreePath, 3);
  fixture.harness.headSha = second;
  await assert.rejects(
    () => fixture.coordinator.report(review.projectId, review.id, {
      reviewVerdict: "approved",
      acceptance: acceptance(implementation),
      findings: [],
    }),
    /diff or HEAD changed[\s\S]*rebindReviewTarget: true/,
  );

  // Only review workers can rebind, and rebind is exclusive.
  await assert.rejects(
    () => fixture.coordinator.report(implementation.projectId, implementation.id, { rebindReviewTarget: true }),
    /Only a bound review worker/,
  );
  await assert.rejects(
    () => fixture.coordinator.report(review.projectId, review.id, {
      rebindReviewTarget: true,
      reviewVerdict: "approved",
      acceptance: acceptance(implementation),
    }),
    /separate call/,
  );

  const rebound = await fixture.coordinator.report(review.projectId, review.id, { rebindReviewTarget: true });
  assert.equal(rebound.reviewTarget?.headSha, second);
  assert.notEqual(rebound.reviewTarget?.diffHash, review.reviewTarget?.diffHash);
  assert.equal(rebound.reviewTarget?.checksHash, validationEvidenceHash([{ name: "npm test", status: "passed", details: "42 tests" }]));
  const packet = await readFile(join(fixture.store.taskArtifactDirectory(review.projectId, review.id), "review-packet.md"), "utf8");
  assert.match(packet, /\+export const value = 3/);
  assert.match(packet, new RegExp(`Captured HEAD: ${second}`));

  // Cosmetic check re-reports (details only) do not stale the rebound fingerprint.
  await fixture.coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    checks: [{ name: "npm test", status: "passed", details: "43 tests · new run id" }],
  });

  const verdict = await fixture.coordinator.report(review.projectId, review.id, {
    reviewVerdict: "approved",
    acceptance: acceptance(implementation),
    findings: [],
  });
  assert.equal(verdict.status, "completed");
  const parent = await fixture.store.requireTask(implementation.projectId, implementation.id);
  assert.equal(parent.review?.verdict, "approved");
  assert.equal(parent.review?.headSha, second);

  // Readiness verifies against the rebound fingerprint.
  const green = await fixture.coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(green.status, "pr-ready-ci-green");
});

test("Greptile rollup entries become first-class check evidence on the task", async () => {
  const classified = classifyPullRequest({
    url: "https://github.com/example/repo/pull/7",
    state: "OPEN",
    headRefOid: "abc123",
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "greptile", state: "SUCCESS", description: "5/5 confidence", targetUrl: "https://app.greptile.com/review/1" },
    ],
  });
  assert.equal(classified.status, "green");
  const greptile = classified.checks.find(isGreptileEvidence)!;
  assert.equal(greptile.name, "greptile");
  assert.equal(greptile.status, "passed");
  assert.equal(greptile.details, "5/5 confidence — https://app.greptile.com/review/1");

  const fixture = await createFixture();
  fixture.harness.extraChecks = [
    { __typename: "StatusContext", context: "greptile", state: "SUCCESS", description: "5/5 confidence", targetUrl: "https://app.greptile.com/review/1" },
  ];
  const implementation = await delegateImplementation(fixture);
  const head = await commitValue(implementation.worktreePath, 2);
  fixture.harness.headSha = head;
  await fixture.coordinator.report(implementation.projectId, implementation.id, {
    status: "pr-ready-ci-pending",
    prUrl: "https://github.com/example/repo/pull/7",
    commitSha: head,
    checks: [{ name: "npm test", status: "passed" }],
  });
  const refreshed = await fixture.coordinator.refreshPullRequest(implementation.projectId, implementation.id);
  assert.equal(refreshed.status, "blocked"); // still needs independent review
  const taskGreptile = refreshed.checks.find(isGreptileEvidence)!;
  assert.equal(taskGreptile.status, "passed");
  assert.match(taskGreptile.details ?? "", /5\/5 confidence/);
  const summary = summarizeTasks(await fixture.coordinator.list(implementation.projectId));
  assert.match(summary, /Greptile: passed — 5\/5 confidence/);

  // A still-running Greptile stays on the PR checks and never gates approval evidence.
  const pendingFixture = await createFixture();
  pendingFixture.harness.ci = "pending";
  pendingFixture.harness.extraChecks = [
    { __typename: "StatusContext", context: "greptile", state: "PENDING", targetUrl: "https://app.greptile.com/review/2" },
  ];
  const pendingImplementation = await delegateImplementation(pendingFixture);
  const pendingHead = await commitValue(pendingImplementation.worktreePath, 2);
  pendingFixture.harness.headSha = pendingHead;
  await pendingFixture.coordinator.report(pendingImplementation.projectId, pendingImplementation.id, {
    status: "pr-ready-ci-pending",
    prUrl: "https://github.com/example/repo/pull/7",
    commitSha: pendingHead,
    checks: [{ name: "npm test", status: "passed" }],
  });
  const pendingRefresh = await pendingFixture.coordinator.refreshPullRequest(pendingImplementation.projectId, pendingImplementation.id);
  assert.equal(pendingRefresh.status, "pr-ready-ci-pending");
  assert.equal(pendingRefresh.checks.some(isGreptileEvidence), false);
  assert.equal(pendingRefresh.pullRequest?.checks.some(isGreptileEvidence), true);
});
