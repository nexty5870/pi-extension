import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { shellQuote } from "./cmux.ts";
import type { TaskRecord } from "./types.ts";

export interface PiInvocation {
  command: string;
  leadingArgs: string[];
}

export function currentPiInvocation(
  argv: string[] = process.argv,
  execPath = process.execPath,
): PiInvocation {
  const script = argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: execPath, leadingArgs: [script] };
  }
  const executable = basename(execPath).toLowerCase();
  if (!/^(?:node|bun)(?:\.exe)?$/.test(executable)) return { command: execPath, leadingArgs: [] };
  return { command: "pi", leadingArgs: [] };
}

function exportLine(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

export function renderLaunchScript(input: {
  task: TaskRecord;
  stateDir: string;
  projectRoot: string;
  promptPath: string;
  invocation: PiInvocation;
  extensionPath?: string;
  model?: string;
  thinking?: string;
}): string {
  const { task } = input;
  const args = [
    ...input.invocation.leadingArgs,
    "--approve",
    "--session-id",
    task.sessionId,
    "--name",
    `${task.role === "review" ? "Review" : task.role === "research" ? "Research" : "Worker"} · ${task.brief.title}`,
    "--append-system-prompt",
    input.promptPath,
  ];
  if (input.extensionPath) args.push("--extension", input.extensionPath);
  if (input.model) args.push("--model", input.model);
  if (input.thinking && input.thinking !== "off") args.push("--thinking", input.thinking);
  if (task.role === "review" || task.role === "research") {
    args.push("--tools", "read,bash,grep,find,ls,lead_worker_report");
  }
  args.push(`Begin the assigned ${task.role} task now. Keep the Lead updated with lead_worker_report.`);
  const command = [input.invocation.command, ...args].map(shellQuote).join(" ");

  return [
    "#!/bin/sh",
    "set -eu",
    `cd ${shellQuote(task.worktreePath)}`,
    exportLine("PI_LEAD_TASK_ID", task.id),
    exportLine("PI_LEAD_PROJECT_ID", task.projectId),
    exportLine("PI_LEAD_STATE_DIR", input.stateDir),
    exportLine("PI_LEAD_ROLE", task.role),
    exportLine("PI_LEAD_PROJECT_ROOT", input.projectRoot),
    exportLine("PI_LEAD_WORKTREE", task.worktreePath),
    `exec ${command}`,
    "",
  ].join("\n");
}

export async function writeLaunchScript(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}
