import type { UsageRecord } from "./types.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  estimatedCost: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export function aggregateUsage(records: UsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (total, record) => ({
      input: total.input + record.input,
      output: total.output + record.output,
      cacheRead: total.cacheRead + record.cacheRead,
      cacheWrite: total.cacheWrite + record.cacheWrite,
      cost: total.cost + record.cost,
      estimatedCost: total.estimatedCost || record.estimatedCost,
      turns: total.turns + record.turns,
      toolCalls: total.toolCalls + record.toolCalls,
      durationMs: total.durationMs + (record.durationMs ?? 0),
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      estimatedCost: false,
      turns: 0,
      toolCalls: 0,
      durationMs: 0,
    },
  );
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
