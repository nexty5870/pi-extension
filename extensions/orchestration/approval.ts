export type ApprovalIntent = "explicit" | "ambiguous" | "none";

/** Normalize formatting differences without turning vague acknowledgements into approval. */
export function normalizeApprovalText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXPLICIT_APPROVALS = [
  /^approve(?:d)?(?: the)? contract and (?:start )?implement(?:ation|ing)?$/,
  /^approve(?:d)? implement(?:ation|ing)?$/,
  /^go ahead and implement(?: it|ation)?$/,
];

const AMBIGUOUS_ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "looks good",
  "looks great",
  "sounds good",
  "fine",
  "sure",
  "proceed",
  "go ahead",
]);

export function classifyApprovalIntent(text: string): ApprovalIntent {
  const normalized = normalizeApprovalText(text);
  if (EXPLICIT_APPROVALS.some((pattern) => pattern.test(normalized))) return "explicit";
  if (AMBIGUOUS_ACKNOWLEDGEMENTS.has(normalized)) return "ambiguous";
  return "none";
}
