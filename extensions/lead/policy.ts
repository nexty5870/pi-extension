import type { DelegateInput, DelegateRuntime } from "./coordinator.ts";
import type { ProjectRecord, ResolvedWorkerPolicy, ThinkingLevel, WorkerPolicy, WorkerRole } from "./types.ts";

export const DEFAULT_WORKER_POLICY = Object.freeze({
  maxVisibleSurfaces: 6,
  heartbeatSeconds: 15,
  staleAfterSeconds: 120,
  idleReportGraceSeconds: 15,
  terminalSurfaceRetentionMinutes: 10,
  contextWarnPercent: 80,
  contextHandoffPercent: 92,
  supervisionSeconds: 15,
});

export interface EffectiveWorkerPolicy extends WorkerPolicy {
  maxVisibleSurfaces: number;
  heartbeatSeconds: number;
  staleAfterSeconds: number;
  idleReportGraceSeconds: number;
  terminalSurfaceRetentionMinutes: number;
  contextWarnPercent: number;
  contextHandoffPercent: number;
  supervisionSeconds: number;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function effectiveWorkerPolicy(policy?: WorkerPolicy): EffectiveWorkerPolicy {
  const warn = bounded(policy?.contextWarnPercent, DEFAULT_WORKER_POLICY.contextWarnPercent, 1, 99);
  const handoff = bounded(policy?.contextHandoffPercent, DEFAULT_WORKER_POLICY.contextHandoffPercent, warn, 100);
  return {
    ...policy,
    maxVisibleSurfaces: bounded(policy?.maxVisibleSurfaces, DEFAULT_WORKER_POLICY.maxVisibleSurfaces, 1, 50),
    heartbeatSeconds: bounded(policy?.heartbeatSeconds, DEFAULT_WORKER_POLICY.heartbeatSeconds, 1, 300),
    staleAfterSeconds: bounded(policy?.staleAfterSeconds, DEFAULT_WORKER_POLICY.staleAfterSeconds, 2, 3_600),
    idleReportGraceSeconds: bounded(policy?.idleReportGraceSeconds, DEFAULT_WORKER_POLICY.idleReportGraceSeconds, 0, 600),
    terminalSurfaceRetentionMinutes: bounded(policy?.terminalSurfaceRetentionMinutes, DEFAULT_WORKER_POLICY.terminalSurfaceRetentionMinutes, 0, 10_080),
    contextWarnPercent: warn,
    contextHandoffPercent: handoff,
    supervisionSeconds: bounded(policy?.supervisionSeconds, DEFAULT_WORKER_POLICY.supervisionSeconds, 2, 300),
  };
}

function matches(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(model);
}

function splitModel(model?: string): Pick<ResolvedWorkerPolicy, "provider" | "modelId"> {
  if (!model) return {};
  const slash = model.indexOf("/");
  return slash < 0 ? { modelId: model } : { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** Resolve trusted project policy. Pi remains responsible for capability clamping. */
export function resolveWorkerPolicy(
  project: ProjectRecord,
  input: Pick<DelegateInput, "model" | "thinking"> & { role?: WorkerRole },
  runtime: Pick<DelegateRuntime, "model" | "thinking">,
): ResolvedWorkerPolicy {
  const role = input.role ?? "implementation";
  const policy = project.workers;
  const configuredModel = policy?.roles?.[role]?.model ?? policy?.default?.model;
  const inheritedModel = policy?.default?.inheritModel === false ? undefined : runtime.model;
  const model = input.model ?? configuredModel ?? inheritedModel;
  const modelRule = model ? [...(policy?.models ?? [])].reverse().find((rule) => matches(rule.pattern, model)) : undefined;
  const thinking = input.thinking
    ?? modelRule?.thinking
    ?? policy?.roles?.[role]?.thinking
    ?? policy?.default?.thinking
    ?? runtime.thinking as ResolvedWorkerPolicy["thinking"];
  return { model, ...splitModel(model), thinking };
}
