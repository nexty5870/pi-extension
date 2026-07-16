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
  /^(?:yes )?approve(?:d)?(?: the)?(?: contract)?(?: and)?(?: start)?(?: implementation| implementing| implement| get it done| do it| ship it| mark it done)?$/,
  /^(?:yes )?(?:accept|accepted)(?: the)? contract(?: and)?(?: get it done| do it| implement(?: it|ation)?)?$/,
  /^(?:yes )?(?:go ahead(?: and)?|please )?(?:get it done|do it|implement(?: it|ation)?|ship it|make it happen|mark it done)$/,
  /^(?:yes )?(?:go ahead|proceed|continue)(?: with (?:it|implementation|the contract))?$/,
  /^(?:yes )?(?:let s|lets) (?:do it|get it done|ship it)$/,
];

const AMBIGUOUS_ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "looks good",
  "looks great",
  "sounds good",
  "fine",
  "sure",
]);

export function isCompletionDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  const mutation = "(?:mark|complete|close|set|move|update|change)";
  const outcome = "(?:done|complete|completed|closed)";
  const negated = new RegExp(`\\b(?:do not|don t|never|not)\\b.*\\b${mutation}\\b`).test(normalized);
  const deliberative = /^(?:should|shall) (?:we|i)\b/.test(normalized);
  const direct = /\b(?:mark (?:it )?done|complete (?:it|the issue)|close (?:it|the issue))\b/.test(normalized);
  const workflow = new RegExp(`\\b${mutation}\\b.{0,100}\\b(?:to |as |already )?${outcome}\\b`).test(normalized);
  return !negated && !deliberative && (direct || workflow);
}

export function isLinearIssueCreateDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  const negated = /\b(?:do not|don t|never|not)\b.*\b(?:open|create|file|log|add|record)\b/.test(normalized);
  const deliberative = /^(?:should|shall) (?:we|i)\b/.test(normalized);
  const actionFirst = /\b(?:open|create|file|log|add|record)\b.{0,100}\b(?:bug|issue|ticket)\b/.test(normalized);
  const resourceFirst = /\b(?:bug|issue|ticket)\b.{0,60}\b(?:in|on) linear\b/.test(normalized);
  return !negated && !deliberative && (actionFirst || resourceFirst);
}

export function isLinearPlanPublishDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  const negated = /\b(?:do not|don t|never|not)\b.*\b(?:publish|translate|sync|create|put|move)\b/.test(normalized);
  const deliberative = /^(?:should|shall) (?:we|i)\b/.test(normalized);
  const publish = /\b(?:publish|translate|sync|put|move)\b.{0,120}\b(?:to|into|in) linear\b/.test(normalized);
  const create = /\bcreate\b.{0,100}\b(?:plan|project|roadmap)\b.{0,100}\b(?:in|on|to|into) linear\b/.test(normalized);
  return !negated && !deliberative && (publish || create);
}

export function classifyApprovalIntent(text: string): ApprovalIntent {
  const normalized = normalizeApprovalText(text);
  if (/\b(?:do not|don t|never|not)\b.*\b(?:approve|accept|implement|proceed|continue|ship|mark|complete|close|set|move|update|change)\b/.test(normalized)) return "none";
  if (/^(?:should|shall) (?:we|i)\b/.test(normalized)) return "none";
  if (/\b(?:approve|approved|accept|accepted)\b/.test(normalized)) return "explicit";
  if (/\b(?:get it done|do it|implement it|start implementation|ship it|make it happen|mark (?:it )?done)\b/.test(normalized)) return "explicit";
  if (/\bgo ahead(?: and (?:implement(?: it|ation)?|get it done|do it|ship it))?\b/.test(normalized)) return "explicit";
  if (EXPLICIT_APPROVALS.some((pattern) => pattern.test(normalized))) return "explicit";
  if (AMBIGUOUS_ACKNOWLEDGEMENTS.has(normalized)) return "ambiguous";
  return "none";
}
