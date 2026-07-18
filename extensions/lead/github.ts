import type { CommandExecutor } from "./git.ts";
import type { CheckEvidence, PullRequestObservation } from "./types.ts";

interface CheckRollup {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  link?: string;
}

interface PullRequestPayload {
  url?: string;
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  headRefOid?: string;
  statusCheckRollup?: CheckRollup[] | null;
}

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function checkName(check: CheckRollup, index: number): string {
  return check.name?.trim() || check.context?.trim() || `${check.__typename ?? "check"}-${index + 1}`;
}

export function classifyPullRequest(payload: PullRequestPayload, fallbackUrl = ""): PullRequestObservation {
  const url = payload.url?.trim() || fallbackUrl;
  if (!url) throw new Error("GitHub did not return a pull request URL");
  const checks: CheckEvidence[] = (payload.statusCheckRollup ?? []).map((check, index) => {
    const outcome = normalized(check.conclusion || check.state);
    const execution = normalized(check.status);
    let status: CheckEvidence["status"];
    if (GREEN.has(outcome)) status = outcome === "SKIPPED" ? "skipped" : "passed";
    else if (FAILED.has(outcome)) status = "failed";
    else if (PENDING.has(outcome) || PENDING.has(execution) || !outcome) status = "pending";
    else status = "pending";
    return {
      name: checkName(check, index),
      status,
      details: check.detailsUrl || check.link,
    };
  });

  const pullRequestState = normalized(payload.state);
  if (pullRequestState === "MERGED") {
    if (!payload.headRefOid?.trim() || payload.statusCheckRollup == null) {
      return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub merged state is missing head or check evidence" };
    }
    return { status: "merged", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
  }
  if (pullRequestState === "CLOSED") {
    return { status: "failed", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "Pull request is closed without merge" };
  }
  if (pullRequestState !== "OPEN") {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub returned an unknown pull request state" };
  }
  if (!payload.headRefOid?.trim()) {
    return { status: "pending", url, mergeState: payload.mergeStateStatus, checks, reason: "GitHub did not return the pull request head" };
  }
  if (payload.statusCheckRollup == null) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "GitHub check evidence is incomplete" };
  }
  if (payload.isDraft) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks, reason: "Pull request is still a draft" };
  }
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      url,
      headSha: payload.headRefOid,
      mergeState: payload.mergeStateStatus,
      checks,
      reason: `CI failed: ${failed.map((check) => check.name).join(", ")}`,
    };
  }
  const pending = checks.filter((check) => check.status === "pending");
  if (pending.length > 0) {
    return { status: "pending", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
  }
  return { status: "green", url, headSha: payload.headRefOid, mergeState: payload.mergeStateStatus, checks };
}

export async function observePullRequest(
  execute: CommandExecutor,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<PullRequestObservation> {
  const result = await execute("gh", [
    "pr",
    "view",
    url,
    "--json",
    "url,state,isDraft,mergeStateStatus,headRefOid,statusCheckRollup",
  ], { cwd, signal, timeout: 30_000 });
  if (result.code !== 0) throw new Error(`Unable to observe PR: ${result.stderr.trim() || result.stdout.trim()}`);
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(result.stdout) as PullRequestPayload;
  } catch {
    throw new Error("GitHub returned malformed PR status JSON");
  }
  return classifyPullRequest(payload, url);
}
