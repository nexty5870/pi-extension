import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package enables V2 Lead workflow and leaves legacy orchestration unloaded", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    pi: { extensions: string[]; skills: string[] };
  };
  assert.deepEqual(manifest.pi.extensions, ["./extensions/update.ts", "./extensions/lead/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills/lead-orchestration"]);
  assert.ok(!manifest.pi.extensions.some((path) => path.includes("extensions/orchestration")));
  assert.ok(!manifest.pi.skills.some((path) => path.includes("team-orchestration")));
});
