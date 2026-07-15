import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface ScoutUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ScoutResult {
  report: string;
  usage: ScoutUsage;
  model?: string;
  events: Array<Record<string, unknown>>;
}

const SCOUT_PROMPT = `You are a strictly read-only repository scout.
Investigate only the assigned question. Never modify files or repository state.
Return a compressed report with exact file paths, relevant symbols, architecture, risks, and a recommended starting point.
Do not claim to have run checks that are unavailable.`;

function invocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = process.execPath.split("/").pop()?.toLowerCase() ?? "";
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export async function runReadOnlyScout(
  cwd: string,
  task: string,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<ScoutResult> {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    "--append-system-prompt",
    SCOUT_PROMPT,
  ];
  if (options.model) args.push("--model", options.model);
  args.push(`Scout task: ${task}`);

  const command = invocation(args);
  const usage: ScoutUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const events: Array<Record<string, unknown>> = [];
  let report = "";
  let stderr = "";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let aborted = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const eventType = typeof event.type === "string" ? event.type : "unknown";
      if (["tool_execution_start", "tool_execution_end", "agent_settled", "extension_error"].includes(eventType)) {
        events.push(event);
      }
      if (eventType !== "message_end" || !event.message || typeof event.message !== "object") return;
      const message = event.message as AssistantMessage;
      if (message.role !== "assistant") return;
      usage.turns += 1;
      usage.input += message.usage?.input ?? 0;
      usage.output += message.usage?.output ?? 0;
      usage.cacheRead += message.usage?.cacheRead ?? 0;
      usage.cacheWrite += message.usage?.cacheWrite ?? 0;
      usage.cost += message.usage?.cost?.total ?? 0;
      const text = assistantText(message);
      if (text) report = text;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer) processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (aborted) return reject(new Error("Scout was aborted"));
      if (code !== 0) return reject(new Error(`Scout exited with code ${code}: ${stderr.trim()}`));
      if (!report) return reject(new Error(`Scout produced no report${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      resolve();
    });

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timer.unref();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });

  return { report, usage, model: options.model, events };
}
