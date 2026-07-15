import type { CommandRunner } from "./command.ts";
import { checked } from "./command.ts";

export type CiState = "pending" | "success" | "failure" | "cancelled" | "timed-out" | "none";
export class GitHubAdapter {
  constructor(private readonly runner: CommandRunner) {}
  async assertPublic(root: string): Promise<string> {
    const raw = await checked(this.runner, "gh", ["repo", "view", "--json", "visibility,nameWithOwner"], root);
    const value = JSON.parse(raw) as { visibility?: string; nameWithOwner?: string };
    if (value.visibility !== "PUBLIC" || !value.nameWithOwner) throw new Error("Delivery publication requires an acknowledged public GitHub repository");
    return value.nameWithOwner;
  }
  async reconcilePr(root: string, branch: string, base: string, title: string, body: string): Promise<string> {
    const existingRaw = await checked(this.runner, "gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url,title,body,baseRefName", "--limit", "2"], root);
    const existing = JSON.parse(existingRaw) as Array<{ url: string; title: string; body: string; baseRefName: string }>;
    if (existing.length > 1) throw new Error("Multiple open PRs exist for the delivery branch");
    if (existing[0]) {
      if (existing[0].title !== title || existing[0].body !== body || existing[0].baseRefName !== base) throw new Error("Existing PR does not match approved metadata");
      return existing[0].url;
    }
    return checked(this.runner, "gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], root, 120_000);
  }
  async observeCi(root: string, prUrl: string, timeoutMs = 10 * 60_000): Promise<CiState> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.runner.run("gh", ["pr", "checks", prUrl, "--json", "state"], { cwd: root, timeoutMs: 60_000 });
      if (result.exitCode !== 0) return "failure";
      const checks = JSON.parse(result.stdout || "[]") as Array<{ state: string }>;
      if (checks.length === 0) return "none";
      const states = checks.map((item) => item.state.toUpperCase());
      if (states.some((state) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(state))) return "failure";
      if (states.some((state) => ["CANCELLED", "SKIPPED"].includes(state))) return "cancelled";
      if (states.every((state) => ["SUCCESS", "NEUTRAL"].includes(state))) return "success";
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    return "timed-out";
  }
}
