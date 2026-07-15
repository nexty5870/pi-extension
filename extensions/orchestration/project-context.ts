import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { projectIdForRoot } from "./store.ts";
import type { ProjectContext } from "./types.ts";

const execFileAsync = promisify(execFile);

async function resolveGitRoot(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return result.stdout.trim();
  } catch {
    return cwd;
  }
}

export async function resolveProjectContext(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectContext> {
  const unresolvedRoot = await resolveGitRoot(cwd);
  const projectRoot = await realpath(unresolvedRoot).catch(() => unresolvedRoot);
  return {
    projectId: projectIdForRoot(projectRoot),
    projectRoot,
    projectName: basename(projectRoot),
    cmuxWorkspaceId: environment.CMUX_WORKSPACE_ID || undefined,
    cmuxSurfaceId: environment.CMUX_SURFACE_ID || undefined,
    cmuxSocketPath: environment.CMUX_SOCKET_PATH || undefined,
  };
}
