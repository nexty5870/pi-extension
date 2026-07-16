# Lead + visible workers V2

## Purpose

V2 is a small coordination layer around native Pi sessions, Git worktrees, cmux terminals, and GitHub. The operator talks to one persistent Lead session. The Lead decides when a separate context is useful and delegates to real interactive Pi sessions that remain visible and directly controllable.

It intentionally does **not** implement contracts, approval phrases, a hidden delivery controller, or global mutation lockdown.

## Runtime model

### Lead

The package loads `extensions/lead/index.ts` into the current Pi session. That session keeps Pi's normal tools and conversation. The extension adds four tools:

- `lead_delegate`
- `lead_workers`
- `lead_message_worker`
- `lead_update_worker`
- `lead_refresh_pr`

`/workers`, `/worker-message`, and `/lead-doctor` are optional operator shortcuts, not required workflow gates.

### Workers

`lead_delegate` creates or reuses one right-side helper pane in the exact caller cmux workspace. Each assignment gets a terminal surface and launches interactive Pi there. Creation passes `--focus false`; the extension never calls focus/select verbs.

Every worker has:

- a persistent Pi session ID and readable session name;
- a private assignment file under `~/.pi/lead-orchestration/`;
- a durable task record;
- the normal project context, extensions, and skills;
- a `lead_worker_report` tool for handoff and state updates.

The worker is not a JSON subprocess and is not hidden behind a log tail. The operator may select its surface, inspect tool calls, type steering messages, abort work, or continue the conversation. Lead-to-worker steering is placed in a private shared inbox; the worker extension injects it as a Pi user message, so V2 never sends arbitrary task text into a terminal that may have exited back to a shell.

### Roles

- **Implementation**: starts from the fetched default base when available, creates an isolated worktree and `pi/<slug>-<id>` branch, and retains full Pi shell/edit tools. Normal push and PR preparation are in scope.
- **Research**: runs against the project root with a read-only tool selection.
- **Review**: shares the selected implementation worktree with read-only tools. Before launch, V2 captures a private review packet containing the source issue, acceptance criteria, implementer handoff, validation results, Git status, and exact diff (capped at 200 KiB with instructions to inspect the full diff locally).

Independent assignments can run concurrently. A sequential implementation/review pair is not presented as a fleet.

## Durable task state

Task records use a deliberately small vocabulary:

- `starting`
- `running`
- `blocked` plus a reason
- `pr-ready-ci-pending`
- `pr-ready-ci-green`
- `completed`
- `failed`
- `stopped`
- `merged`

State lives at:

```text
~/.pi/lead-orchestration/
  projects/<project-id>/
    project.json
    tasks/<task-id>/
      task.json
      assignment.md
      launch-worker.sh
      review-packet.md      # review workers only
  worktrees/<project-id>/<task-id>/
```

Directories are mode `0700`; state, assignments, and review packets are mode `0600`. Writes are atomic and cross-process task updates use short lock files.

The Lead dashboard polls local task state. Pending PRs are observed with `gh pr view --json ...`; pending checks do not become failures merely because `gh pr checks` would exit non-zero. A task becomes `pr-ready-ci-green` only when CI is green, the worktree is clean, the PR head matches the local worker HEAD, and an independent approved review is bound to the unchanged diff hash. The extension never merges.

## Authorization and safety

Implementation intent is enough for worktree/branch creation, edits, checks, commits, normal push, and PR preparation. No contract or second approval is generated.

Normal Pi tools remain active. A narrow tool hook protects only clear boundaries:

- force-push is blocked;
- PR merge, deployment, production/cloud mutation, and destructive commands require an interactive one-command confirmation;
- destructive Linear tools and agent-driven workspace switching are blocked;
- known credential stores and real `.env` files are blocked;
- research/review workers cannot use edit/write and obvious mutating shell commands are blocked.

This is a coordination boundary, not an operating-system sandbox. Use containers or OS isolation for untrusted repositories.

## Linear

V2 does not own Linear authentication and does not route Linear through generic MCP. Install `@alasano/pi-linear`, authenticate with `/linear-auth`, and configure it with `/linear-settings`.

Routine Linear reads, tracking, administration, and plan publication do not require implementation contracts. The Lead should pass the actual issue and acceptance criteria into delegated work. Deletes, archive operations, and workspace switching remain outside the extension boundary.

## Local validation

From this repository:

```bash
npm test
npm run typecheck
git diff --check
```

Install the checkout as a local package once:

```bash
pi install /absolute/path/to/pi-harness
```

Then, in a Git repository opened inside cmux:

1. Run `/reload`.
2. Run `/lead-doctor`; Git, Pi, cmux, caller workspace, and caller surface should all be ready.
3. Ask: “Delegate a visible research worker to summarize the test layout.”
4. Confirm one right-side helper pane appears without stealing focus and that a live Pi TUI starts in its new surface.
5. Select that worker surface and type a follow-up. It should respond in the same persistent session.
6. Return to the Lead and run `/workers`; the same task ID and state should be shown.
7. Ask the Lead to send the worker a message; it should arrive without a workspace focus change.
8. In a disposable repository, delegate a small implementation. Verify the caller checkout stays unchanged and the worker operates under `~/.pi/lead-orchestration/worktrees/`.
9. Have the worker report checks and a PR, then delegate an independent review using the implementation task ID. Inspect the review assignment to confirm it covers the issue, criteria, diff, and check evidence.
10. Leave CI pending, then green. `/workers` should move from `pr-ready-ci-pending` to `pr-ready-ci-green` without a merge.

## Legacy retirement

`extensions/orchestration/` and `skills/team-orchestration/` remain in source for migration history and regression tests, but `package.json` no longer loads them. `/reload` switches an installed local checkout from the legacy extension to V2.
