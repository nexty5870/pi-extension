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

export function extractLinearIssueIdentifiers(text: string): string[] {
  return [...new Set(text.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
}

export function isLinearIssueAdminDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  const negated = /\b(?:do not|don t|never|not)\b.*\b(?:apply|update|change|set|add|remove|tag|label|prioritize|link|block|depend|assign)\b/.test(normalized);
  const deliberative = /^(?:should|shall) (?:we|i)\b/.test(normalized);
  const action = /\b(?:apply|update|change|set|add|remove|tag|label|prioritize|link|block|depend|assign)\w*\b/.test(normalized) || /^(?:yes|agreed|do it|go ahead|apply it)\b/.test(normalized);
  return !negated && !deliberative && action;
}

export function isImplementationStartDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  const negated = /\b(?:do not|don t|never|not)\b.*\b(?:start|begin|launch|implement|proceed|continue)\b/.test(normalized);
  const deliberative = /^(?:should|shall) (?:we|i)\b/.test(normalized);
  const concrete = /\b(?:start|begin|launch|kick off)\b.{0,80}\b(?:implementation|delivery|work)\b/.test(normalized) || /\bimplement(?: it| this| the)?\b/.test(normalized);
  const continuation = /^(?:yes |confirm |confirmed |please )?(?:let s |lets )?(?:proceed|continue|do it|get it done|make it happen)(?: with (?:it|implementation|delivery|the contract))?\b/.test(normalized);
  return !negated && !deliberative && (concrete || continuation);
}

export function isLinearPlanPublishCancelDirective(text: string): boolean {
  const normalized = normalizeApprovalText(text);
  return /\b(?:cancel|stop|abort|forget)\b.{0,80}\b(?:linear|publish|publication|sync|plan)\b/.test(normalized) ||
    /\b(?:do not|don t|never)\b.{0,80}\b(?:publish|translate|sync|create|put|move)\b/.test(normalized);
}

export function restoreLinearPlanPublishIntent(userMessages: string[]): boolean {
  let armed = false;
  for (const message of userMessages) {
    if (isLinearPlanPublishDirective(message)) armed = true;
    if (isLinearPlanPublishCancelDirective(message) || isImplementationStartDirective(message)) armed = false;
  }
  return armed;
}

export function classifyApprovalIntent(text: string): ApprovalIntent {
  const normalized = normalizeApprovalText(text);
  if (/\b(?:do not|don t|never|not)\b.*\b(?:approve|accept|confirm|implement|proceed|continue|ship|mark|complete|close|set|move|update|change)\b/.test(normalized)) return "none";
  if (/^(?:should|shall) (?:we|i)\b/.test(normalized)) return "none";
  if (/\b(?:approve|approved|accept|accepted|confirm|confirmed)\b/.test(normalized)) return "explicit";
  if (/\b(?:let s|lets) proceed\b/.test(normalized)) return "explicit";
  if (/\b(?:get it done|do it|implement it|start implementation|ship it|make it happen|mark (?:it )?done)\b/.test(normalized)) return "explicit";
  if (/\bgo ahead(?: and (?:implement(?: it|ation)?|get it done|do it|ship it))?\b/.test(normalized)) return "explicit";
  if (EXPLICIT_APPROVALS.some((pattern) => pattern.test(normalized))) return "explicit";
  if (AMBIGUOUS_ACKNOWLEDGEMENTS.has(normalized)) return "ambiguous";
  return "none";
}
