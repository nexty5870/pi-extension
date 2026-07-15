---
name: team-orchestration
description: CTO-led design orchestration for features and bugs using local contracts and optional Linear persistence.
---

# Team Orchestration

Treat the current Git repository and caller cmux workspace as the project. Keep Pi's native sessions and never change cmux focus automatically.

## Design mode

1. Understand the request conversationally and ask one meaningful decision question at a time.
2. Inspect the repository read-only. For Linear, use only `linear_list_*`, `linear_get_*`, and `linear_search_*` tools from `@alasano/pi-linear`.
3. Use `team_scout` for isolated repository research when useful.
4. Keep drafts local. Do not mutate Linear, project code, branches, commits, PRs, merges, or deployments.
5. A Linear team or issue is optional; do not invent one for GitHub/docs-only work.

## Review and approval

Call `team_contract_draft` only with a complete Feature or Bug contract. Show its full Markdown. `/team-contract open` is an optional explicit Zed review action; never open or focus Zed automatically.

After a review-ready contract, call `team_contract_approve` whenever the operator clearly accepts or directs action. Do not require them to mention both the contract and implementation, and never make them repeat clear intent. Examples include:

- “Approve, get it done”
- “do it”
- “ship it”
- “go ahead”
- “mark it done”

Only a genuinely non-actionable acknowledgement such as a bare “ok” or “looks good” is ambiguous. Ask once in that case. A direct request to mark an existing active issue done is an operator workflow instruction, not a reason to invent a retrospective implementation contract. Resolve the team's completed status, update only the active issue's `stateId`, read the issue back, and report success only after the completed status is confirmed.

Approval is stored locally first. If no Linear destination is configured, report exactly: **GitHub/docs-only; no Linear mutation.** If a destination is configured, use the exact pi-linear persistence plan returned by `team_contract_approve`.

## Linear safety

- Install with `pi install npm:@alasano/pi-linear`; do not implement authentication.
- `/linear-auth`, `/linear-settings`, and workspace selection are operator-controlled.
- After approval, only `linear_create_issue` for the planned destination and update/comment operations scoped to the active issue are permitted.
- Never delete, archive, mutate unrelated projects/documents, switch workspaces, or use unknown `linear_*` tools.
- Never expose credentials or route Linear through generic MCP.

## Delivery

A freshly approved contract with complete delivery metadata may start only through explicit `/team-delivery start`. Confirm that the current contract hash still matches approval, optional Linear persistence is complete, and the Git/GitHub/cmux preflight is clean. Delivery uses one isolated implementer, one independent reviewer, at most three review passes, approved argv checks, publication scanning, and durable recovery.

Use `/team-delivery show` for inspection, `resume` for idempotent reconciliation, `abort` to stop and retain diagnostics, and explicitly confirmed `cleanup` only for failed/aborted private state. Never infer permission to start delivery from contract approval alone.

Delivery may create a worktree/branch, commit, push normally, and open or reconcile the approved GitHub PR. It must stop before merge or deployment. Never force-push, delete branches/remotes, remove a successful worktree automatically, mutate Linear from a worker, or change/focus the operator's cmux workspace.
