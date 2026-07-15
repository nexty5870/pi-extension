# Building with Pi.dev

This is a public engineering journal about extending Pi.dev while using it as a daily coding agent.

The notes deliberately exclude private repositories, client information, infrastructure, credentials, and session transcripts.

## Milestone 1 — self-update from the TUI

The first extension adds an `/update` command.

### Goal

Run Pi's supported self-update flow without leaving the current TUI, then continue in the same session using the updated runtime.

### First approach

The initial version:

1. Ran `pi update --self`
2. Verified the installed version
3. Displayed a success notification
4. Reloaded extensions
5. Replaced the current process with the updated CLI

The update worked, but the success notification was displayed immediately before process replacement. It disappeared with the old TUI, so the user could not confirm what version was running afterward.

### Improvement: post-restart confirmation

The updated implementation carries a one-time message into the replacement process through an environment variable.

When the new Pi runtime emits `session_start`, the extension:

1. Reads the update result
2. Deletes it from the process environment
3. Displays a notification
4. Shows the result in the status area for twelve seconds

This distinguishes three outcomes:

- Pi changed from one version to another
- Pi was already current
- A forced reinstall completed

### Why `ctx.reload()` is not enough

Pi's `ctx.reload()` refreshes extensions, skills, prompts, themes, context files, and session-bound extension state. It does not unload the already-running Pi core modules from Node.js memory.

A core update therefore needs a process restart.

### Why `process.execve()`

Spawning a detached replacement after the original Pi process exits can cause the parent shell to reclaim the terminal while the new TUI is starting. Both processes may then compete for terminal input.

`process.execve()` replaces the current process image while preserving its process ID. From the parent shell's perspective, Pi never exited; the updated TUI starts in the same terminal ownership chain.

### General lessons

- Separate extension reload from core runtime replacement
- Preserve session and working-directory state before reload
- Treat command contexts as stale after `ctx.reload()`
- Confirm successful operations after—not before—the UI restart
- Refuse self-update behavior in non-interactive modes
- Use Pi's official update command instead of duplicating package-manager logic

## Milestone 2 — V1 team orchestration foundation

The second extension keeps Pi's native sessions and cmux workspaces as the shell while adding local Feature/Bug contracts, explicit review, deterministic approval state, read-only scouts, and an overview.

Bootstrap review exposed three useful corrections:

- Linear should be optional; local-only approval must neither require a destination nor initialize an integration.
- Approval intent should normalize presentation differences while keeping vague acknowledgements behind a confirmation question.
- A companion extension can own authentication and API calls while orchestration owns a global `tool_call` policy boundary. `@alasano/pi-linear` now fills that role; its `/linear-auth` and `/linear-settings` controls remain operator-owned.

The generic MCP client remains useful for non-Linear servers and retains static-header support. The hosted Linear MCP API-key example was retired rather than migrating any private configuration.

### General lessons

- Native `/resume` is the right conversation continuity layer; orchestration state should complement it rather than replace it.
- Approval must be deterministic, but deterministic does not mean exact-string matching.
- Optional integrations need explicit `not-configured`, `pending`, and `persisted` states.
- Pi's global tool-call hook is the right place to prevent third-party tools from bypassing active-issue scoping.
- Credentials should stay with the operator-controlled companion and never flow through contract state.
- Independent per-event files remain easy to inspect and avoid concurrent append contention.

## Next experiments

Potential future work:

- A small update history entry in the session tree
- Cross-platform behavior validation
- A release/check command for this extension repository
- Additional safety-focused Pi extensions
