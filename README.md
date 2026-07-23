# Pi Extension

Small, practical extensions for [Pi.dev](https://pi.dev), built while using Pi as a daily coding agent.

The repository is intentionally public-safe: it does not contain credentials, session transcripts, client information, production configuration, or private project instructions.

## Included extensions

### V4 multi-Lead durable supervisor (opt-in)

V4 moves supervision out of interactive Pi sessions into one detached, private local supervisor. Multiple Lead sessions can attach to the same project, own independent feature tracks, fail over after fenced lease expiry, and schedule workers fairly into a dedicated non-focused `Agents · <project>` cmux workspace.

Enable it for a fresh Lead process:

```bash
PI_LEAD_V4=1 pi
```

V4 and V2 are mutually exclusive inside an extension instance: the opt-in returns before any V2 timer, event claim, launch, reconciliation, or retirement path starts. Normal work uses plain-language-capable internal tools for feature creation, non-focused Lead spawning, worker/model selection, status, inspection, stop, and rollback checks. `/workers` is diagnostics compatibility only.

Highlights:

- one per-user detached Node supervisor behind a private, versioned AF_UNIX protocol and fencing epoch;
- at least three concurrent attachable Leads with persisted feature ownership and failover;
- canonical issue/task idempotency and explicit choices for ambiguous natural-language duplicates;
- separate `maxConcurrentLeads` and fair `maxConcurrentWorkerProcesses` limits;
- stable cmux UUID identity plus generation/token/session/process attestation—short refs and `in_window` are never liveness;
- explicit model/thinking precedence (operator > spawning Lead > feature > role/project > inherited), requested-versus-actual persistence, and visible no-fallback failures;
- one bounded owning-Lead digest for all pending events, retained while no Lead is attached; routine telemetry stays native and does not force a turn;
- no Lead shutdown/cleanup target and automatic worker-surface retirement off by default;
- read-only hashed V2 snapshots that are never resumed without fresh V4 attestation.

The production supervisor is checked in at `extensions/lead-v4/runtime/supervisor.mjs`; regenerate it with `npm run build:v4-supervisor`. See [`docs/lead-worker-v4.md`](docs/lead-worker-v4.md) for architecture, multi-Lead flow, models, recovery, safety, caveats, and rollback.

### Lead + visible workers (V2, default compatibility path)

One persistent **Lead** Pi session coordinates real, interactive Pi workers in the caller's cmux workspace. V2 removes mandatory contracts, approval phrases, hidden worker subprocesses, and global edit/tool lockouts.

- The Lead remains a normal Pi: conversation, `read`, `bash`, `edit`, and `write` all work normally.
- `lead_delegate` opens each worker as a visible Pi TUI that the operator can inspect and type into.
- Implementation workers receive isolated Git worktrees, full shell access, persistent named sessions, and the project's skills/extensions.
- Research workers are visible and read-only.
- Review workers share an implementation worktree and receive the issue, acceptance criteria, exact diff, and validation evidence.
- Multiple independent workers can run concurrently in tabs inside one non-focus-stealing helper pane; a configurable cap queues overflow and launches it when capacity opens.
- Pi lifecycle hooks record busy/idle/stale/offline/detached/attention state, timestamps, context use, runtime version, and exact cmux surface health separately from semantic task status.
- A reportless settled worker receives one automatic report nudge; a second reportless settle creates one durable attention wake without loops or inferred completion.
- Completed, blocked, review, PR, and actionable runtime transitions enter a durable ID-bearing outbox and wake the Lead exactly once per persisted event, including across `/reload`; heartbeats never wake it.
- Terminal workers shut down gracefully and eligible exact surfaces retire after retention. Detached/missing/retired sessions resume only after exact topology/health proof prevents a duplicate live Pi; session files/worktrees remain intact, and blocked workers are never auto-retired.
- Durable states distinguish `running`, `blocked`, `pr-ready-ci-pending`, `pr-ready-ci-green`, `completed`, `failed`, and `merged`.
- Pending PRs are polled through `gh pr view`; green requires complete GitHub evidence plus an approved review bound to the unchanged diff, exact head, and unchanged passing validation.

Natural implementation intent is enough to delegate work. There is no contract draft or second confirmation. Implementation covers an isolated branch, commits, normal push, and PR preparation; merge, deployment, production mutation, force-push, credentials, and destructive Linear operations remain separate boundaries.

Useful optional commands:

```text
/workers                         Inspect/triage runtime, handoff, focus, stop, retire, and resume
/worker-message <id> <message>  Steer an existing worker without changing focus
/lead-doctor                     Check Git, Pi, cmux, caller IDs, and state path
```

The Lead also has `lead_workers`, `lead_message_worker`, `lead_update_worker`, and `lead_refresh_pr` tools. Lead messages use a shared inbox consumed by the live worker extension—not keystrokes sent blindly to a terminal. `/workers` only changes focus after the operator explicitly selects open/focus, and each action states whether it mutates durable state, Pi, or cmux. Workers report blockers, checks, handoffs, PR state, and review evidence with `lead_worker_report`. State and private review packets live under `~/.pi/lead-orchestration/` with private permissions. Successful worktrees and sessions are never automatically deleted.

`lead_delegate` accepts per-worker `model` and `thinking` overrides, including `off`. Trusted private project policy supports project defaults, role rules, and model-pattern rules (explicit > model > role > project > inherited Lead). Resolved model/thinking is persisted and displayed; for example `openai/gpt-5.6-sol` can use `medium` while the Lead uses another level. Pi capability-clamps the level without any global `models.json` mutation. Exact JSON cmux health reconciliation is throttled independently (15 seconds by default) and fails closed without erasing last-known health. See [`docs/lead-worker-v2.md`](docs/lead-worker-v2.md) for lifecycle defaults and configuration.

For Linear, install and authenticate the companion package directly:

```bash
pi install npm:@alasano/pi-linear
```

Use `/linear-auth` and `/linear-settings`; never paste a credential into chat. For Linear-backed implementation, the Lead binds `lead_delegate.linearIssue`, resolves the issue's canonical team workflow through pi-linear, updates only `stateId` to the team's started/In Progress state, and requires `linear_get_issue` readback. Local/GitHub-only work omits the binding and performs no Linear call. Missing auth or disabled tools never block worker startup; the lifecycle sync remains visible and retryable. V2 does not wrap routine Linear reads or administration in implementation contracts. Destructive Linear operations and agent-driven workspace switching remain blocked.

The legacy implementation remains in `extensions/orchestration/` only for migration history and regression reference. It is no longer loaded by the package manifest. See [`docs/lead-worker-v2.md`](docs/lead-worker-v2.md) for architecture and validation.

### `/update`

Update Pi with its supported self-update command and restart the current TUI in place.

```text
/update          Update Pi when a newer release is available
/update force    Force a reinstall of the current Pi release
```

After a successful update, the extension:

1. Records the current session
2. Runs Pi's extension reload lifecycle for cleanup
3. Replaces the current process with the updated Pi CLI
4. Reopens the same working directory and session
5. Displays a one-time confirmation in the new TUI

Examples of the confirmation:

```text
Pi updated successfully: 0.80.6 → 0.80.7
Pi is already up to date: 0.80.7
Pi reinstalled successfully: 0.80.7
```

The process replacement uses Node.js `process.execve()`. Keeping the same process ID prevents the parent shell and restarted TUI from competing for the terminal.

Failed updates leave the existing TUI running and display the update output.

## Requirements

- Pi.dev coding agent
- Node.js 22.15 or newer (`process.execve()` support for `/update`)
- Git and cmux with stable caller UUIDs available through `cmux identify --json` (`CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` in the terminal)
- GitHub CLI (`gh`) for PR status observation and publication by workers
- An installation that Pi can update with `pi update --self`

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/nexty5870/pi-extension
```

Restart Pi or run `/reload` once after the initial install. Then run:

```text
/update
```

### Local development installation

```bash
pi install /path/to/pi-extension
```

Because this is a local-path Pi package, source changes become available after `/reload`.

## How it works

The command invokes the currently running Pi CLI with:

```bash
pi update --self
```

It verifies the version before and after the command. On success it places a one-time confirmation in the replacement process environment, runs `ctx.reload()` so extensions receive `session_shutdown`, and calls `process.execve()` to start the newly installed CLI in the same process.

`ctx.reload()` alone is not sufficient for a Pi core update: it reloads extensions, skills, prompts, themes, and context files, but already-loaded Pi JavaScript remains in memory. Process replacement is what activates the updated Pi runtime.

## Safety and privacy

- `/update` only runs in interactive TUI mode
- No credentials are read or stored
- No session content is sent anywhere
- No telemetry is added
- The extension only invokes Pi's official self-update command
- Update output is shown only when the command fails

Before publishing changes, check tracked files for credentials, private paths, session data, and project-specific information.

## Development

Load either extension temporarily:

```bash
pi -e ./extensions/lead/index.ts
pi -e ./extensions/update.ts
```

Verify command registration through RPC without performing an update or starting workers:

```bash
printf '{"id":"commands","type":"get_commands"}\n' |
  pi --mode rpc --no-session -e ./extensions/lead/index.ts
```

Run `npm run build:v4-supervisor`, `npm test`, `npm run typecheck`, and `git diff --check` before publishing. The `/update` command refuses execution outside interactive TUI mode.

## Journey

Development notes and lessons are recorded in [`docs/journey.md`](docs/journey.md). They intentionally focus on Pi APIs and general engineering decisions rather than private projects.

## License

MIT — see [`LICENSE`](LICENSE).
