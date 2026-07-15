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

After a review-ready contract, call `team_contract_approve` only when the operator clearly approves both the contract and implementation. Matching is case- and punctuation-tolerant. Examples include:

- “Approve contract and start implementation”
- “approved, implement”
- “go ahead and implement”

“ok”, “looks good”, and similar acknowledgements are ambiguous. Ask for confirmation instead of treating them as approval or demanding a magic phrase.

Approval is stored locally first. If no Linear destination is configured, report exactly: **GitHub/docs-only; no Linear mutation.** If a destination is configured, use the exact pi-linear persistence plan returned by `team_contract_approve`.

## Linear safety

- Install with `pi install npm:@alasano/pi-linear`; do not implement authentication.
- `/linear-auth`, `/linear-settings`, and workspace selection are operator-controlled.
- After approval, only `linear_create_issue` for the planned destination and update/comment operations scoped to the active issue are permitted.
- Never delete, archive, mutate unrelated projects/documents, switch workspaces, or use unknown `linear_*` tools.
- Never expose credentials or route Linear through generic MCP.

V1 stops after optional contract persistence. Delivery workers, worktrees, commits, PRs, review loops, merge, and deployment remain a later phase.
