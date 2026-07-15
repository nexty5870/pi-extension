import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, formatTokenCount } from "../extensions/orchestration/usage.ts";
import type { UsageRecord } from "../extensions/orchestration/types.ts";

const base: UsageRecord = {
  schemaVersion: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
  projectId: "project-1",
  role: "cto",
  runtime: "pi",
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 5,
  cost: 0.01,
  estimatedCost: false,
  turns: 1,
  toolCalls: 2,
};

test("aggregates reported and estimated usage", () => {
  const total = aggregateUsage([
    base,
    { ...base, role: "scout", input: 50, cost: 0.02, estimatedCost: true, durationMs: 500 },
  ]);
  assert.deepEqual(total, {
    input: 150,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cost: 0.03,
    estimatedCost: true,
    turns: 2,
    toolCalls: 4,
    durationMs: 500,
  });
});

test("formats token counts compactly", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(25_000), "25k");
  assert.equal(formatTokenCount(1_200_000), "1.2m");
});
