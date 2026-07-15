# Team orchestration V1 design

## Purpose

The extension adds a deterministic contract-review boundary to Pi while retaining native sessions, Git repositories, and cmux workspaces. V1 designs and approves work; it does not run delivery workers or mutate project code.

## Principles

1. Conversation is the primary interface; `/team-*` commands are optional affordances.
2. Drafts stay local under `~/.pi/team-orchestration/` and in Pi session state.
3. Linear is optional. GitHub/documentation-only contracts are first-class.
4. Approval is deterministic but does not depend on capitalization or terminal punctuation.
5. Linear authentication and settings belong to the companion package, not this repository.
6. Every Linear tool call is intercepted, including tools registered by third-party extensions.
7. Generic MCP remains available only for non-Linear servers.

## Installation and ownership

Install the companion globally without a version pin:

```bash
pi install npm:@alasano/pi-linear
```

References:

- [pi package page](https://pi.dev/packages/@alasano/pi-linear?name=linear)
- [source and package documentation](https://github.com/alasano/house-of-pi/tree/master/packages/pi-linear)

Operators add credentials with `/linear-auth` and choose exposed tools with `/linear-settings`. Those commands, auth preference, and workspace selection are operator-controlled. The orchestration extension does not implement OAuth or API-key storage and never reads, copies, prints, or migrates existing credentials.

## Contract model

Feature contracts capture outcome, context, scope, acceptance criteria, constraints, dependencies, validation, rollout, and documentation. Bug contracts capture impact, environment, reproduction, expected/actual behavior, evidence, frequency, triggers, workaround, suspected area, acceptance criteria, and regression tests.

A contract's Linear destination is optional:

```ts
interface LinearDestination {
  team?: string;
  project?: string;
  issueId?: string;
  issueIdentifier?: string;
}
```

With neither a team nor issue, validation succeeds and rendering says:

> GitHub/docs-only; no Linear mutation.

A team means approval may create an issue. An issue ID or identifier means approval may update that issue. Drafting and reloading Markdown never contact Linear.

## Review and approval

`team_contract_draft` validates a complete draft, renders all Markdown in Pi, writes a private snapshot, and enters `review`. Zed opens only after explicit `/team-contract open`; `/team-contract reload` reparses and validates operator edits.

The input hook normalizes Unicode, case, surrounding whitespace, and punctuation. These are explicit approvals after a review-ready contract:

- `Approve contract and start implementation`
- `approved, implement`
- `go ahead and implement`

Vague acknowledgements such as `ok`, `looks good`, or `go ahead` are not approval. The model is instructed to ask for confirmation rather than block on a magic phrase.

`team_contract_approve` consumes a single-use in-memory capability. It reloads the local Markdown, validates it again, and stores a local approval record before any optional integration call. Local-only approval does not initialize MCP or call Linear.

Approval records distinguish:

- `not-configured`: GitHub/docs-only; no Linear mutation
- `pending`: a pi-linear persistence plan was returned
- `persisted`: the companion tool completed successfully

## Optional Linear persistence

For a configured destination, the approval result provides an exact tool name and arguments:

- `linear_create_issue` with the approved title, managed contract body, and configured team; or
- `linear_update_issue` with the active issue and managed contract body.

Successful tool results update local approval state to `persisted`. The managed body is delimited by `<!-- pi-contract:start -->` and `<!-- pi-contract:end -->`. Operators can inspect the target issue before update when preservation of unrelated description text is needed.

V1 does not invoke a private API client. pi-linear owns credential resolution and API communication.

## Linear policy boundary

The extension uses Pi's global `tool_call` interception, so a third-party `linear_*` registration cannot bypass policy.

### Design and review

Only these prefixes are allowed:

- `linear_list_*`
- `linear_get_*`
- `linear_search_*`

### Approved persistence

The following writes can be authorized:

- `linear_create_issue`, once, for the configured team and managed approved body
- `linear_update_issue`, scoped to the active issue
- `linear_create_comment`, scoped to the active issue
- `linear_update_comment` only when its arguments include the active issue binding

### Always blocked

- delete, archive, unarchive, and other destructive tools
- project, document, initiative, relation, label, or other unrelated mutations
- `linear_switch_workspace` by the agent
- unknown `linear_*` tools
- writes without an approved Linear-bound contract
- writes to any issue other than the active issue

`/linear-auth`, `/linear-settings`, and workspace changes remain operator actions. Deny-by-default behavior is intentional even when pi-linear adds new tools.

## Generic MCP bridge

`~/.pi/team-orchestration/mcp.json` remains an optional private configuration for non-Linear MCP servers. HTTP static headers and stdio environment variables are supported. Each server requires read/write/destructive allowlists, and unknown tools are denied.

Linear-named servers, Linear-specific config, and `linear_*` routes are rejected. The extension does not enumerate or migrate an existing private file automatically. Loading an explicitly configured file tightens its mode to `0600` but never prints header values.

The retired hosted-MCP pattern that sent a personal API key to `https://mcp.linear.app/mcp` must not be used.

## Local state and UI

State is partitioned by stable Git-root project ID and initiative ID. Atomic files avoid shared append contention. Pi session entries restore the active initiative through `/resume`. Usage records contain token/cost metadata, not prompts or credentials.

`/team-overview` is a read-only overlay. `/team-close` changes local state only and never contacts Linear.

## V1 safety boundaries

While an initiative is active, the CTO session blocks project `write`, `edit`, and shell mutation. Read-only scouts run in isolated Pi subprocesses. V1 does not create branches, worktrees, commits, PRs, merges, or deployments.

## Configuration example

[`../examples/mcp.example.json`](../examples/mcp.example.json) is intentionally neutral and non-Linear. Copy it manually only when a generic MCP server is needed. Never commit the private copy.

## Classic TODO

- [ ] Delivery-worker phase: after a fresh approved execution handoff, add isolated worktrees, worker/reviewer loops, commits, GitHub PR creation, check monitoring, and operator-controlled merge/deploy. Keep workers unable to mutate Linear directly.

## Acceptance checks

- Local-only Feature and Bug contracts validate.
- Local-only approval stores state and performs no network/integration call.
- Explicit approval tolerates case and punctuation; vague acknowledgements require confirmation.
- Configured Linear destinations produce create/update plans and persist result metadata.
- pi-linear reads, writes, destructive tools, workspace switching, and unknown tools classify correctly.
- Third-party `linear_*` tools pass through the same interception boundary.
- Generic MCP static headers still reach its HTTP transport while Linear MCP routes are rejected.
- `npm test`, `npm run typecheck`, and `git diff --check` pass.
