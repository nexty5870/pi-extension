import { isGreptileEvidence } from "./github.ts";
import type { TaskRecord } from "./types.ts";

function section(title: string, body: string | undefined): string {
  return body?.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

function criteria(task: TaskRecord): string {
  if (task.brief.acceptanceCriteria.length === 0) return "- Infer concrete completion criteria from the task and report them in your handoff.";
  return task.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
}

export function workerPrompt(task: TaskRecord, reviewPacketPath?: string): string {
  const identity = task.role === "review"
    ? "You are an independent review worker in a real, visible Pi session."
    : task.role === "research"
      ? "You are a research worker in a real, visible Pi session."
      : "You are an implementation worker in a real, visible Pi session with shell and editing access.";
  const roleInstructions = task.role === "review"
    ? [
        "Review the issue, every acceptance criterion, the exact current diff, and validation evidence.",
        "Do not modify files. You may run read-only inspection and validation commands.",
        `Read the review packet at ${reviewPacketPath ?? "the path supplied by the Lead"}; run git diff yourself if its diff is truncated.`,
        "If a verdict is rejected because the diff, HEAD, or validation evidence moved, call lead_worker_report with rebindReviewTarget: true to re-capture the target at the current HEAD, review the refreshed packet delta, then report the verdict again. Do not wait for a new review worker.",
        "Before finishing, call lead_worker_report with a verdict, findings, and an acceptance matrix containing evidence for every criterion.",
      ]
    : task.role === "research"
      ? [
          "Inspect only. Do not modify project files, publish branches, or change external systems.",
          "Call lead_worker_report with a concise handoff containing findings and exact file references.",
        ]
      : [
          "Implement only the assigned scope in this isolated worktree.",
          "Use bash, edit, and write normally. Run the relevant validation yourself.",
          "Commit and push the worker branch and open or update a PR when the work is ready. Never force-push.",
          "Do not merge, deploy, mutate production, or make unrelated Linear changes.",
          "Call lead_worker_report when blocked, after validation, when the PR is waiting on CI, and when CI is green.",
          "If CI fails, inspect it and repair regressions; keep the Lead informed rather than silently stopping.",
        ];

  return [
    "# Lead worker assignment",
    "",
    identity,
    "The operator can inspect this terminal and intervene directly. Treat new messages in this session as current operator direction.",
    "",
    section("Task", `${task.brief.title}\n\n${task.brief.task}`),
    section("Issue", task.brief.issue),
    section("Acceptance criteria", criteria(task)),
    section("Workspace", [
      `- Task ID: ${task.id}`,
      `- Role: ${task.role}`,
      `- Worktree: ${task.worktreePath}`,
      task.branchName ? `- Branch: ${task.branchName}` : "",
      task.baseSha ? `- Review base SHA: ${task.baseSha}` : "",
      task.parentTaskId ? `- Parent implementation task: ${task.parentTaskId}` : "",
      task.linear ? `- Linear issue: ${task.linear.issueIdentifier} (lifecycle updates are owned by the Lead)` : "",
      task.resolvedWorker?.model ? `- Resolved model: ${task.resolvedWorker.model}` : "",
      task.resolvedWorker?.thinking ? `- Resolved thinking: ${task.resolvedWorker.thinking} (Pi clamps to model capabilities)` : "",
    ].filter(Boolean).join("\n")),
    "## Working agreement",
    "",
    ...roleInstructions.map((instruction) => `- ${instruction}`),
    "- Never expose credentials or read private credential stores.",
    "- Keep the session open when you finish so the operator can inspect or continue it.",
    "",
  ].join("\n");
}

export function reviewPacket(task: TaskRecord, parent: TaskRecord, git: {
  status: string;
  diff: string;
  truncated: boolean;
  diffHash: string;
  headSha: string;
}): string {
  const acceptance = parent.brief.acceptanceCriteria.length > 0
    ? parent.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
    : "- No explicit criteria were supplied; identify and state the criteria you applied.";
  const checks = parent.checks.length > 0
    ? parent.checks.map((check) => `- ${check.name}: ${check.status}${check.details ? ` — ${check.details}` : ""}`).join("\n")
    : "- No validation evidence has been reported yet. Run the relevant checks yourself.";
  const githubChecks = parent.pullRequest?.checks.length
    ? parent.pullRequest.checks.map((check) => `- ${check.name}: ${check.status}${check.details ? ` — ${check.details}` : ""}`).join("\n")
    : undefined;
  const greptile = [...parent.checks, ...(parent.pullRequest?.checks ?? [])].filter(isGreptileEvidence);
  const greptileSection = greptile.length > 0
    ? greptile.map((check) => `- ${check.name}: ${check.status}${check.details ? ` — ${check.details}` : ""}`).join("\n")
    : undefined;
  return [
    `# Review packet: ${parent.brief.title}`,
    "",
    `Review task: ${task.id}`,
    `Implementation task: ${parent.id}`,
    `Base SHA: ${parent.baseSha ?? "unknown"}`,
    `Captured HEAD: ${git.headSha}`,
    `Diff hash: ${git.diffHash}`,
    `Implementation worker model: ${parent.resolvedWorker?.model ?? "not recorded"}`,
    `Implementation worker thinking: ${parent.resolvedWorker?.thinking ?? "not recorded"}`,
    `Review worker model: ${task.resolvedWorker?.model ?? "not recorded"}`,
    `Review worker thinking: ${task.resolvedWorker?.thinking ?? "not recorded"}`,
    "",
    section("Linear issue / source issue", parent.brief.issue),
    section("Requested outcome", parent.brief.task),
    section("Acceptance criteria", acceptance),
    section("Implementer handoff", parent.handoff ?? parent.summary),
    section("Validation evidence", checks),
    section("GitHub check evidence", githubChecks),
    section("Greptile review", greptileSection),
    section("Pull request", parent.pullRequest?.url),
    section("Git status", git.status || "clean"),
    "## Exact diff",
    "",
    git.truncated
      ? "> The embedded diff is truncated at 200 KiB. Review it, then run `git diff <base-sha> --` in the worktree for the complete diff."
      : "> Complete diff captured when this review session was created.",
    "",
    "```diff",
    git.diff || "(no diff)",
    "```",
    "",
  ].join("\n");
}

export const LEAD_SYSTEM_PROMPT = `You are the persistent Lead for this project. Work conversationally and use your normal Pi tools without contract ceremony or global edit restrictions.

Delegate when a separate context is genuinely useful. Use lead_delegate for implementation, research, and independent review. Every delegated worker is a real visible Pi TUI in the caller's cmux workspace; the operator can inspect and intervene directly. Do not describe a sequential implementer/reviewer pair as a fleet. Multiple independent workers may run concurrently.

For issue-backed work, give workers the actual issue context and acceptance criteria. When an implementation comes from Linear, pass its exact identifier or URL in lead_delegate.linearIssue. Immediately follow the emitted Linear lifecycle instruction: use @alasano/pi-linear reads to resolve the issue's team and canonical started/In Progress state, update only that issue's stateId, and verify with linear_get_issue readback. Do not invent a Linear binding for local or GitHub-only work, and never block worker startup when Linear is absent or unavailable.

Before accepting implementation, create an independent review worker so its packet includes the issue, criteria, exact diff, and validation evidence. When an implementation reports PR-ready, V2 automatically launches the bound review worker unless the project record sets autoReview: false; you still receive every durable wake event. If a reviewer reports a stale-evidence rejection, steer it to rebind its review target instead of creating a replacement worker. Use lead_message_worker to steer an existing worker instead of replacing it unnecessarily. Use lead_update_worker only to reconcile state after direct operator intervention or a worker exit. Use lead_refresh_pr to distinguish pending, failed, green, and merged PR states.

Implementation authorizes an isolated branch, commits, normal push, and PR preparation. It never implies merge, deployment, production mutation, force-push, destructive Linear operations, or unrelated changes. Merge and deployment require separate direct operator authorization.`;
