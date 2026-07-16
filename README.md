# Pi Extension

Small, practical extensions for [Pi.dev](https://pi.dev), built while using Pi as a daily coding agent.

The repository is intentionally public-safe: it does not contain credentials, session transcripts, client information, production configuration, or private project instructions.

## Included extensions

### Lead + visible workers (V2)

One persistent **Lead** Pi session coordinates real, interactive Pi workers in the caller's cmux workspace. V2 removes mandatory contracts, approval phrases, hidden worker subprocesses, and global edit/tool lockouts.

- The Lead remains a normal Pi: conversation, `read`, `bash`, `edit`, and `write` all work normally.
- `lead_delegate` opens each worker as a visible Pi TUI that the operator can inspect and type into.
- Implementation workers receive isolated Git worktrees, full shell access, persistent named sessions, and the project's skills/extensions.
- Research workers are visible and read-only.
- Review workers share an implementation worktree and receive the issue, acceptance criteria, exact diff, and validation evidence.
- Multiple independent workers can run concurrently in tabs inside one non-focus-stealing helper pane.
- Completed, blocked, review, and PR transitions durably wake the Lead so it can take the next step without another operator prompt.
- Durable states distinguish `running`, `blocked`, `pr-ready-ci-pending`, `pr-ready-ci-green`, `completed`, `failed`, and `merged`.
- Pending PRs are polled through `gh pr view`; green requires an approved review of the unchanged diff and a matching PR head.

Natural implementation intent is enough to delegate work. There is no contract draft or second confirmation. Implementation covers an isolated branch, commits, normal push, and PR preparation; merge, deployment, production mutation, force-push, credentials, and destructive Linear operations remain separate boundaries.

Useful optional commands:

```text
/workers                         Show all durable worker states
/worker-message <id> <message>  Steer an existing worker without changing focus
/lead-doctor                     Check Git, Pi, cmux, caller IDs, and state path
```

The Lead also has `lead_workers`, `lead_message_worker`, `lead_update_worker`, and `lead_refresh_pr` tools. Lead messages use a shared inbox consumed by the live worker extension—not keystrokes sent blindly to a terminal. Workers report blockers, checks, handoffs, PR state, and review evidence with `lead_worker_report`. State and private review packets live under `~/.pi/lead-orchestration/` with private permissions. Successful worktrees and live sessions are not silently deleted.

For Linear, install and authenticate the companion package directly:

```bash
pi install npm:@alasano/pi-linear
```

Use `/linear-auth` and `/linear-settings`; never paste a credential into chat. V2 does not wrap routine Linear reads or administration in implementation contracts. Destructive Linear operations and agent-driven workspace switching remain blocked.

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
- Git and cmux with `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` in the Lead terminal
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

Run `npm test`, `npm run typecheck`, and `git diff --check` before publishing. The `/update` command refuses execution outside interactive TUI mode.

## Journey

Development notes and lessons are recorded in [`docs/journey.md`](docs/journey.md). They intentionally focus on Pi APIs and general engineering decisions rather than private projects.

## License

MIT — see [`LICENSE`](LICENSE).
