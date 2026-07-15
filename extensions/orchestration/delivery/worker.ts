import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
declare const __dirname: string;
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WorkerResult, WorkerRole } from "./types.ts";
import { StrictJsonlParser } from "./jsonl.ts";

function invocation(args: string[]) {
  const current = process.argv[1];
  if (current && !current.startsWith("/$bunfs/root/") && existsSync(current)) return { command: process.execPath, args: [current, ...args] };
  return { command: "pi", args };
}
function text(message: AssistantMessage): string { return message.content.filter((p) => p.type === "text").map((p) => p.type === "text" ? p.text : "").join("\n"); }

export async function runDeliveryWorker(role: WorkerRole, cwd: string, prompt: string, options: { signal?: AbortSignal; model?: string } = {}): Promise<WorkerResult> {
  const guard = join(__dirname, "worker-guard.ts");
  const tools = role === "implementer" ? "read,write,edit,grep,find,ls" : "read,grep,find,ls";
  const system = role === "implementer"
    ? "Implement only the assigned approved contract in this worktree. Do not commit, push, use GitHub/Linear, deploy, or access files outside the worktree."
    : "Independently review the exact current diff. Do not modify files. Return only strict JSON: {\"verdict\":\"approved\"|\"changes_requested\",\"diffHash\":\"...\",\"findings\":[\"...\"]}.";
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--approve", "-e", guard, "--tools", tools, "--append-system-prompt", system];
  if (options.model) args.push("--model", options.model); args.push(prompt);
  const call = invocation(args); let stderr = ""; let latest = "";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_DELIVERY_WORKTREE: cwd, PI_DELIVERY_ROLE: role };
    delete env.LINEAR_API_KEY;
    const child = spawn(call.command, call.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
    const parser = new StrictJsonlParser((event: any) => {
      if (event.type === "message_end" && event.message?.role === "assistant") { const m = event.message as AssistantMessage; latest = text(m) || latest; usage.turns++; usage.input += m.usage.input; usage.output += m.usage.output; usage.cacheRead += m.usage.cacheRead; usage.cacheWrite += m.usage.cacheWrite; usage.cost += m.usage.cost.total; }
    });
    child.stdout.on("data", (chunk: Buffer) => { try { parser.push(chunk.toString("utf8")); } catch (error) { child.kill("SIGTERM"); reject(error); } });
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk);
    child.on("error", reject); child.on("close", (code) => { try { parser.finish(); } catch (error) { reject(error); return; } if (code !== 0) reject(new Error(`Worker exited ${code}: ${stderr.trim()}`)); else if (!latest) reject(new Error("Worker produced no final response")); else resolve(); });
    const abort = () => { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000); timer.unref(); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  });
  return { text: latest, usage };
}
