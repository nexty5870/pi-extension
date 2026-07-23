---
name: lead-orchestration
description: Coordinate durable multi-Lead feature tracks and visible Pi workers in cmux, with V2 compatibility when V4 is not enabled.
---

# Lead orchestration

## V4 opt-in

When `PI_LEAD_V4=1`, this Pi session is a thin client attached to a durable local supervisor. The supervisor—not the interactive Lead—owns feature state, worker scheduling, launch reconciliation, and retained events. Lead death must not stop or duplicate workers.

Use normal conversation and internal tools; no slash command is required:

- `lead_v4_feature`: create/reuse an independently owned feature track.
- `lead_v4_spawn_lead`: launch a separate non-focused Lead for a named feature.
- `lead_v4_worker`: create implementation, research, or review work in the dedicated Agents workspace.
- `lead_v4_claim_feature`: claim an unowned track only after fenced owner expiry.
- `lead_v4_status` / `lead_v4_inspect`: inspect native state and exact records.
- `lead_v4_stop`: stop only an exact worker process; preserve its surface.
- `lead_v4_rollback_check`: prove V4 is quiescent before a fresh V2 process starts.

`/workers` is diagnostics compatibility, not the normal control plane.

### Tracks, review, and models

For issue-backed work, pass the exact issue and acceptance criteria. Exact `(repository, issue key)` initiation reuses one track. Natural-language lookalikes require an explicit existing/new choice.

Implementation workers get isolated branches/worktrees. Research may use the repository root. Review workers share one exact parent implementation worktree and remain separate tasks. Duplicate review calls reuse the exact task; after parent evidence changes, request an explicit new review generation. Use distinct explicit models per role when useful.

Model/thinking precedence is explicit operator > spawning Lead > feature preset > role/project > inherited Lead. Use canonical `provider/model` IDs. Missing/ambiguous choices fail visibly; never accept silent fallback. Requested and actual thinking are distinct because Pi may capability-clamp. Reviewer diversity is optional and explicit.

### Runtime truth and safety

Only stable cmux UUIDs are authoritative. `in_window:false` often means a healthy workspace is merely in the background; never infer detach from it. Worker liveness requires generation/token/session/process/UUID attestation. `unknown` forbids duplicate launch, resume, reuse, close, or cleanup and conservatively consumes capacity.

Events are at-least-once. One bounded digest claims all pending owned events; it can repeat if a Lead dies before acknowledgement. Routine completion/CI telemetry stays in native status and does not force a turn. Actionable blockers/crashes prefer the owning Lead and remain durable while no Lead is attached.

Never target Lead attachments for shutdown or cleanup. Automatic worker-surface retirement is off by default. Merge, deployment, production mutation, force-push, credentials, destructive Linear actions, and unrelated external changes require their existing separate boundaries.

## V2 default compatibility

Without `PI_LEAD_V4=1`, use the V2 tools:

- `lead_delegate` for visible implementation/research/review workers;
- `lead_workers`, `lead_message_worker`, `lead_update_worker`, and `lead_refresh_pr` for reconciliation;
- `lead_worker_report` for worker handoff.

V2 keeps one Lead-hosted supervisor, isolated implementation worktrees, read-only research/review workers, review packets, durable events, bounded visible surfaces, and GitHub evidence gates. Initial running is not a wake. All pending events are delivered in one wake batch. A valid running/blocked report suppresses report reminders because report baseline remains owned by agent start.

Do not call idle/stale/offline/detached V2 workers actively working solely from semantic `running`. Never force-push, merge, deploy, access credentials, or perform unrelated/destructive Linear actions.
