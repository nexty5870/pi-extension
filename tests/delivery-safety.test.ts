import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertContainedPath, assertWorkerTool, diffHash, scanPublicFiles } from "../extensions/orchestration/delivery/safety.ts";
import { parseReviewerResult } from "../extensions/orchestration/delivery/reviewer.ts";

test("worker guard denies traversal, symlink escape, sensitive paths, shell publication, and Linear", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-guard-")); const outside = await mkdtemp(join(tmpdir(), "outside-"));
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "ok.ts"), "ok"); await symlink(outside, join(root, "escape"));
  assert.equal(await assertContainedPath(root, "src/ok.ts"), join(root, "src", "ok.ts"));
  await assert.rejects(() => assertContainedPath(root, "../outside"), /escapes/);
  await assert.rejects(() => assertContainedPath(root, "escape"), /Symlink escapes/);
  await assert.rejects(() => assertContainedPath(root, ".env"), /Sensitive/);
  assert.throws(() => assertWorkerTool("implementer", "linear_get_issue", {}), /Linear/);
  assert.throws(() => assertWorkerTool("implementer", "bash", { command: "git push origin main" }), /restricted/);
  assert.doesNotThrow(() => assertWorkerTool("implementer", "bash", { command: "pnpm --filter @makeautomation/shared typecheck" }));
  assert.doesNotThrow(() => assertWorkerTool("implementer", "bash", { command: "pnpm install --frozen-lockfile" }));
  assert.throws(() => assertWorkerTool("implementer", "bash", { command: "pnpm publish" }), /restricted/);
  assert.throws(() => assertWorkerTool("reviewer", "edit", {}), /cannot modify/);
});
test("public scanner catches credentials, private paths, and limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-scan-"));
  await writeFile(join(root, "secret.txt"), ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_"));
  await writeFile(join(root, "path.txt"), `see /${"Users"}/example/private/file`);
  const findings = await scanPublicFiles(root, ["secret.txt", "path.txt"]); assert.equal(findings.length, 2);
  assert.equal((await scanPublicFiles(root, ["a", "b"], { maxFiles: 1 }))[0]?.reason, "file count exceeds publication limit");
});
test("review parser requires strict JSON and exact diff hash", () => {
  const hash = diffHash("diff"); assert.equal(parseReviewerResult(JSON.stringify({ verdict: "approved", diffHash: hash, findings: [] }), hash).verdict, "approved");
  assert.throws(() => parseReviewerResult("yes", hash), /valid JSON/);
  assert.throws(() => parseReviewerResult(JSON.stringify({ verdict: "approved", diffHash: "wrong", findings: [] }), hash), /does not match/);
});
