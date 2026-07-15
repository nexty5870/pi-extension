import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-self-update";
const UPDATE_NOTICE_ENV = "PI_EXTENSION_UPDATE_NOTICE";
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const CONFIRMATION_DURATION_MS = 12_000;

function tail(value: string, maxLength = 1600): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `…${trimmed.slice(-maxLength)}`;
}

function environmentForExec(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function readVersion(
  pi: ExtensionAPI,
  cliPath: string,
): Promise<string | undefined> {
  const result = await pi.exec(process.execPath, [cliPath, "--version"], {
    timeout: 30_000,
  });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function updateNotice(
  beforeVersion: string | undefined,
  afterVersion: string | undefined,
  forced: boolean,
): string {
  if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
    return `Pi updated successfully: ${beforeVersion} → ${afterVersion}`;
  }
  if (afterVersion && forced) {
    return `Pi reinstalled successfully: ${afterVersion}`;
  }
  if (afterVersion) {
    return `Pi is already up to date: ${afterVersion}`;
  }
  return "Pi update completed successfully";
}

export default function updateExtension(pi: ExtensionAPI) {
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", (_event, ctx) => {
    const notice = process.env[UPDATE_NOTICE_ENV];
    if (!notice) return;

    // The notice is only for the first session_start after process replacement.
    delete process.env[UPDATE_NOTICE_ENV];
    ctx.ui.notify(notice, "info");
    ctx.ui.setStatus(STATUS_KEY, notice);

    confirmationTimer = setTimeout(() => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      confirmationTimer = undefined;
    }, CONFIRMATION_DURATION_MS);
  });

  pi.on("session_shutdown", () => {
    if (confirmationTimer) clearTimeout(confirmationTimer);
    confirmationTimer = undefined;
  });

  pi.registerCommand("update", {
    description: "Update Pi to the latest version and restart this TUI session",
    getArgumentCompletions: (prefix) => {
      const options = ["force"];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length > 0
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (rawArgs, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/update is only available in interactive TUI mode", "warning");
        return;
      }

      if (typeof process.execve !== "function") {
        ctx.ui.notify(
          "/update requires Node.js with process.execve() support (Node 22.15+)",
          "error",
        );
        return;
      }

      const argument = rawArgs.trim().toLowerCase();
      if (argument && argument !== "force") {
        ctx.ui.notify("Usage: /update [force]", "warning");
        return;
      }

      const cliArgument = process.argv[1];
      if (!cliArgument) {
        ctx.ui.notify("Cannot locate the running Pi CLI entrypoint", "error");
        return;
      }

      const cliPath = resolve(cliArgument);
      const sessionFile = ctx.sessionManager.getSessionFile();
      const beforeVersion = await readVersion(pi, cliPath);
      const updateArgs = [cliPath, "update", "--self"];
      if (argument === "force") updateArgs.push("--force");

      ctx.ui.setStatus(
        STATUS_KEY,
        `updating Pi${beforeVersion ? ` ${beforeVersion}` : ""}…`,
      );
      ctx.ui.notify("Updating Pi. The TUI will restart automatically…", "info");

      const result = await pi.exec(process.execPath, updateArgs, {
        timeout: UPDATE_TIMEOUT_MS,
      });

      if (result.code !== 0 || result.killed) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        const detail = tail([result.stderr, result.stdout].filter(Boolean).join("\n"));
        ctx.ui.notify(
          `Pi update failed${detail ? `:\n${detail}` : ` (exit ${result.code})`}`,
          "error",
        );
        return;
      }

      const afterVersion = await readVersion(pi, cliPath);
      const notice = updateNotice(
        beforeVersion,
        afterVersion,
        argument === "force",
      );

      ctx.ui.setStatus(STATUS_KEY, `${notice}; restarting…`);
      ctx.ui.notify(`${notice}. Restarting TUI…`, "info");

      // Capture everything needed before reload: command contexts are stale once
      // ctx.reload() replaces the extension runtime. The one-time environment
      // notice lets the new TUI confirm the result after process replacement.
      const restartArguments = [process.execPath, cliPath];
      if (sessionFile) restartArguments.push("--session", sessionFile);
      const restartEnvironment = environmentForExec();
      restartEnvironment[UPDATE_NOTICE_ENV] = notice;

      // Run Pi's normal reload lifecycle first so extensions receive
      // session_shutdown and can clean up resources. Then replace this process
      // image with the newly installed Pi while retaining the same PID/terminal.
      await ctx.reload();

      process.execve(
        process.execPath,
        restartArguments,
        restartEnvironment,
      );
    },
  });
}
