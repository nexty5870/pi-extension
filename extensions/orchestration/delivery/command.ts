import { spawn } from "node:child_process";

export interface CommandResult { stdout: string; stderr: string; exitCode: number }
export interface CommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<CommandResult>;
}

export class ArgvCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let timedOut = false;
      child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString("utf8"));
      child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString("utf8"));
      child.on("error", reject);
      child.on("close", (code) => timedOut
        ? reject(new Error(`${command} timed out`))
        : resolve({ stdout, stderr, exitCode: code ?? 1 }));
      const terminate = () => {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5_000); force.unref();
      };
      const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs) : undefined;
      timer?.unref();
      child.once("close", () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", terminate); });
      if (options.signal?.aborted) terminate(); else options.signal?.addEventListener("abort", terminate, { once: true });
    });
  }
}

export async function checked(runner: CommandRunner, command: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const result = await runner.run(command, args, { cwd, timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}
