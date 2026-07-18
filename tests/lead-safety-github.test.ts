import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyPullRequest } from "../extensions/lead/github.ts";
import {
  classifyBashRisk,
  isDestructiveLinearTool,
  isLinearMutationTool,
  normalizePiToolPath,
  readOnlyWorkerCommandReason,
  sensitiveCommandReason,
  sensitiveCommandResolvedPathReason,
  sensitivePathReason,
  sensitiveResolvedPathReason,
} from "../extensions/lead/safety.ts";

test("GitHub observations distinguish pending, failed, green, and merged", () => {
  const open = { url: "https://github.com/example/repo/pull/1", state: "OPEN", headRefOid: "abc123" };
  assert.equal(classifyPullRequest({
    ...open,
    statusCheckRollup: [{ name: "test", status: "IN_PROGRESS", conclusion: "" }],
  }).status, "pending");
  const failed = classifyPullRequest({
    ...open,
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /test/);
  assert.equal(classifyPullRequest({
    ...open,
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  }).status, "green");
  assert.equal(classifyPullRequest({
    url: open.url,
    state: "MERGED",
    headRefOid: "abc123",
    statusCheckRollup: [],
  }).status, "merged");
  assert.equal(classifyPullRequest({ url: open.url, state: "MERGED", statusCheckRollup: [] }).status, "pending");
  assert.equal(classifyPullRequest({ ...open, statusCheckRollup: [] }).status, "green");
  assert.equal(classifyPullRequest({ ...open, isDraft: true, statusCheckRollup: [] }).status, "pending");
  assert.equal(classifyPullRequest({
    url: open.url,
    state: "CLOSED",
    statusCheckRollup: [],
  }).status, "failed");
  assert.equal(classifyPullRequest({ ...open, headRefOid: undefined, statusCheckRollup: [] }).status, "pending");
  assert.equal(classifyPullRequest({ ...open, statusCheckRollup: null }).status, "pending");
  assert.equal(classifyPullRequest({ url: open.url, headRefOid: "abc123", statusCheckRollup: [] }).status, "pending");
});

test("V2 gates only clear dangerous boundaries instead of disabling normal shell work", () => {
  assert.equal(classifyBashRisk("npm test && git status"), undefined);
  assert.equal(classifyBashRisk("git push origin pi/task"), undefined);
  assert.equal(classifyBashRisk("git push --force-with-lease origin pi/task"), "force-push");
  assert.equal(classifyBashRisk("git -C /tmp/repo push -f origin pi/task"), "force-push");
  assert.equal(classifyBashRisk("git push origin +HEAD:main"), "force-push");
  assert.equal(classifyBashRisk("git push origin '+HEAD:main'"), "force-push");
  assert.equal(classifyBashRisk("git push origin main; git push --force origin main"), "force-push");
  assert.equal(classifyBashRisk("git push origin $REFSPEC"), "force-push");
  assert.equal(classifyBashRisk("\"git\" push --force origin HEAD:main"), "force-push");
  assert.equal(classifyBashRisk("git --no-pager push --force origin HEAD:main"), "force-push");
  assert.equal(classifyBashRisk("gh pr merge 42 --squash"), "merge");
  assert.equal(classifyBashRisk("\"gh\" pr merge 42 --squash"), "merge");
  assert.equal(classifyBashRisk("kubectl apply -f prod.yaml"), "deployment");
  assert.equal(classifyBashRisk("\"kubectl\" apply -f prod.yaml"), "deployment");
  assert.equal(classifyBashRisk("pnpm run deploy"), "deployment");
  assert.equal(classifyBashRisk("rm -rf build"), "destructive");
  assert.equal(isDestructiveLinearTool("linear_delete_issue"), true);
  assert.equal(isDestructiveLinearTool("linear_archive_project"), true);
  assert.equal(isDestructiveLinearTool("linear_update_issue"), false);
  assert.equal(isLinearMutationTool("linear_update_issue"), true);
  assert.equal(isLinearMutationTool("linear_get_issue"), false);
});

test("credential stores and real env files stay protected while templates remain readable", async () => {
  assert.equal(normalizePiToolPath("@/home/operator/.ssh/config", "/repo"), "/home/operator/.ssh/config");
  assert.equal(normalizePiToolPath("@./src/file.ts", "/repo"), "/repo/src/file.ts");
  assert.match(sensitivePathReason("/home/operator/.ssh/id_ed25519", "/home/operator") ?? "", /credential/);
  assert.match(sensitivePathReason("/repo/.env", "/home/operator") ?? "", /secret/);
  assert.equal(sensitivePathReason("/repo/.env.example", "/home/operator"), undefined);
  assert.equal(sensitivePathReason("/repo/src/config.ts", "/home/operator"), undefined);
  assert.match(sensitiveCommandReason("cat ~/.ssh/id_ed25519", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("printenv", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("printenv OPENAI_API_KEY", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("sh -c printenv", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("bash -c env", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("/bin/sh -c env", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("python -c 'import os; print(os.environ)'", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("python -c 'import os; print(os.getenv(\"OPENAI_API_KEY\"))'", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("ruby -e 'puts ENV[\"OPENAI_API_KEY\"]'", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("node -e 'console.log(process[\"env\"])'", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("eval env", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("env | sort", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("env -0", "/home/operator") ?? "", /credential/);
  assert.match(sensitiveCommandReason("export", "/home/operator") ?? "", /credential/);
  assert.equal(sensitiveCommandReason("env NODE_ENV=test npm test", "/home/operator"), undefined);
  assert.equal(sensitiveCommandReason("cat .env.example", "/home/operator"), undefined);
  assert.equal(sensitiveCommandReason("npm test", "/home/operator"), undefined);

  const root = await mkdtemp(join(tmpdir(), "lead-sensitive-link-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(repo);
  const key = join(home, ".ssh", "id_ed25519");
  await writeFile(key, "private");
  await symlink(key, join(repo, "innocent.txt"));
  await mkdir(join(repo, "subdir"));
  await symlink(key, join(repo, "subdir", "innocent.txt"));
  assert.match(await sensitiveResolvedPathReason(join(repo, "innocent.txt"), home) ?? "", /credential/);
  assert.match(await sensitiveCommandResolvedPathReason("cat innocent.txt", repo, home) ?? "", /credential/);
  assert.match(await sensitiveCommandResolvedPathReason("cd subdir && cat innocent.txt", repo, home) ?? "", /credential/);
});

test("review and research shell is an explicit read-only allowlist", () => {
  assert.equal(readOnlyWorkerCommandReason("git diff --stat && rg -n TODO src"), undefined);
  assert.equal(readOnlyWorkerCommandReason("gh pr view 17"), undefined);
  assert.match(readOnlyWorkerCommandReason("python -c 'open(\"x\",\"w\").write(\"x\")'") ?? "", /not in/);
  assert.match(readOnlyWorkerCommandReason("node -e 'require(\"fs\").writeFileSync(\"x\",\"x\")'") ?? "", /not in/);
  assert.match(readOnlyWorkerCommandReason("find . -delete") ?? "", /find/);
  assert.match(readOnlyWorkerCommandReason("git branch new-name") ?? "", /not read-only/);
  assert.match(readOnlyWorkerCommandReason("GIT_EXTERNAL_DIFF='touch x' git diff") ?? "", /read-only|environment overrides/);
  assert.match(readOnlyWorkerCommandReason("command rm -f file") ?? "", /read-only|command -v/);
  assert.match(readOnlyWorkerCommandReason("find . -fprint output.txt") ?? "", /find/);
  assert.match(readOnlyWorkerCommandReason("rg needle --pre 'python -c pass' .") ?? "", /preprocessor/);
  assert.match(readOnlyWorkerCommandReason("echo ok\nchmod 777 target") ?? "", /chmod/);
  assert.match(readOnlyWorkerCommandReason("echo ok & chmod 777 target") ?? "", /chmod/);
});
