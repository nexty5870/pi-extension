import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

test("V4 opt-in returns before every V2 timer/mutation path", async () => {
  const source = await readFile("extensions/lead/index.ts", "utf8");
  const boundary = source.indexOf('if (process.env.PI_LEAD_V4 === "1") return leadV4Extension(pi);');
  const firstV2Identity = source.indexOf("const workerTaskId = process.env.PI_LEAD_TASK_ID");
  assert.ok(boundary >= 0 && boundary < firstV2Identity);
});

test("checked-in production supervisor runtime needs no tsx and is rebuilt explicitly", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  const runtime = await readFile("extensions/lead-v4/runtime/supervisor.mjs", "utf8");
  assert.match(manifest.scripts["build:v4-supervisor"], /esbuild/);
  assert.ok((await stat("extensions/lead-v4/runtime/supervisor.mjs")).size > 10_000);
  assert.doesNotMatch(runtime, /(?:from|require\()["']tsx/);
});

test("V4 Pi lifecycle fences stale instances and blocks worker session replacement", async () => {
  const source = await readFile("extensions/lead-v4/client-extension.ts", "utf8");
  assert.match(source, /const instanceGeneration = randomUUID\(\)/);
  assert.match(source, /active\s*&&\s*session/);
  assert.match(source, /session_before_switch/);
  assert.match(source, /session_before_fork/);
  assert.match(source, /session\.sessionId === ctx\.sessionManager\.getSessionId\(\)/);
});

test("replacement feature claim immediately requests an all-pending telemetry digest", async () => {
  const source = await readFile("extensions/lead-v4/client-extension.ts", "utf8");
  const claim = source.slice(source.indexOf('name: "lead_v4_claim_feature"'), source.indexOf('name: "lead_v4_status"'));
  assert.match(claim, /await rpc\("claimFeature"/);
  assert.match(claim, /await deliverDigest\(ctx, true, false, true\)/);
});

test("V4 has no cmux close command or in_window liveness dependency", async () => {
  const runtime = await readFile("extensions/lead-v4/runtime-adapter.ts", "utf8");
  const client = await readFile("extensions/lead-v4/client-extension.ts", "utf8");
  assert.doesNotMatch(runtime, /close-surface/);
  assert.doesNotMatch(runtime, /in_window/);
  assert.match(client, /if \(\["completed", "failed", "stopped"\]\.includes\(task\.status\)\) ctx\.shutdown\(\)/);
  assert.match(client, /Detach only\. V4 never calls ctx\.shutdown for a Lead/);
});

test("durable launch failpoints cover every irreversible boundary", async () => {
  const source = await readFile("extensions/lead-v4/runtime-adapter.ts", "utf8");
  for (const failpoint of [
    "before-agents-workspace-create",
    "after-agents-workspace-create-before-record",
    "after-agents-workspace-record",
    "before-worktree-create",
    "after-worktree-create-before-record",
    "before-worker-surface-create",
    "after-worker-surface-create-before-record",
    "after-worker-surface-record-before-send",
    "after-worker-send-before-enter",
    "after-worker-enter-before-hello",
    "before-lead-workspace-create",
    "after-lead-workspace-create-before-record",
  ]) assert.match(source, new RegExp(failpoint));
});
