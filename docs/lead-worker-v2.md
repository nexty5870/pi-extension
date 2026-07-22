# Lead + visible workers V2

## Purpose

V2 is a small coordination layer around native Pi sessions, Git worktrees, cmux terminals, and GitHub. The operator talks to one persistent Lead session. The Lead decides when a separate context is useful and delegates to real interactive Pi sessions that remain visible and directly controllable.

It intentionally does **not** implement contracts, approval phrases, a hidden delivery controller, or global mutation lockdown.

## Runtime model

### Lead

The package loads `extensions/lead/index.ts` into the current Pi session. That session keeps Pi's normal tools and conversation. The extension adds five tools:

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

### V2.1 runtime supervisor

Semantic task status and process runtime truth are deliberately separate. Pi hooks drive `starting`, `busy`, `idle`, `stale`, `offline`, `detached`, and `needs-attention` telemetry with heartbeat/activity/report/settled timestamps, context use, runtime version, and cmux health. Timers begin only in `session_start` and stop idempotently in `session_shutdown`. Runtime heartbeat writes preserve semantic `task.updatedAt` and never create Lead events.

A reportless `agent_settled` schedules one grace-period follow-up. If that follow-up also settles without `lead_worker_report`, the supervisor persists one ID-bearing runtime attention event; it never loops or infers completion. Context warnings default to 80%; at 92% the worker receives one durable-handoff request without changing semantic status.

The Lead reconciles on startup/reload and on an independently throttled supervision cadence (15 seconds by default) using persisted workspace/pane/surface IDs, JSON `list-panes`, `list-pane-surfaces`, and `surface-health --json`. One topology snapshot is reused for each pass. Invalid/incomplete JSON fails closed: prior health is retained and an explicit telemetry error is recorded rather than mass-classifying surfaces as missing. It never scrapes terminal text. Missing/non-windowed surfaces become resumable detached runtime records and each actionable transition wakes the Lead exactly once across reload. Only an explicit operator-selected `/workers` action calls a cmux focus command.

### Roles

- **Implementation**: starts from the fetched default base when available, creates an isolated worktree and `pi/<slug>-<id>` branch, and retains full Pi shell/edit tools. Normal push and PR preparation are in scope.
- **Research**: runs against the project root with a read-only tool selection.
- **Review**: shares the selected implementation worktree with read-only tools. Before launch, V2 captures a private review packet containing the source issue, acceptance criteria, implementer handoff, validation results, Git status, and exact diff (capped at 200 KiB with instructions to inspect the full diff locally).

When an implementation reports `pr-ready-ci-pending` or `completed` with a PR URL, the coordinator automatically spawns the bound review worker with a fresh packet — no Lead turn is required, and the Lead still receives every durable wake event. Exactly one active review worker exists per implementation; repeat PR-ready reports do not duplicate it. Set `"autoReview": false` in `projects/<project-id>/project.json` to opt a project out (default ON; `/lead-doctor` shows the effective setting).

If a review verdict is rejected because the implementation HEAD, diff, or validation evidence moved after the target was captured, the same review worker rebinds instead of dead-ending: it calls `lead_worker_report` with `rebindReviewTarget: true`, which verifies the parent's readiness fingerprint, refreshes `review-packet.md` at the current HEAD, and only then persists the new target (new `headSha`/`diffHash`/`checksHash`) — a failed rebind leaves the previous target and packet untouched. The worker then re-reviews the delta and reports the verdict in a separate call. Approval stays bound to the exact rebound fingerprint, and the locked readiness re-check on the parent still applies while the verdict is recorded.

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

The Lead dashboard polls local task and runtime state. It never presents an idle, stale, offline, or detached task as actively working merely because semantic status is `running`. The widget shows runtime state, context percentage, blockers, and pending events. `/workers` exposes details, inbox message/nudge, durable handoff request, explicit open/focus, graceful stop, exact-surface retirement, session resume, close-eligible, and event dismissal. Every action names its mutation scope; no action deletes a session file or worktree. In non-TTY contexts (and inside worker sessions) `/workers` falls back to the plain status notification.

Every actionable status/review transition is first appended to a durable per-task outbox. Delivery uses a persisted lease, then injects one ID-bearing custom message into the persistent Lead session. The event remains unobserved until that exact ID appears in session entries; a later poll acknowledges the receipt. This closes the asynchronous send-before-ack window while preserving ordered `completed`, `blocked`, review, PR, failure, stop, and merge events across startup or `/reload`. Initial `running` is not a wake event because the active delegation turn already observes it.

