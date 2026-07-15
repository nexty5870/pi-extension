# Pi Extension

Small, practical extensions for [Pi.dev](https://pi.dev), built while using Pi as a daily coding agent.

The repository is intentionally public-safe: it does not contain credentials, session transcripts, client information, production configuration, or private project instructions.

## Included extensions

### Pi team orchestration (V1 foundation)

A global CTO/orchestration layer that keeps Pi's native sessions and cmux project workspaces intact.

Current foundation:

- Conversational Feature and Bug contract design with private local snapshots
- Optional Linear destinations; local-only contracts report **“GitHub/docs-only; no Linear mutation.”**
- Case- and punctuation-tolerant explicit approval, with confirmation for ambiguous acknowledgements
- [`@alasano/pi-linear`](https://pi.dev/packages/@alasano/pi-linear?name=linear) for Linear reads and approved contract persistence
- A generic, non-Linear MCP bridge with static headers and deny-by-default allowlists
- Read-only scouts, native session names, usage records, and `/team-overview`

Install the companion Linear package globally (unversioned so Pi can update it):

```bash
pi install npm:@alasano/pi-linear
```

Authenticate only through the operator-controlled `/linear-auth` command and configure tools through `/linear-settings`. Never paste an API key into chat, this repository, or orchestration MCP configuration. See the [package source and documentation](https://github.com/alasano/house-of-pi/tree/master/packages/pi-linear).

Design can use only `linear_list_*`, `linear_get_*`, and `linear_search_*`. Before writes, the agent resolves human team/project/status names to canonical values and uses the exact `teamId`, `teamKey`, `projectId`, or `stateId` required by pi-linear. Read-proven identifier normalization does not change approved scope or require contract reapproval. For issue creation, orchestration injects the exact approved title and managed contract section itself, so the model never has to reproduce hidden markers. Writes are read back for verification. After explicit approval, issue creation or update/comment operations are restricted to the configured active issue. Delete/archive operations, project or document mutations, workspace switching by the agent, and unknown `linear_*` tools are blocked.

Simple Linear tracking is separate from implementation contracts. Requests such as “open a bug in Linear”, “file this issue”, or “record this ticket” create the tracking issue directly after resolving canonical destination IDs; they do not draft a retrospective contract or ask for implementation approval. Failed API/schema attempts remain retryable, and approved pending creation survives `/reload`.

Approval follows clear operator intent rather than a magic phrase. “Approve, get it done”, “do it”, “ship it”, “go ahead”, and “mark it done” are accepted without asking the operator to repeat themselves. Only genuinely non-actionable acknowledgements such as a bare “ok” or “looks good” require clarification. A direct completion request—such as “mark it done”, “move it to Done”, or “update it since it’s already done”—resolves the team's completed status, updates only the active issue's workflow state, and reads the issue back before reporting success, without manufacturing an implementation contract. It still cannot target unrelated issues or authorize destructive operations.

Useful optional commands:

```text
/team-init                    Show detected Git/cmux project context
/team-contract show|open|reload
/team-feature [idea]          Prefill a design request
/team-scout [task]            Prefill a read-only scout request
/team-overview                Open the read-only overlay
/team-close                   Close local state only
```

Approved contracts with a `Delivery` section can enter the explicit delivery phase. Delivery metadata fixes the base branch, work branch, commit message, PR title/body, and argv-based checks into the approved hash.

```text
/team-delivery start          Start from a fresh matching approval
/team-delivery show           Inspect durable delivery state
/team-delivery resume         Reconcile and resume a retained run
/team-delivery abort          Stop workers and retain diagnostics
/team-delivery cleanup        Confirm deletion of failed/aborted private state only
```

Delivery requires a clean synchronized Git repository with `origin`, an authenticated GitHub CLI, a public repository, and caller-provided `CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID`. It creates one right-side Team pane and separate implementer/reviewer surfaces with focus disabled. Worker subprocesses run in an isolated worktree with a trusted path/tool guard; role logs and state stay private under `~/.pi/team-orchestration/`.

The controller permits one implementer and one independent reviewer, caps review at three passes, runs approved checks without a shell plus `git diff --check`, scans the publication diff, commits and pushes without force, reconciles one PR, observes bounded CI state, and stops. It never merges, deploys, deletes branches/remotes, or automatically removes a successful worktree. Failures retain state for `/team-delivery resume`; cleanup is explicit and never removes Git or cmux resources.

The compact footer preserves model, branch, and unrelated extension statuses while adding context level, initiative state, workers, and action count. `/team-overview` is live, scrollable, and includes worker/check/action state. Context colors change at 60% and 80%; no automatic compaction occurs.

#### Generic MCP configuration (non-Linear only)

The generic bridge remains available for other MCP servers. Copy [`examples/mcp.example.json`](examples/mcp.example.json) manually to `~/.pi/team-orchestration/mcp.json` if needed. Static headers remain supported. The extension never reads, prints, migrates, or rewrites credentials except to tighten that file's mode to `0600` when explicitly loaded. Linear servers are rejected; do not send a personal API key to `https://mcp.linear.app/mcp`.

See [`docs/orchestration-design.md`](docs/orchestration-design.md) for the design and roadmap.

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
- Node.js 22.15 or newer (`process.execve()` support)
- An installation that Pi can update with `pi update --self`
- Zed CLI (`zed`) only when using `/team-contract open`

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

Load the extension temporarily:

```bash
pi -e ./extensions/update.ts
```

Verify command registration through RPC without performing an update:

```bash
printf '{"id":"commands","type":"get_commands"}\n' |
  pi --mode rpc --no-session -e ./extensions/update.ts
```

The `/update` command refuses execution outside interactive TUI mode, so registration and safety behavior can be tested through RPC without modifying Pi.

## Journey

Development notes and lessons are recorded in [`docs/journey.md`](docs/journey.md). They intentionally focus on Pi APIs and general engineering decisions rather than private projects.

## License

MIT — see [`LICENSE`](LICENSE).
