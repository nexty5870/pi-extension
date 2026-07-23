import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderLaunchScript, writeLaunchScript } from "../extensions/lead/launcher.ts";
import type { TaskRecord } from "../extensions/lead/types.ts";
import { selectLeadWorkflow } from "../extensions/lead/workflow.ts";

const execFileAsync = promisify(execFile);

test("Lead workflow selection defaults to V4 with explicit and legacy V2 compatibility", () => {
  assert.equal(selectLeadWorkflow({}), "v4");
  assert.equal(selectLeadWorkflow({ PI_LEAD_V4: "1" }), "v4");
  assert.equal(selectLeadWorkflow({ PI_LEAD_V4: "0" }), "v2");
  assert.equal(selectLeadWorkflow({ PI_LEAD_TASK_ID: "legacy-task", PI_LEAD_PROJECT_ID: "legacy-project" }), "v2");
  assert.equal(selectLeadWorkflow({ PI_LEAD_TASK_ID: "incomplete-identity" }), "v4");
  assert.equal(selectLeadWorkflow({ PI_LEAD_V4: "1", PI_LEAD_TASK_ID: "task", PI_LEAD_PROJECT_ID: "project" }), "v4");
});

test("default V4 routing boundary precedes every V2 runtime initialization", async () => {
  const source = await readFile("extensions/lead/index.ts", "utf8");
  const boundary = source.indexOf('if (selectLeadWorkflow(process.env) === "v4") return leadV4Extension(pi);');
  assert.ok(boundary >= 0);
  for (const v2Initialization of [
    "const workerTaskId = process.env.PI_LEAD_TASK_ID",
    "const store = new LeadStore",
    "const coordinator = new LeadCoordinator",
    "setInterval(",
  ]) {
    const position = source.indexOf(v2Initialization);
    assert.ok(position > boundary, `${v2Initialization} must remain after the workflow boundary`);
  }
});

test("V2 launch scripts durably fence child and resume processes into V2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-lead-v2-selector-"));
  const capturePath = join(directory, "environment.txt");
  const commandPath = join(directory, "capture-environment.sh");
  const launchPath = join(directory, "launch-worker.sh");
  await writeFile(commandPath, [
    "#!/bin/sh",
    "printf '%s\\n' \"$PI_LEAD_V4\" \"$PI_LEAD_TASK_ID\" \"$PI_LEAD_PROJECT_ID\" > \"$CAPTURE_PATH\"",
    "",
  ].join("\n"), { mode: 0o700 });
  const now = new Date().toISOString();
  const task: TaskRecord = {
    schemaVersion: 2,
    id: "task-v2",
    projectId: "project-v2",
    role: "implementation",
    brief: { title: "V2 propagation", task: "capture environment", acceptanceCriteria: [] },
    status: "starting",
    worktreePath: directory,
    sessionId: "session-v2",
    checks: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeLaunchScript(launchPath, renderLaunchScript({
    task,
    stateDir: join(directory, "state"),
    projectRoot: directory,
    promptPath: join(directory, "assignment.md"),
    invocation: { command: commandPath, leadingArgs: [] },
  }));

  await execFileAsync(launchPath, [], { env: { ...process.env, CAPTURE_PATH: capturePath } });
  assert.deepEqual((await readFile(capturePath, "utf8")).trim().split("\n"), ["0", "task-v2", "project-v2"]);
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
