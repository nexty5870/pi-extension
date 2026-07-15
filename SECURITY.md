# Security

This repository must not contain credentials, private session transcripts, client data, production configuration, or private repository context.

## Reporting a vulnerability

Please use GitHub's private security advisory feature for this repository. Do not include active credentials or sensitive session data in a public issue.

## Extension permissions

Pi extensions execute with the permissions of the local user running Pi. Review extension source before installation and use operating-system or container isolation for untrusted work.

## Orchestration credentials

Linear authentication is owned by [`@alasano/pi-linear`](https://github.com/alasano/house-of-pi/tree/master/packages/pi-linear). Operators must use `/linear-auth`; the orchestration extension does not copy, print, migrate, or accept Linear credentials. `/linear-settings` and workspace selection also remain operator-controlled. Do not configure a personal key against the hosted Linear MCP endpoint.

The optional `~/.pi/team-orchestration/mcp.json` is only for non-Linear MCP servers. Keep private static headers there with `0600` permissions and never commit the file. Existing files are not exposed or migrated automatically.

All `linear_*` tool calls are intercepted regardless of which third-party extension registered them. Reads are limited by prefix; approved writes are active-issue scoped; destructive, workspace-switching, unrelated resource mutations, and unknown tools are blocked.
