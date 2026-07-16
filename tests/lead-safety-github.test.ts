import assert from "node:assert/strict";
import test from "node:test";
import { classifyPullRequest } from "../extensions/lead/github.ts";
import { classifyBashRisk, isDestructiveLinearTool, isLinearMutationTool, sensitiveCommandReason, sensitivePathReason } from "../extensions/lead/safety.ts";

test("GitHub observations distinguish pending, failed, green, and merged", () => {
  assert.equal(classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "OPEN",
    statusCheckRollup: [{ name: "test", status: "IN_PROGRESS", conclusion: "" }],
  }).status, "pending");
  const failed = classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "OPEN",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /test/);
  assert.equal(classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "OPEN",
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  }).status, "green");
  assert.equal(classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "MERGED",
    statusCheckRollup: [],
  }).status, "merged");
  assert.equal(classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "OPEN",
    isDraft: true,
    statusCheckRollup: [],
  }).status, "pending");
  assert.equal(classifyPullRequest({
    url: "https://github.com/example/repo/pull/1",
    state: "CLOSED",
    statusCheckRollup: [],
  }).status, "failed");
});

test("V2 gates only clear dangerous boundaries instead of disabling normal shell work", () => {
  assert.equal(classifyBashRisk("npm test && git status"), undefined);
  assert.equal(classifyBashRisk("git push origin pi/task"), undefined);
  assert.equal(classifyBashRisk("git push --force-with-lease origin pi/task"), "force-push");
  assert.equal(classifyBashRisk("git -C /tmp/repo push -f origin pi/task"), "force-push");
  assert.equal(classifyBashRisk("gh pr merge 42 --squash"), "merge");
  assert.equal(classifyBashRisk("kubectl apply -f prod.yaml"), "deployment");
  assert.equal(classifyBashRisk("pnpm run deploy"), "deployment");
  assert.equal(classifyBashRisk("rm -rf build"), "destructive");
  assert.equal(isDestructiveLinearTool("linear_delete_issue"), true);
  assert.equal(isDestructiveLinearTool("linear_archive_project"), true);
  assert.equal(isDestructiveLinearTool("linear_update_issue"), false);
  assert.equal(isLinearMutationTool("linear_update_issue"), true);
  assert.equal(isLinearMutationTool("linear_get_issue"), false);
});

test("credential stores and real env files stay protected while templates remain readable", () => {
  assert.match(sensitivePathReason("/home/operator/.ssh/id_ed25519", "/home/operator") ?? "", /credential/);
  assert.match(sensitivePathReason("/repo/.env", "/home/operator") ?? "", /secret/);
  assert.equal(sensitivePathReason("/repo/.env.example", "/home/operator"), undefined);
  assert.equal(sensitivePathReason("/repo/src/config.ts", "/home/operator"), undefined);
  assert.match(sensitiveCommandReason("cat ~/.ssh/id_ed25519", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("printenv", "/home/operator") ?? "", /credential/);
  assert.equal(sensitiveCommandReason("cat .env.example", "/home/operator"), undefined);
  assert.equal(sensitiveCommandReason("npm test", "/home/operator"), undefined);
});
