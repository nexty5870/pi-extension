# Security

This repository must not contain credentials, private session transcripts, client data, production configuration, or private repository context.

## Reporting a vulnerability

Use GitHub's private security advisory feature. Do not include active credentials or sensitive session data in a public issue.

## Extension permissions

Pi extensions and visible workers execute with the local operator's permissions. Review extension source before installation and use containers or operating-system isolation for untrusted repositories. V2 is a coordination boundary, not a sandbox.

## Lead + worker boundaries

The active package loads `extensions/lead/index.ts`. It does not globally disable Pi's normal read/edit/write/bash tools and does not require contracts. Implementation intent permits an isolated worktree/branch, project changes, validation, commits, normal push, and PR preparation.

A narrow tool hook protects separate boundaries:

- force-push is always blocked;
- merge, deployment, production/cloud mutation, and destructive commands require an interactive one-command confirmation;
- destructive Linear operations and workspace switching are blocked;
- known credential stores, private keys, service-account files, and real `.env` files are blocked;
- research and review workers are read-only at the Pi tool layer, with obvious mutating shell commands blocked as defense in depth.

Generated worker commands use argv execution except for a private mode-`0700` launch script sent to a known cmux terminal. Values in that script are single-quote escaped. No credential is copied into the script; the interactive Pi process resolves its own configured authentication.

cmux actions target the caller's explicit workspace, create with `--focus false`, and never call `select-workspace`, `focus-pane`, or `focus-panel`. Workers are live Pi TUIs rather than hidden subprocesses. Worktrees and sessions are retained for operator inspection and are never silently deleted.

Private task state, assignment prompts, launch scripts, and review packets live under `~/.pi/lead-orchestration/`. Directories use mode `0700`; files use mode `0600` (launch scripts `0700`); writes are atomic.

## Linear

Linear authentication belongs to [`@alasano/pi-linear`](https://github.com/alasano/house-of-pi/tree/master/packages/pi-linear). Operators use `/linear-auth` and `/linear-settings`; this repository does not read, copy, print, or migrate Linear credentials. Do not send a personal key to a generic hosted MCP endpoint.

Routine Linear reads and administration do not require implementation contracts. An explicit `linearIssue` binding on an implementation task may authorize only a Lead-side transition of that exact issue to a read-proven team state of type `started`: the Lead resolves canonical IDs with pi-linear, writes only `stateId`, and requires issue readback. Worker sessions cannot mutate Linear. Missing auth/tools never block worker startup. Destructive tools and agent-driven workspace switching remain blocked by V2.

## Legacy code

`extensions/orchestration/` is retained only for migration history and regression tests. It is not listed in the Pi package manifest and is not activated by `/reload`.