Pending PRs are observed with `gh pr view --json ...`; missing state, head, or check-rollup evidence fails closed as pending. A task becomes `pr-ready-ci-green` only when CI is green, the worktree is clean, the PR head matches the exact reviewed worker HEAD, implementation validation is complete/passing and unchanged since review, and an independent approval is bound to that HEAD, diff hash, and validation hash. Validation hashes cover check `name` + `status` only, so cosmetic re-reports (new CI run IDs, refreshed details) never invalidate a review. Greptile results in the GitHub check rollup become first-class check evidence on the task once they reach a terminal state — additive display/readiness evidence that never joins the review fingerprint, never satisfies validation completeness on its own, and never replaces the independent reviewer. Worker check re-reports keep the merged Greptile entries. The extension never merges.

### Surface retention, capacity, and worker policy

Terminal workers request graceful Pi shutdown after their durable report. Completed, merged, stopped, and observed-failed surfaces become reclaimable after retention only once runtime is offline; blocked workers are never auto-retired. Retirement closes the exact owned surface and retains both session and worktree. `maxVisibleSurfaces` is enforced with renewable five-minute cross-process launch claims: eligible surfaces are reclaimed first, otherwise the assignment remains queued and launches on a later supervision poll. Queued-to-running launches persist one Lead event and re-arm a pending Linear lifecycle prompt exactly once.

Detached, missing-surface, and retired tasks can resume the same Pi `sessionId` in a fresh owned surface. Resume first takes a fresh exact topology/health snapshot. A healthy old surface refuses resume to avoid duplicate live Pi processes; a non-windowed old surface is closed by exact ID and verified absent, while an already-missing/retired surface is proven absent. Surface/runtime replacement is persisted atomically and session/worktree files remain untouched.

Trusted policy lives in the project's private `project.json` under `workers` (not in repository configuration):

```json
{
  "workers": {
    "maxVisibleSurfaces": 6,
    "heartbeatSeconds": 15,
    "staleAfterSeconds": 120,
    "idleReportGraceSeconds": 15,
    "terminalSurfaceRetentionMinutes": 10,
    "contextWarnPercent": 80,
    "contextHandoffPercent": 92,
    "supervisionSeconds": 15,
    "default": { "inheritModel": true, "thinking": "high" },
    "roles": { "research": { "thinking": "medium" } },
    "models": [{ "pattern": "openai/gpt-5.6-sol", "thinking": "medium" }]
  }
}
```

Resolution is explicit delegation override, then matching resolved-model rule, role rule, project default, and finally inherited Lead settings. The resolved provider/model and thinking level (including `off`) are persisted and shown in status and review evidence. `off` omits the launcher's `--thinking` flag. Pi performs model-capability clamping through `thinkingLevelMap`; this extension never mutates `models.json`.

## Authorization and safety

Implementation intent is enough for worktree/branch creation, edits, checks, commits, normal push, and PR preparation. No contract or second approval is generated.

Normal Pi tools remain active. A narrow tool hook protects only clear boundaries:

- force-push is blocked;
- PR merge, deployment, production/cloud mutation, and destructive commands require an interactive one-command confirmation;
- destructive Linear tools and agent-driven workspace switching are blocked;
- known credential stores, resolved symlink targets, real `.env` files, and environment dumps are blocked across file-search and shell tools;
- research/review workers cannot use edit/write and bash is restricted to an explicit read-only command allowlist.

This is a coordination boundary, not an operating-system sandbox. Use containers or OS isolation for untrusted repositories.

## Linear

V2 does not own Linear authentication and does not route Linear through generic MCP. Install `@alasano/pi-linear`, authenticate with `/linear-auth`, and configure it with `/linear-settings`.

Routine Linear reads, tracking, administration, and plan publication do not require implementation contracts. The Lead should pass the actual issue and acceptance criteria into delegated work.

When an implementation is backed by Linear, `lead_delegate.linearIssue` stores an explicit issue binding. Once the visible worker is running, the Lead receives a lifecycle instruction that:

1. reads the exact issue with `linear_get_issue`;
2. resolves workflow states for that issue's canonical team with `linear_list_issue_statuses`;
3. prefers the read-proven state named **In Progress**, otherwise the team's canonical state with type `started`;
4. updates only that issue's `stateId` through `linear_update_issue`;
5. reads the issue again and records success only after state type `started` is confirmed.

The update runs in the Lead session only after a durable successful worker launch; failed, stopped, or terminal workers are not resumed into In Progress. Prompt issuance uses a persisted cross-session claim and cooldown. Automatic writes are temporarily scoped to the pending bound issue and an unexpired state ID bound to the latest exact-team issue/status reads. Workers remain unable to mutate Linear. The binding is omitted for local/GitHub-only tasks. Disabled pi-linear tools, absent auth, and API/schema failures do not stop the worker or consume the desired lifecycle action: state remains visible as `pending`/`unavailable` and can be retried while the worker remains active. Deletes, archive operations, and workspace switching remain outside the extension boundary.

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
