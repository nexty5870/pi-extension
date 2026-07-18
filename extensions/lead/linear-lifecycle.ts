import type { LinearLifecycleState, TaskRecord } from "./types.ts";

export const LINEAR_START_TOOLS = [
  "linear_get_issue",
  "linear_list_issue_statuses",
  "linear_update_issue",
] as const;

export interface LinearIssueSnapshot {
  id?: string;
  identifier: string;
  state?: { id?: string; name?: string; type?: string };
  team?: { id?: string; key?: string; name?: string };
}

export interface LinearWorkflowStateSnapshot {
  id: string;
  name: string;
  type?: string;
  position?: number;
  team?: { id?: string; key?: string; name?: string };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeLinearIssueReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })();
  const urlMatch = decoded.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$|[?#])/i);
  const directMatch = decoded.trim().match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/i);
  const match = urlMatch?.[1] ?? directMatch?.[1];
  return match?.toUpperCase();
}

export function isStartedLinearState(state: LinearIssueSnapshot["state"]): boolean {
  return state?.type?.trim().toLowerCase() === "started";
}

function resultPayload(details: unknown, content: unknown): Record<string, unknown> | undefined {
  const detailObject = object(details);
  if (detailObject) return detailObject;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => object(part))
    .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text")
    .map((part) => string(part.text) ?? "")
    .join("\n");
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

export function parseLinearIssueSnapshot(details: unknown, content: unknown): LinearIssueSnapshot | undefined {
  const issue = object(resultPayload(details, content)?.issue);
  const identifier = string(issue?.identifier)?.toUpperCase();
  if (!issue || !identifier) return undefined;
  const rawState = object(issue.state);
  const rawTeam = object(issue.team);
  return {
    id: string(issue.id),
    identifier,
    state: rawState ? {
      id: string(rawState.id),
      name: string(rawState.name),
      type: string(rawState.type),
    } : undefined,
    team: rawTeam ? {
      id: string(rawTeam.id),
      key: string(rawTeam.key),
      name: string(rawTeam.name),
    } : undefined,
  };
}

export function linearStatusFilterTeamId(input: unknown): string | undefined {
  const root = object(input);
  const filter = object(root?.filter);
  const team = object(filter?.team);
  const id = object(team?.id);
  if (!root || !filter || !team || !id
    || Object.keys(root).length !== 1
    || Object.keys(filter).length !== 1
    || Object.keys(team).length !== 1
    || Object.keys(id).length !== 1) return undefined;
  return string(id.eq);
}

export function parseLinearWorkflowStates(details: unknown, content: unknown): LinearWorkflowStateSnapshot[] {
  const rawStates = resultPayload(details, content)?.states;
  if (!Array.isArray(rawStates)) return [];
  return rawStates.flatMap((value) => {
    const state = object(value);
    const id = string(state?.id);
    const name = string(state?.name);
    if (!state || !id || !name) return [];
    const rawTeam = object(state.team);
    return [{
      id,
      name,
      type: string(state.type),
      position: typeof state.position === "number" ? state.position : undefined,
      team: rawTeam ? {
        id: string(rawTeam.id),
        key: string(rawTeam.key),
        name: string(rawTeam.name),
      } : undefined,
    }];
  });
}

export function selectLinearStartedState(
  states: LinearWorkflowStateSnapshot[],
  teamId: string,
): LinearWorkflowStateSnapshot | undefined {
  const started = states
    .filter((state) => state.team?.id === teamId && state.type?.trim().toLowerCase() === "started")
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER));
  return started.find((state) => state.name.trim().toLowerCase() === "in progress")
    ?? (started.length === 1 ? started[0] : undefined);
}

export function linearLifecycleAfterStatuses(
  current: LinearLifecycleState,
  states: LinearWorkflowStateSnapshot[],
  statusesObservedAt = Date.now(),
): LinearLifecycleState {
  const now = new Date(statusesObservedAt).toISOString();
  const issueObserved = Date.parse(current.issueObservedAt ?? "");
  if (!current.teamId || !Number.isFinite(issueObserved)
    || statusesObservedAt < issueObserved
    || statusesObservedAt - issueObserved >= 5 * 60_000) {
    return { ...current, lastError: "Read the Linear issue and canonical team before resolving In Progress", updatedAt: now };
  }
  const candidate = selectLinearStartedState(states, current.teamId);
  if (!candidate) {
    return {
      ...current,
      candidateStateId: undefined,
      candidateStateName: undefined,
      candidateTeamId: undefined,
      candidateObservedAt: undefined,
      lastError: "No unambiguous In Progress workflow state was returned for the issue team",
      updatedAt: now,
    };
  }
  return {
    ...current,
    candidateStateId: candidate.id,
    candidateStateName: candidate.name,
    candidateTeamId: current.teamId,
    candidateObservedAt: now,
    lastError: undefined,
    updatedAt: now,
  };
}

export function linearLifecycleIsActionable(task: TaskRecord): boolean {
  return task.role === "implementation"
    && Boolean(task.linear)
    && task.linear?.status !== "in-progress"
    && Boolean(task.workerStartedAt)
    && ["running", "blocked", "pr-ready-ci-pending", "pr-ready-ci-green"].includes(task.status);
}

export function linearLifecycleHasPendingWriteScope(task: TaskRecord): boolean {
  return linearLifecycleIsActionable(task)
    && (task.linear?.status === "pending" || task.linear?.status === "verifying");
}

