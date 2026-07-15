# Security

This repository must not contain credentials, private session transcripts, client data, production configuration, or private repository context.

## Reporting a vulnerability

Please use GitHub's private security advisory feature for this repository. Do not include active credentials or sensitive session data in a public issue.

## Extension permissions

Pi extensions execute with the permissions of the local user running Pi. Review extension source before installation and use operating-system or container isolation for untrusted work.

## Orchestration credentials

Linear authentication is owned by [`@alasano/pi-linear`](https://github.com/alasano/house-of-pi/tree/master/packages/pi-linear). Operators must use `/linear-auth`; the orchestration extension does not copy, print, migrate, or accept Linear credentials. `/linear-settings` and workspace selection also remain operator-controlled. Do not configure a personal key against the hosted Linear MCP endpoint.

The optional `~/.pi/team-orchestration/mcp.json` is only for non-Linear MCP servers. Keep private static headers there with `0600` permissions and never commit the file. Existing files are not exposed or migrated automatically.

All `linear_*` tool calls are intercepted regardless of which third-party extension registered them. Reads are limited by prefix; approved writes are active-issue scoped; destructive, workspace-switching, unrelated resource mutations, and unknown tools are blocked. Approved issue creation is normalized in the tool hook: unapproved proposed fields are removed, canonical destination IDs are retained, and the approved title/managed description are injected by orchestration. A direct operator instruction to mark the active issue done grants only a one-turn `stateId` update using a completed status discovered for that team; it does not authorize unrelated fields or issues.

## Delivery workers and publication

Delivery workers run with extension/skill discovery disabled and a trusted guard loaded explicitly. The guard confines file tools to the canonical worktree, validates symlinks, denies sensitive filenames, strips Linear credentials, blocks Linear/MCP access, prevents worker push/merge/deploy commands, and makes reviewers read-only. Private prompts, logs, reviews, checks, and state use `0600` files outside the repository.

Before publication, the controller checks public GitHub visibility and scans changed files for sensitive names, credential patterns, private absolute paths, file-count limits, and file-size limits. Git and GitHub operations use argv execution without a shell, never force-push, and never invoke merge, deployment, branch deletion, remote deletion, or automatic successful-worktree cleanup. cmux operations target the caller workspace and use focus-disabled creation; surfaces are display-only rather than an orchestration control protocol.
