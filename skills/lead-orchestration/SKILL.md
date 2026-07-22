---
name: lead-orchestration
description: Coordinate real visible Pi worker sessions from one persistent Lead session in cmux. Use for delegated implementation, research, independent review, PR validation, and concurrent issue work.
---

# Lead and visible workers

Treat the current Pi session as the persistent **Lead**. Keep the conversation natural and use normal `read`, `bash`, `edit`, and `write` tools directly when that is simplest.

## Delegation

Use `lead_delegate` when separate context is useful:

- `implementation`: creates an isolated Git worktree and opens a full interactive Pi TUI with shell/edit access.
- `research`: opens a visible read-only Pi session for bounded investigation.
- `review`: shares an implementation worker's worktree and receives a private packet containing the source issue, acceptance criteria, exact diff, and validation evidence.

Every worker is a live terminal surface in the caller's cmux workspace. The operator can inspect it, type into it, abort it, or continue the conversation. Use `lead_message_worker` to steer an existing worker without changing focus. Do not call one sequential implementer/reviewer pair a fleet; independent workers can run concurrently when their scopes do not overlap.

For issue-backed work, pass the actual issue content and explicit acceptance criteria. Never replace issue scope with an invented smaller task. If the implementation came from Linear, also pass the exact identifier or URL as `linearIssue`; omit it for local/GitHub-only work. As soon as that implementation worker is running, follow the emitted lifecycle instruction with @alasano/pi-linear: read the issue/team, resolve the read-proven In Progress (or canonical `started`) state ID, update only `stateId`, and verify via `linear_get_issue` readback. Missing Linear configuration never blocks implementation.

Before accepting implementation, delegate an independent review with the implementation task's `parentTaskId`. When an implementation reports PR-ready, V2 auto-spawns that bound review worker (per-project opt-out: `"autoReview": false` in the project record); a manual review delegate is only needed when auto-review is off or failed. Review must return evidence for every acceptance criterion. If a reviewer's verdict is rejected for stale evidence, steer it to call `lead_worker_report` with `rebindReviewTarget: true` and re-review the refreshed packet delta instead of delegating a replacement worker.

Use `lead_workers` to reconcile semantic and runtime state, `lead_update_worker` after direct operator intervention, and `lead_refresh_pr` for authoritative GitHub status. Runtime `busy`, `idle`, `stale`, `offline`, `detached`, and `needs-attention` are separate from semantic status; never call an idle/stale/offline/detached worker actively working solely because semantic status is `running`. Pending, failed, green, and merged are different states. A green PR requires reported validation, an approved independent review of the unchanged diff, a clean worktree, a matching PR head, and green GitHub checks (or no checks)—not merely a PR URL. Validation hashes cover check name + status only and exclude Greptile entries; Greptile results in the check rollup surface as additive first-class display evidence that never joins the review fingerprint and never skips the independent reviewer.

`/workers` is the operator triage surface for inspect, inbox message/nudge, handoff request, explicit open/focus, graceful stop, exact-surface retire, session resume, and close-eligible actions. Focus only after the operator selects that action. Retirement never deletes session files or worktrees; blocked workers are not automatically retired. Resume is safe only after exact topology/health proves the old owned surface missing/non-windowed (and closes/verifies a detached surface); a healthy old surface must refuse to avoid duplicate Pi processes. Capacity-full assignments remain durably queued and launch automatically when a slot opens, with one queued-launch wake and Linear lifecycle retry.

`lead_delegate` may set an explicit `model` and `thinking`, including `off`. Trusted private project policy can set project, role, and model-pattern defaults; precedence is explicit > model rule > role > project > inherited Lead. Treat the persisted resolved model/thinking as authoritative display evidence, while Pi performs capability clamping. Do not mutate global `models.json`.

## Worker handoff

Workers call `lead_worker_report` at meaningful transitions. Those transitions wake the persistent Lead automatically; continue the existing operator request from the handoff instead of waiting for another prompt:

- `blocked` with a concrete reason
- `pr-ready-ci-pending`
- `completed`, `failed`, or `stopped`

Green and merged transitions come only from authoritative `lead_refresh_pr` observation, not worker self-report. Reports should include validation checks, PR URL/commit when available, a concise handoff, and—on review workers—verdict, findings, and an acceptance matrix. Initial `running` is persisted but does not wake the Lead because the delegation turn already has that result. Deterministic heartbeats never wake the Lead. A settled run gets one automatic report reminder; a second reportless settle or an actionable stale/offline/detached transition creates one durable wake without inferring completion.

## Boundaries

Implementation intent permits an isolated branch/worktree, code changes, checks, commits, normal push, and PR creation. It does not permit:

- force-push
- merge
- deployment or production mutation
- destructive Linear operations or workspace switching
- credential access
- unrelated project or external-resource changes

Merge and deployment require separate direct operator authorization. Dangerous commands receive an interactive one-command gate. Routine project editing and safe shell commands are not globally disabled, and there are no mandatory contracts or approval phrases.
