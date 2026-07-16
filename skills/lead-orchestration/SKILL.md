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

For issue-backed work, pass the actual issue content and explicit acceptance criteria. Never replace issue scope with an invented smaller task. Before accepting implementation, delegate an independent review with the implementation task's `parentTaskId`. Review must return evidence for every acceptance criterion.

Use `lead_workers` to reconcile state, `lead_update_worker` after direct operator intervention or process exit, and `lead_refresh_pr` for authoritative GitHub status. Pending, failed, green, and merged are different states. A green PR requires reported validation, an approved independent review of the unchanged diff, a clean worktree, a matching PR head, and green GitHub checks (or no checks)—not merely a PR URL.

## Worker handoff

Workers call `lead_worker_report` at meaningful transitions:

- `running`
- `blocked` with a concrete reason
- `pr-ready-ci-pending`
- `pr-ready-ci-green`
- `completed`, `failed`, or `merged`

Reports should include validation checks, PR URL/commit when available, a concise handoff, and—on review workers—verdict, findings, and an acceptance matrix.

## Boundaries

Implementation intent permits an isolated branch/worktree, code changes, checks, commits, normal push, and PR creation. It does not permit:

- force-push
- merge
- deployment or production mutation
- destructive Linear operations or workspace switching
- credential access
- unrelated project or external-resource changes

Merge and deployment require separate direct operator authorization. Dangerous commands receive an interactive one-command gate. Routine project editing and safe shell commands are not globally disabled, and there are no mandatory contracts or approval phrases.
