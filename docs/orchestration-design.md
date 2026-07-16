# Team orchestration V1 design

## Purpose

The extension adds deterministic contract review and a bounded delivery state machine to Pi while retaining native sessions, Git repositories, and caller-owned cmux workspaces. Delivery remains explicit and always stops before merge or deployment.

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

## Direct Linear tracking and administration

Routine Linear administration is not governed by implementation contracts. An explicit operator request may update priority, labels, assignment, scheduling, project/parent/cycle references, or create `blocks`/`duplicate`/`related`/`similar` relations for issues named in the request or immediately preceding assistant proposal. The extension extracts that finite issue set; update targets and both relation endpoints must resolve to it. Unsupported fields, unnamed issues, relation mutation/deletion, project mutation, and destructive operations remain blocked. Results are read back and the operator is never told to perform authorized changes manually.

Tracking administration is intentionally separate from implementation contracts. A direct operator request to open, create, file, log, add, or record a Linear bug/issue/ticket grants a one-turn issue-creation capability without drafting or approving a contract. The agent gathers only missing tracking details, resolves canonical destination IDs with read tools, creates the issue with restricted fields, and reads it back.

Creation authorization is consumed only after a successful result containing an issue ID/identifier. Schema/API failures remain retryable during the turn. Approved contract persistence uses durable `approved.linearPersistence === "pending"` state rather than an in-memory bit, so failed calls and `/reload` do not require reapproval. A single in-flight guard prevents parallel duplicate creation.

An explicit request to publish/translate/sync a completed plan to Linear grants a bounded publication capability. The agent uses pi-linear—not generic MCP—to resolve teams and existing projects. It may create one project with `linear_save_project` only when `projectId`/`id` are omitted, then create at most 50 issues scoped to the returned project ID. Existing project updates, unrelated project IDs, destructive operations, implementation, merge, and deployment remain blocked. Failures are retryable and all created resources are read back. Publication intent is reconstructed from user messages on session start/tree restoration and remains armed across agent settlement; “retry” therefore works after `/reload` without repeating the original request. An explicit cancel/stop publication instruction clears it.

## Review and approval

`team_contract_draft` validates a complete draft, renders all Markdown in Pi, writes a private snapshot, and enters `review`. Zed opens only after explicit `/team-contract open`; `/team-contract reload` reparses and validates operator edits.

The input hook normalizes Unicode, case, surrounding whitespace, and punctuation, then recognizes clear acceptance or action intent. `Approve, get it done`, `approved`, `do it`, `ship it`, `go ahead`, `proceed`, and `mark it done` cross the approval gate after a review-ready contract. The operator does not need to separately mention implementation or repeat prescribed wording.

Only genuinely non-actionable acknowledgements such as a bare `ok` or `looks good` remain ambiguous. Negated instructions and deliberative questions such as `should we?` do not approve; direct requests such as `can you mark it done?` do. A direct completion instruction creates a one-turn capability for workflow fields on the exact active Linear issue. The requested `stateId` must come from a completed team status discovered in that turn, and the issue is read back before success is reported. Unrelated fields, issues, creation, destructive tools, and workspace changes remain blocked.

`team_contract_approve` consumes a single-use in-memory capability. It reloads the local Markdown, validates it again, and stores a local approval record before any optional integration call. Local-only approval does not initialize MCP or call Linear.

Approval records distinguish:

- `not-configured`: GitHub/docs-only; no Linear mutation
- `pending`: a pi-linear persistence plan was returned
- `persisted`: the companion tool completed successfully

## Optional Linear persistence

For a configured destination, the approval result provides a tool name, approved title/body, and destination scope:

- `linear_create_issue` with the approved title, managed contract body, and configured team; or
- `linear_update_issue` with the active issue and managed contract body.

Human destination names are not copied blindly into ID fields. Immediately before writing, the agent uses pi-linear list/get tools to resolve canonical `teamId`, `teamKey`, `projectId`, `stateId`, or other schema-specific references. The policy records name/key/ID aliases from those read results and accepts a canonical substitution only when both representations resolve to the same resource. This operational normalization does not alter approved scope, contract hash, or version and therefore does not require reapproval.

For issue creation, the model proposes only canonical destination identifiers. The `tool_call` hook removes unapproved fields and injects the exact approved title plus the machine-managed description generated from the approved contract. Hidden marker formatting is therefore an orchestration responsibility rather than a model retry/reapproval requirement. Every write is followed by an issue readback.

