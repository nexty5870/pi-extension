import type { ModelSelection, ResolvedChoice, ResolvedModelSelection, ResolutionSource, V4ThinkingLevel } from "./types.ts";

export interface ModelResolutionInput {
  explicit?: ModelSelection;
  spawningLead?: ModelSelection;
  featurePreset?: ModelSelection;
  roleProject?: ModelSelection;
  inheritedLead?: ModelSelection;
  availableModels: string[];
}

const SOURCES: Array<{ source: ResolutionSource; value: keyof Omit<ModelResolutionInput, "availableModels"> }> = [
  { source: "explicit-operator", value: "explicit" },
  { source: "spawning-lead", value: "spawningLead" },
  { source: "feature-preset", value: "featurePreset" },
  { source: "role-project", value: "roleProject" },
  { source: "inherited-lead", value: "inheritedLead" },
];

function choice<T extends keyof ModelSelection>(input: ModelResolutionInput, field: T): ResolvedChoice<NonNullable<ModelSelection[T]>> | undefined {
  for (const candidate of SOURCES) {
    const selected = input[candidate.value]?.[field];
    if (selected !== undefined) return { value: selected as NonNullable<ModelSelection[T]>, source: candidate.source };
  }
  return undefined;
}

export function canonicalModelId(requested: string, availableModels: string[]): string {
  const normalized = requested.trim();
  if (!normalized) throw new Error("A provider/model selection is required; V4 never chooses an arbitrary fallback model");
  const exact = availableModels.filter((model) => model === normalized);
  if (exact.length === 1) return exact[0];
  if (normalized.includes("/")) throw new Error(`Requested model ${normalized} is unavailable; V4 refuses silent fallback`);
  const aliases = availableModels.filter((model) => model.slice(model.indexOf("/") + 1) === normalized);
  if (aliases.length === 0) throw new Error(`Requested model alias ${normalized} is unavailable; provide an exact provider/model ID`);
  if (aliases.length > 1) throw new Error(`Requested model alias ${normalized} is ambiguous (${aliases.join(", ")}); choose an exact provider/model ID`);
  return aliases[0];
}

export function resolveModelSelection(input: ModelResolutionInput): ResolvedModelSelection {
  const modelChoice = choice(input, "model");
  if (!modelChoice) throw new Error("No model was resolved; select an explicit provider/model or configure a V4 policy");
  const model = canonicalModelId(modelChoice.value, [...new Set(input.availableModels)]);
  const thinkingChoice = choice(input, "thinking") ?? { value: "off" as V4ThinkingLevel, source: "inherited-lead" as const };
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error(`Canonical model ID must be provider/model, received ${model}`);
  return {
    model: { value: model, source: modelChoice.source },
    thinking: thinkingChoice,
    requestedModel: model,
    requestedThinking: thinkingChoice.value,
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    resolvedAt: new Date().toISOString(),
  };
}

export function attestActualModel(
  resolved: ResolvedModelSelection,
  actualModel: string,
  actualThinking: V4ThinkingLevel,
): ResolvedModelSelection {
  if (actualModel !== resolved.requestedModel) {
    throw new Error(`Worker started with ${actualModel}, not requested ${resolved.requestedModel}; generation is quarantined`);
  }
  // Pi may capability-clamp thinking. Persist both values and make the mismatch
  // visible instead of rewriting the requested operator choice.
  return { ...resolved, actualModel, actualThinking };
}
