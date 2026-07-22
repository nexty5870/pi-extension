import assert from "node:assert/strict";
import test from "node:test";
import { CmuxWorkers, shellQuote } from "../extensions/lead/cmux.ts";
import type { CommandExecutor } from "../extensions/lead/git.ts";
import type { ProjectRecord } from "../extensions/lead/types.ts";

class FakeExecutor {
  calls: Array<{ command: string; args: string[] }> = [];
  paneExists = false;
  nextSurface = 2;
  malformedHealth = false;

  execute: CommandExecutor = async (command, args) => {
    this.calls.push({ command, args });
    if (args[0] === "list-panes") {
      return { stdout: JSON.stringify({ panes: this.paneExists ? [{ ref: "pane:p2", surface_refs: ["surface:s2"] }] : [{ ref: "pane:caller" }] }), stderr: "", code: 0 };
    }
    if (args[0] === "list-pane-surfaces") {
      return { stdout: JSON.stringify({ surfaces: this.paneExists ? [{ ref: "surface:s2" }] : [] }), stderr: "", code: 0 };
    }
    if (args[0] === "surface-health") {
      return { stdout: this.malformedHealth ? "not-json" : JSON.stringify({ surfaces: this.paneExists ? [{ ref: "surface:s2", in_window: true }] : [] }), stderr: "", code: 0 };
    }
    if (args[0] === "new-pane") {
      this.paneExists = true;
      return { stdout: "pane:p2 surface:s2", stderr: "", code: 0 };
    }
    if (args[0] === "new-surface") {
      this.nextSurface++;
      return { stdout: `surface:s${this.nextSurface}`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

const project: ProjectRecord = {
  schemaVersion: 2,
  projectId: "project-1",
  projectRoot: "/tmp/example",
  projectName: "example",
  cmux: { workspaceId: "workspace:w1", callerSurfaceId: "surface:caller" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("V2 cmux workers use one helper pane, visible Pi surfaces, and never steal focus", async () => {
  const fake = new FakeExecutor();
  const cmux = new CmuxWorkers(fake.execute, "/tmp/example", "workspace:w1");
  const first = await cmux.createSurface(project, "Worker · one", "/tmp/worktree one");
  assert.deepEqual(first.surface, { workspaceId: "workspace:w1", paneId: "pane:p2", surfaceId: "surface:s2" });
  const second = await cmux.createSurface({ ...project, cmux: { ...project.cmux!, helperPaneId: "pane:p2" } }, "Review · one", "/tmp/worktree one");
  assert.equal(second.surface.paneId, "pane:p2");
  assert.equal(second.surface.surfaceId, "surface:s3");

  await cmux.launch(second.surface.surfaceId, "/tmp/a path/launch.sh");
  const topology = await cmux.topology();
  assert.ok(topology.paneIds.has("pane:p2"));
  assert.equal(topology.health.get("surface:s2"), "healthy");
  await cmux.closeSurface("surface:s3");
  const cmuxCalls = fake.calls.filter((call) => call.command === "cmux").map((call) => call.args);
  assert.ok(cmuxCalls.every((args) => args.includes("workspace:w1")));
  assert.ok(cmuxCalls.filter((args) => args[0] === "new-pane" || args[0] === "new-surface").every((args) => args.includes("false")));
  assert.ok(cmuxCalls.every((args) => !["select-workspace", "focus-pane", "focus-panel"].includes(args[0])));
  assert.ok(cmuxCalls.some((args) => args[0] === "close-surface" && args.includes("surface:s3")));
  assert.ok(cmuxCalls.some((args) => JSON.stringify(args) === JSON.stringify(["surface-health", "--workspace", "workspace:w1", "--json"])));
  assert.ok(cmuxCalls.some((args) => args[0] === "send" && args.at(-1) === "exec '/tmp/a path/launch.sh'"));
});

test("malformed cmux health JSON fails closed instead of returning an empty topology", async () => {
  const fake = new FakeExecutor();
  fake.paneExists = true;
  fake.malformedHealth = true;
  const cmux = new CmuxWorkers(fake.execute, "/tmp/example", "workspace:w1");
  await assert.rejects(() => cmux.topology(), /surface-health returned invalid JSON/);
});

test("cmux focus occurs only through the explicit focus method", async () => {
  const fake = new FakeExecutor();
  const cmux = new CmuxWorkers(fake.execute, "/tmp/example", "workspace:w1");
  await cmux.flash("surface:s2");
  assert.equal(fake.calls.some((call) => call.args[0] === "focus-panel"), false);
  await cmux.focusSurface("surface:s2");
  assert.ok(fake.calls.some((call) => call.args[0] === "focus-panel" && call.args.includes("surface:s2")));
});

test("shell quoting is safe for generated launch paths", () => {
  assert.equal(shellQuote("/tmp/worker's path"), "'/tmp/worker'\"'\"'s path'");
});
