import assert from "node:assert/strict";
import test from "node:test";
import { attestActualModel, canonicalModelId, resolveModelSelection } from "../extensions/lead-v4/model.ts";
import {
  backgroundWorkspaceIsPresent,
  classifyIdentity,
  replacementIsProvenSafe,
  type CmuxUuidSnapshot,
} from "../extensions/lead-v4/topology.ts";
import type { StableCmuxIdentity } from "../extensions/lead-v4/types.ts";

const identity: StableCmuxIdentity = {
  windowUuid: "11111111-1111-4111-8111-111111111111",
  workspaceUuid: "22222222-2222-4222-8222-222222222222",
  paneUuid: "33333333-3333-4333-8333-333333333333",
  surfaceUuid: "44444444-4444-4444-8444-444444444444",
  workspaceRef: "workspace:6",
  paneRef: "pane:35",
  surfaceRef: "surface:104",
};

function snapshot(overrides: Partial<CmuxUuidSnapshot> = {}): CmuxUuidSnapshot {
  return {
    complete: true,
    capturedAt: new Date().toISOString(),
    workspaceUuids: new Set([identity.workspaceUuid]),
    workspaceToWindow: new Map([[identity.workspaceUuid, identity.windowUuid]]),
    paneToWorkspace: new Map([[identity.paneUuid, identity.workspaceUuid]]),
    surfaceToPane: new Map([[identity.surfaceUuid, identity.paneUuid]]),
    processPidsBySurface: new Map([[identity.surfaceUuid, new Set([123])]]),
    ...overrides,
  };
}

test("V4 model resolution persists exact precedence and never silently falls back", () => {
  const availableModels = ["openai/gpt-5.6-sol", "anthropic/claude-opus-4-6", "other/gpt-5.6-sol"];
  const explicit = resolveModelSelection({
    explicit: { model: "anthropic/claude-opus-4-6", thinking: "off" },
    spawningLead: { model: "openai/gpt-5.6-sol", thinking: "high" },
    featurePreset: { model: "openai/gpt-5.6-sol", thinking: "medium" },
    roleProject: { model: "openai/gpt-5.6-sol", thinking: "low" },
    inheritedLead: { model: "openai/gpt-5.6-sol", thinking: "minimal" },
    availableModels,
  });
  assert.equal(explicit.requestedModel, "anthropic/claude-opus-4-6");
  assert.equal(explicit.model.source, "explicit-operator");
  assert.equal(explicit.requestedThinking, "off");
  assert.equal(explicit.thinking.source, "explicit-operator");

  const spawning = resolveModelSelection({
    spawningLead: { model: "openai/gpt-5.6-sol", thinking: "high" },
    featurePreset: { model: "anthropic/claude-opus-4-6", thinking: "medium" },
    roleProject: { thinking: "low" },
    inheritedLead: { model: "anthropic/claude-opus-4-6", thinking: "minimal" },
    availableModels,
  });
  assert.equal(spawning.model.source, "spawning-lead");
  assert.equal(spawning.thinking.source, "spawning-lead");
  assert.equal(attestActualModel(spawning, spawning.requestedModel, "medium").actualThinking, "medium");
  assert.throws(() => attestActualModel(spawning, "anthropic/claude-opus-4-6", "high"), /quarantined/);
  assert.throws(() => canonicalModelId("missing", availableModels), /unavailable/);
  assert.throws(() => canonicalModelId("gpt-5.6-sol", availableModels), /ambiguous/);
  assert.equal(canonicalModelId("claude-opus-4-6", availableModels), "anthropic/claude-opus-4-6");
});

test("background non-selected cmux workspace remains PRESENT regardless of in_window=false", () => {
  const live = snapshot();
  assert.equal(classifyIdentity(live, identity), "present");
  assert.equal(backgroundWorkspaceIsPresent(live, identity, false), true);
});

test("short-ref reuse, partial tuples, malformed topology, and cmux restart fail UNKNOWN", () => {
  const changedUuidSameRef = {
    ...identity,
    surfaceUuid: "55555555-5555-4555-8555-555555555555",
    surfaceRef: identity.surfaceRef,
  };
  assert.equal(classifyIdentity(snapshot(), changedUuidSameRef), "unknown");
  assert.equal(classifyIdentity(snapshot({ complete: false, error: "cmux unavailable" }), identity), "unknown");
  assert.equal(classifyIdentity(snapshot({ paneToWorkspace: new Map() }), identity), "unknown");
});

test("replacement requires old process exit and UUID absence in two fresh complete snapshots", () => {
  const absentOne = snapshot({
    capturedAt: "2026-01-01T00:00:00.000Z",
    workspaceUuids: new Set(),
    workspaceToWindow: new Map(),
    paneToWorkspace: new Map(),
    surfaceToPane: new Map(),
    processPidsBySurface: new Map(),
  });
  const absentTwo = { ...absentOne, capturedAt: "2026-01-01T00:00:01.000Z" };
  assert.equal(replacementIsProvenSafe({ identity, first: absentOne, second: absentTwo, oldProcessExited: true, oldGeneration: 1, requestedGeneration: 2 }), true);
  assert.equal(replacementIsProvenSafe({ identity, first: absentOne, second: absentTwo, oldProcessExited: false, oldGeneration: 1, requestedGeneration: 2 }), false);
  assert.equal(replacementIsProvenSafe({ identity, first: snapshot(), second: absentTwo, oldProcessExited: true, oldGeneration: 1, requestedGeneration: 2 }), false);
});
