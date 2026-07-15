import type { ReviewerResult } from "./types.ts";

export function parseReviewerResult(text: string, expectedDiffHash: string): ReviewerResult {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { throw new Error("Reviewer output is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reviewer output must be an object");
  const record = value as Record<string, unknown>;
  if (record.verdict !== "approved" && record.verdict !== "changes_requested") throw new Error("Reviewer verdict is invalid");
  if (record.diffHash !== expectedDiffHash) throw new Error("Reviewer diff hash does not match the current diff");
  if (!Array.isArray(record.findings) || record.findings.some((item) => typeof item !== "string")) throw new Error("Reviewer findings must be strings");
  if (record.verdict === "approved" && record.findings.length > 0) throw new Error("Approved review cannot contain findings");
  if (record.verdict === "changes_requested" && record.findings.length === 0) throw new Error("Requested changes require findings");
  return record as unknown as ReviewerResult;
}