Successful persistence tool results update local approval state to `persisted`; the agent still performs readback before reporting success to the operator. The managed body is delimited by `<!-- pi-contract:start -->` and `<!-- pi-contract:end -->`. Operators can inspect the target issue before update when preservation of unrelated description text is needed.

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

## Delivery-worker milestone

Deliverable contracts add hash-covered metadata for the base branch, work branch, commit message, PR title/body, and validation argv arrays. `/team-delivery start` requires a current approval hash, completed optional Linear persistence, a clean synchronized base, a public GitHub repository, and authoritative caller cmux IDs.

The durable phases are preflight, worktree creation, implementation, review, checks, commit, push, PR reconciliation, bounded CI observation, and operator action. State, logs, prompts, reviews, checks, and usage are atomically stored with `0600` permissions under an initiative-specific delivery run. Exclusive locks prevent concurrent execution. Resume reconciles immutable base/worktree/commit/push/PR identities and fails closed on mismatches.

One implementer and one reviewer run as isolated Pi JSON subprocesses. Discovered extensions and skills are disabled; repository context remains trusted; an explicitly loaded guard confines paths and symlinks, denies sensitive files, strips Linear access, prevents publication/deployment commands, and makes the reviewer read-only. Reviewer output is strict JSON bound to the exact diff hash. Three requested-change passes exhaust the run.

Approved checks execute as argv without a shell, followed by `git diff --check`. A check-mutated diff requires another independent review. The final reviewed hash must equal the publication diff. A public-safety scan checks changed paths and content before staging.

Git publication never force-pushes. GitHub publication requires public visibility, reconciles at most one exact PR, observes CI to a bounded terminal state, and stops with an operator action. Merge, deployment, branch/remote deletion, and automatic successful-worktree removal do not exist in the controller.

cmux topology is one right-side Team pane with implementer/reviewer terminal surfaces created using the exact caller workspace and `--focus false`. State remains the control protocol; cmux only displays/coalesces status, progress, and flashes.

The shared UI snapshot powers a compact footer and scrollable overview. Context is normal below 60%, warning from 60–79%, and critical from 80%; compaction is never automatic. Model, Git branch, and unrelated extension statuses remain visible.

The CTO design session itself still blocks project mutation. Read-only scouts remain isolated. Delivery mutation occurs only in the controller-created worktree after explicit start.

## Configuration example

[`../examples/mcp.example.json`](../examples/mcp.example.json) is intentionally neutral and non-Linear. Copy it manually only when a generic MCP server is needed. Never commit the private copy.

## Classic TODO

- [ ] Dogfood delivery end-to-end on a disposable public fixture in cmux, including an actual test PR and visual focus-theft verification, before enabling it on any sensitive repository.
- [ ] Add opt-in handling for post-publication CI failures; keep every code change behind a new review/check cycle.
- [ ] Consider parallel/distributed workers only after the single implementer/reviewer state machine has production evidence.
- [ ] Keep merge, deploy, and destructive cleanup operator-controlled.

## Acceptance checks

- Local-only Feature and Bug contracts validate.
- Local-only approval stores state and performs no network/integration call.
- Clear acceptance/action intent works without prescribed wording; bare acknowledgements, deliberative questions, and negation do not approve.
- Direct completion instructions can update only workflow fields on the exact active issue without retrospective contract ceremony.
- Explicit updates/relations are scoped to operator-named issues and require no implementation contract.
- Direct tracking requests create restricted Linear issues without implementation contracts or approval ceremony.
- Explicit plan publication can create one project plus bounded scoped issues without generic MCP or implementation approval.
- Configured Linear destinations produce create/update plans, retain pending authorization across failure/reload, and persist result metadata.
- pi-linear reads, writes, destructive tools, workspace switching, and unknown tools classify correctly.
- Third-party `linear_*` tools pass through the same interception boundary.
- Generic MCP static headers still reach its HTTP transport while Linear MCP routes are rejected.
- Delivery metadata validates, round-trips, and participates in contract hashing.
- Faked controller paths cover success, requested changes, exhaustion, check failure/mutation, drift, and publication reconciliation without live services.
- Temporary Git fixtures cover clean-base/worktree/collision gates; guard, reviewer, scanner, cmux, GitHub, JSONL, cancellation, and responsive UI policies have regressions.
- `npm test`, `npm run typecheck`, and `git diff --check` pass.
