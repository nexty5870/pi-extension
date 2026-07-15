import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InitiativeState } from "./types.ts";

export const INITIATIVE_ENTRY_TYPE = "team-orchestration:initiative";

export function restoreInitiative(ctx: ExtensionContext): InitiativeState | undefined {
  let restored: InitiativeState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== INITIATIVE_ENTRY_TYPE) continue;
    restored = entry.data as InitiativeState;
  }
  return restored;
}

export function persistInitiativeEntry(pi: ExtensionAPI, state: InitiativeState): void {
  pi.appendEntry(INITIATIVE_ENTRY_TYPE, state);
}

export function initiativeSessionName(state: InitiativeState): string | undefined {
  if (!state.contract) return undefined;
  const kind = state.contract.kind === "feature" ? "Feature" : "Bug";
  return `CTO · ${kind} · ${state.contract.title}`;
}
