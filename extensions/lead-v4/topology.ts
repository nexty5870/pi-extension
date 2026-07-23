import type { StableCmuxIdentity } from "./types.ts";

export type TopologyPresence = "present" | "absent" | "unknown";

export interface CmuxUuidSnapshot {
  complete: boolean;
  capturedAt: string;
  workspaceUuids: Set<string>;
  workspaceToWindow: Map<string, string>;
  paneToWorkspace: Map<string, string>;
  surfaceToPane: Map<string, string>;
  processPidsBySurface: Map<string, Set<number>>;
  cmuxInstance?: string;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStableUuid(value: string | undefined): value is string {
  return Boolean(value && UUID.test(value));
}

export function assertStableUuid(value: string | undefined, label: string): asserts value is string {
  if (!isStableUuid(value)) throw new Error(`${label} must be a stable cmux UUID; short refs are display-only and never mutation targets`);
}

export function classifyIdentity(snapshot: CmuxUuidSnapshot, identity: StableCmuxIdentity): TopologyPresence {
  if (!snapshot.complete || snapshot.error) return "unknown";
  if (![identity.windowUuid, identity.workspaceUuid, identity.paneUuid, identity.surfaceUuid].every(isStableUuid)) return "unknown";
  const workspaceWindow = snapshot.workspaceToWindow.get(identity.workspaceUuid);
  const paneWorkspace = snapshot.paneToWorkspace.get(identity.paneUuid);
  const surfacePane = snapshot.surfaceToPane.get(identity.surfaceUuid);
  if (snapshot.workspaceUuids.has(identity.workspaceUuid)
    && workspaceWindow === identity.windowUuid
    && paneWorkspace === identity.workspaceUuid
    && surfacePane === identity.paneUuid) return "present";
  const tuplePartiallyReused = snapshot.workspaceUuids.has(identity.workspaceUuid)
    || snapshot.paneToWorkspace.has(identity.paneUuid)
    || snapshot.surfaceToPane.has(identity.surfaceUuid);
  return tuplePartiallyReused ? "unknown" : "absent";
}

export function replacementIsProvenSafe(input: {
  identity: StableCmuxIdentity;
  first: CmuxUuidSnapshot;
  second: CmuxUuidSnapshot;
  oldProcessExited: boolean;
  oldGeneration: number;
  requestedGeneration: number;
}): boolean {
  return input.oldProcessExited
    && input.requestedGeneration > input.oldGeneration
    && classifyIdentity(input.first, input.identity) === "absent"
    && classifyIdentity(input.second, input.identity) === "absent"
    && input.first.capturedAt !== input.second.capturedAt;
}

export function backgroundWorkspaceIsPresent(
  snapshot: CmuxUuidSnapshot,
  identity: StableCmuxIdentity,
  _healthInWindow: boolean,
): boolean {
  // `in_window` means selected/visible in current cmux UI state, not alive.
  // A background workspace is attached whenever the exact UUID tuple is in the
  // topology. Deliberately ignore the health flag.
  return classifyIdentity(snapshot, identity) === "present";
}

export function processAttestationMatches(
  snapshot: CmuxUuidSnapshot,
  identity: StableCmuxIdentity,
  pid: number,
): boolean {
  return classifyIdentity(snapshot, identity) === "present"
    && (snapshot.processPidsBySurface.get(identity.surfaceUuid)?.has(pid) ?? false);
}
