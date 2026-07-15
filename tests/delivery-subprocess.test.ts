import assert from "node:assert/strict";
import test from "node:test";
import { StrictJsonlParser } from "../extensions/orchestration/delivery/jsonl.ts";
import { ArgvCommandRunner } from "../extensions/orchestration/delivery/command.ts";

test("strict JSONL parser handles chunking and does not split Unicode separators", () => {
  const values: Array<Record<string, unknown>> = []; const parser = new StrictJsonlParser((value) => values.push(value));
  parser.push('{"text":"a\u2028b"'); parser.push('}\n{"n":2}\r\n'); parser.finish();
  assert.deepEqual(values, [{ text: "a b" }, { n: 2 }]);
  assert.throws(() => new StrictJsonlParser(() => {}).push("not-json\n"), /Malformed/);
});
test("argv runner cancellation terminates a subprocess without a shell", async () => {
  const controller = new AbortController(); const pending = new ArgvCommandRunner().run(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { cwd: process.cwd(), signal: controller.signal });
  controller.abort(); const result = await pending; assert.notEqual(result.exitCode, 0);
});