export function automaticLinearUpdateSafetyReason(
  tasks: TaskRecord[],
  input: Record<string, unknown>,
): string | undefined {
  const pending = tasks.filter(linearLifecycleHasPendingWriteScope);
  if (pending.length === 0) return undefined;
  const identifier = normalizeLinearIssueReference(typeof input.issue === "string" ? input.issue : undefined);
  if (!identifier) return "Automatic Linear start requires the exact bound issue identifier.";
  const lifecycleTasks = pending.filter((task) => task.linear?.issueIdentifier === identifier);
  if (lifecycleTasks.length === 0) {
    return `Automatic Linear start is scoped to ${pending.map((task) => task.linear?.issueIdentifier).join(", ")}; ${identifier} is unrelated.`;
  }
  if (lifecycleTasks.some((task) => {
    const claimed = Date.parse(task.linear?.writeClaimedAt ?? "");
    return task.linear?.writeClaimId && Number.isFinite(claimed) && Date.now() - claimed < 5 * 60_000;
  })) {
    return `A state write for ${identifier} is already in flight; wait for its result and readback.`;
  }
  if (lifecycleTasks.every((task) => task.linear?.status === "verifying")) {
    return `The state write for ${identifier} already succeeded; call linear_get_issue for readback instead of writing again.`;
  }
  const fields = Object.keys(input).filter((key) => input[key] !== undefined);
  const extraFields = fields.filter((key) => key !== "issue" && key !== "stateId");
  if (extraFields.length > 0) {
    return `Automatic Linear start may update only stateId; remove: ${extraFields.join(", ")}.`;
  }
  const candidateIds = new Set(lifecycleTasks
    .filter((task) => {
      const observed = Date.parse(task.linear?.candidateObservedAt ?? "");
      const issueObserved = Date.parse(task.linear?.issueObservedAt ?? "");
      return Number.isFinite(observed)
        && Number.isFinite(issueObserved)
        && observed >= issueObserved
        && Date.now() - observed < 5 * 60_000
        && task.linear?.candidateTeamId === task.linear?.teamId;
    })
    .map((task) => task.linear?.candidateStateId)
    .filter((id): id is string => Boolean(id)));
  if (candidateIds.size !== 1) {
    return `Call linear_get_issue and then linear_list_issue_statuses again for ${identifier}; no single persisted read-proven In Progress state is recorded.`;
  }
  const [candidateId] = [...candidateIds];
  if (input.stateId !== candidateId) {
    return `Use the read-proven In Progress stateId ${candidateId} for ${identifier}.`;
  }
  return undefined;
}

export function linearLifecycleMutationSafetyReason(
  tasks: TaskRecord[],
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!tasks.some(linearLifecycleHasPendingWriteScope)) return undefined;
  if (toolName !== "linear_update_issue") {
    return "A pending automatic Linear start may mutate only the bound issue stateId; finish its verified readback before other Linear writes.";
  }
  return automaticLinearUpdateSafetyReason(tasks, input);
}

export function linearStartInstruction(task: TaskRecord): string {
  const identifier = task.linear?.issueIdentifier;
  if (!identifier) throw new Error("Task has no Linear issue binding");
  return [
    `# Linear lifecycle: start ${identifier}`,
    "",
    `Implementation worker ${task.id.slice(0, 8)} is now running for Linear issue ${identifier}.`,
    "Update its workflow state through @alasano/pi-linear now. This is routine lifecycle administration and requires no contract or extra confirmation.",
    "",
    "1. Call linear_get_issue for the exact identifier and note its canonical team ID and current state.",
    "2. If its state type is already `started`, stop; the readback already proves it is in progress.",
    "3. Otherwise call linear_list_issue_statuses with `filter: { team: { id: { eq: <canonical-team-id> } } }`. Prefer the state named `In Progress`; if the team uses another name, choose its sole canonical state with type `started`.",
    "4. Call linear_update_issue for only this issue with only the read-proven stateId.",
    "5. Call linear_get_issue again and report success only when the returned state has type `started`.",
    "",
    "Do not switch Linear workspaces, update another issue, or change any unrelated field. If pi-linear is unavailable or authentication fails, leave the worker running and report the lifecycle sync as pending rather than asking for implementation approval.",
  ].join("\n");
}

export function linearLifecycleAfterToolResult(
  current: LinearLifecycleState,
  toolName: string,
  snapshot: LinearIssueSnapshot | undefined,
  isError: boolean,
  error?: string,
): LinearLifecycleState {
  const now = new Date().toISOString();
  if (isError) {
    return {
      ...current,
      status: "pending",
      attempts: current.attempts + 1,
      writeClaimId: undefined,
      writeClaimedAt: undefined,
      lastError: error || `${toolName} failed`,
      updatedAt: now,
    };
  }
  if (toolName === "linear_update_issue") {
    return {
      ...current,
      status: "verifying",
      attempts: current.attempts + 1,
      writeClaimId: undefined,
      writeClaimedAt: undefined,
      writeObservedAt: now,
      lastError: undefined,
      updatedAt: now,
    };
  }
  if (toolName === "linear_get_issue" && snapshot) {
    const observed = {
      ...current,
      issueId: snapshot.id,
      teamId: snapshot.team?.id,
      issueObservedAt: now,
      stateId: snapshot.state?.id,
      stateName: snapshot.state?.name,
      candidateStateId: undefined,
      candidateStateName: undefined,
      candidateTeamId: undefined,
      candidateObservedAt: undefined,
      updatedAt: now,
    };
    if (isStartedLinearState(snapshot.state)) {
      return {
        ...observed,
        status: "in-progress",
        writeClaimId: undefined,
        writeClaimedAt: undefined,
        verifiedAt: now,
        lastError: undefined,
      };
    }
    if (current.status === "verifying") {
      return {
        ...observed,
        status: "pending",
        lastError: `Linear readback did not confirm a started state${snapshot.state?.name ? ` (found ${snapshot.state.name})` : ""}`,
      };
    }
    return { ...observed, lastError: undefined };
  }
  return { ...current, updatedAt: now };
}
