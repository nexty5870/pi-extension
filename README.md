# Pi Extension

Small, practical extensions for [Pi.dev](https://pi.dev), built while using Pi as a daily coding agent.

The repository is intentionally public-safe: it does not contain credentials, session transcripts, client information, production configuration, or private project instructions.

## Included extensions

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
