import { spawn } from "node:child_process";

const GLOBAL_COOLDOWN_MS = 60_000;
let lastSoundAt = 0;
const recent = new Map<string, number>();

function run(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function appleScriptString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " "));
}

export function notifyActionRequired(
  title: string,
  message: string,
  deduplicationKey: string,
  now = Date.now(),
): void {
  const previous = recent.get(deduplicationKey);
  if (previous && now - previous < GLOBAL_COOLDOWN_MS) return;
  recent.set(deduplicationKey, now);

  if (process.platform !== "darwin") return;
  run("osascript", [
    "-e",
    `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`,
  ]);
  if (now - lastSoundAt >= GLOBAL_COOLDOWN_MS) {
    lastSoundAt = now;
    run("afplay", ["-v", "0.7", "/System/Library/Sounds/Glass.aiff"]);
  }
}
