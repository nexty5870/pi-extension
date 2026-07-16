---
name: team-orchestration
description: CTO-led design orchestration for features and bugs using local contracts and optional Linear persistence.
---

# Team Orchestration

Treat the current Git repository and caller cmux workspace as the project. Keep Pi's native sessions and never change cmux focus automatically.

## Intent routing

- **Load/show/inspect/summarize a Linear issue:** read and respond directly. Never create a contract.
- **Plan/discuss:** stay conversational and ask only genuinely missing decisions.
- **Implement/build/fix/work on:** this is authorization for isolated worktree and PR preparation. Create the complete work order internally, allow orchestration to auto-approve it, persist required Linear metadata, and call `team_delivery_start` without another confirmation.
- **Review the contract:** only enter manual review when the operator explicitly requests it.

## Design mode

1. Understand the request conversationally and ask one meaningful decision question at a time.
2. Inspect the repository read-only. For Linear, use only `linear_list_*`, `linear_get_*`, and `linear_search_*` tools from `@alasano/pi-linear`.
3. Use `team_scout` for isolated repository research when useful.
4. Keep drafts local. Do not mutate Linear, project code, branches, commits, PRs, merges, or deployments.
5. A Linear team or issue is optional; do not invent one for GitHub/docs-only work.

## Direct Linear tracking

When the operator asks to open, file, log, add, or record a Linear bug, issue, or ticket, treat that as an administrative tracking request—not implementation design. Do not create a retrospective contract, call `team_contract_approve`, mention an implementation approval phrase, or ask for approval again. Gather only missing issue content or destination details, resolve canonical IDs with read tools, call `linear_create_issue`, and read the issue back. If the API/schema call fails, correct and retry; authorization is consumed only after successful creation. If an approved pending contract already exists, its creation authorization remains valid across failed calls and `/reload`.

## Direct Linear administration

Explicit operator requests to update priority, labels, assignment, scheduling, or dependencies/relations on named issues are administrative actions, not implementation contracts. Use the issue identifiers in the operator's request or immediately preceding proposal as the exact authorization scope. Resolve canonical issue/resource IDs with reads, perform only the requested `linear_update_issue` and `linear_create_issue_relation` operations, read results back, and stop. Never demand contract approval or tell the operator to apply these changes manually.

## Linear plan publication

When the operator explicitly asks to publish, translate, sync, put, or move a completed plan into Linear, that instruction authorizes materialization without another contract or implementation phrase. Never call generic `mcp_*` tools. Use pi-linear reads to resolve teams and check projects. If the project does not exist, call `linear_save_project` in create mode only (omit `projectId`) with the planned name/content and read-proven `teamIds`. Create the plan's issues only in the returned project ID, read back the project and issues, summarize identifiers/URLs, and stop. Correct and retry failed calls without reapproval. Publication intent is restored from session history across `/reload`; a later “retry” continues it until the operator explicitly cancels. Do not implement, merge, or deploy.

## Optional review and approval

Call `team_contract_draft` only with a complete Feature or Bug work order. For an explicit implementation directive it is internal and auto-approved: do not dump its Markdown or pause. Show full Markdown only when the operator requested review. `/team-contract open` is an optional explicit Zed review action; never open or focus Zed automatically.

For a review-first contract, call `team_contract_approve` whenever the operator clearly accepts or directs action. Do not require them to mention both the contract and implementation, and never make them repeat clear intent. `team_contract_approve` is an agent tool; `/team-contract approve` is not a valid command and must never be suggested. Examples include:

- “Approve, get it done”
- “do it”
- “ship it”
- “go ahead”
- “mark it done”
- “confirm, let's proceed”

Only a genuinely non-actionable acknowledgement such as a bare “ok” or “looks good” is ambiguous. Ask once in that case. Unconsumed explicit approval remains valid through a retry or `/reload`; do not ask the operator to repeat it. A direct request to mark an existing active issue done is an operator workflow instruction, not a reason to invent a retrospective implementation contract. Resolve the team's completed status, update only the active issue's `stateId`, read the issue back, and report success only after the completed status is confirmed.

Authorization is stored locally first. If no Linear destination is configured, report exactly: **GitHub/docs-only; no Linear mutation.** If a destination is configured, use the exact pi-linear persistence plan returned by either auto-approved `team_contract_draft` or `team_contract_approve`.

## Linear safety

- Install with `pi install npm:@alasano/pi-linear`; do not implement authentication.
- `/linear-auth`, `/linear-settings`, and workspace selection are operator-controlled.
- Before every write, inspect the pi-linear tool schema and resolve human team/project/status names with the relevant `linear_list_*` or `linear_get_*` tool. Use canonical values in `teamId`, `teamKey`, `projectId`, `stateId`, and similar ID fields; never put a display name into an ID field.
- A read-proven name/key-to-ID substitution preserves the approved destination scope. Do not revise the contract, increment its version, or ask for reapproval solely to normalize identifiers.
- For approved issue creation, supply canonical destination identifiers and let orchestration inject the exact approved title and managed description. Never reconstruct hidden markers or request reapproval for persistence formatting.
- After every write, call `linear_get_issue` and report success only when the requested destination/content/status is confirmed.
- A direct operator tracking request may call `linear_create_issue` without an implementation contract; fields are restricted and destination IDs must be read-proven.
- Explicit administration may update supported fields or create relations only for issues named by the operator; both relation endpoints must be in that set.
- Explicit plan publication may create one project and up to 50 scoped issues in the same turn. Existing project updates and all destructive project operations remain blocked.
- Approved planned issue creation remains authorized durably until successful persistence, including across failed calls and `/reload`; update/comment operations remain scoped to the active issue.
- Never delete, archive, mutate unrelated projects/documents, switch workspaces, or use unknown `linear_*` tools.
- Never expose credentials or route Linear through generic MCP.

## Delivery

An internally authorized work order with complete delivery metadata starts through `team_delivery_start` when the operator clearly directs implementation; do not make them run a slash command after they already said to proceed. `/team-delivery start` remains an optional operator shortcut and idempotently resumes a failed run for the same approval. Confirm that the current contract hash still matches approval, optional Linear persistence is complete, and the Git/GitHub/cmux preflight succeeds. Delivery uses freshly fetched `origin/<approved-base>` in its isolated worktree; do not block on or mutate a dirty/behind caller checkout. Delivery prepares dependencies with a lockfile-compatible pinned Corepack pnpm. On new runs it records checks on the untouched base, then uses one isolated implementer and one independent reviewer. New check regressions trigger bounded automatic repair/re-review; base-red or environment-blocked checks are reported as validation warnings and do not discard reviewed work. A retry continues a still-matching reviewed diff instead of rerunning completed passes.

Use `/team-delivery show` for inspection, `resume` for idempotent reconciliation, `abort` to stop and retain diagnostics, and explicitly confirmed `cleanup` only for failed/aborted private state. Never infer permission to merge, deploy, mutate production, or perform destructive actions from work-order authorization.

Delivery may create a worktree/branch, commit, push normally, and open or reconcile the approved GitHub PR. It must stop before merge or deployment. Never force-push, delete branches/remotes, remove a successful worktree automatically, mutate Linear from a worker, or change/focus the operator's cmux workspace.
