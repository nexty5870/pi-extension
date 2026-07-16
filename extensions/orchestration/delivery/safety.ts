import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519|.*\.(?:pem|p12|key))$/i;
const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{24,})/;
const PRIVATE_PATH = /(?:^|["'\s])\/(?:Users|home)\/[A-Za-z0-9._-]+\//;

export function diffHash(diff: string): string { return `sha256:${createHash("sha256").update(diff).digest("hex")}`; }
export function isSensitivePath(path: string): boolean { return SENSITIVE.test(path.replaceAll("\\", "/")); }

export async function assertContainedPath(root: string, candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) candidate = resolve(root, candidate);
  const canonicalRoot = await realpath(root);
  const parent = await realpath(resolve(candidate, "..")).catch(() => resolve(candidate, ".."));
  const rel = relative(canonicalRoot, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes the canonical worktree");
  const stat = await lstat(candidate).catch(() => undefined);
  if (stat?.isSymbolicLink()) {
    const target = await realpath(candidate);
    const targetRel = relative(canonicalRoot, target);
    if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) throw new Error("Symlink escapes the canonical worktree");
  }
  const rootRelative = relative(canonicalRoot, candidate).replaceAll("\\", "/");
  if (isSensitivePath(rootRelative)) throw new Error(`Sensitive path is denied: ${rootRelative}`);
  return candidate;
}

export interface ScanFinding { path: string; reason: string }
export async function scanPublicFiles(root: string, paths: string[], options: { maxFiles?: number; maxBytes?: number } = {}): Promise<ScanFinding[]> {
  if (paths.length > (options.maxFiles ?? 500)) return [{ path: "*", reason: "file count exceeds publication limit" }];
  const findings: ScanFinding[] = [];
  for (const path of paths) {
    if (isSensitivePath(path)) { findings.push({ path, reason: "sensitive filename" }); continue; }
    const absolute = await assertContainedPath(root, path);
    const content = await readFile(absolute).catch(() => undefined);
    if (!content) continue;
    if (content.byteLength > (options.maxBytes ?? 2_000_000)) { findings.push({ path, reason: "file exceeds publication size limit" }); continue; }
    const text = content.toString("utf8");
    if (SECRET.test(text)) findings.push({ path, reason: "possible credential" });
    if (PRIVATE_PATH.test(text)) findings.push({ path, reason: "private absolute path" });
  }
  return findings;
}

export function assertWorkerTool(role: "implementer" | "reviewer", toolName: string, input: Record<string, unknown>): void {
  if (toolName.startsWith("linear_")) throw new Error("Workers cannot access Linear");
  if (["mcp_call", "mcp_list_servers", "mcp_list_tools"].includes(toolName)) throw new Error("Workers cannot access orchestration credentials");
  if (toolName === "bash") {
    const command = String(input.command ?? "").trim();
    if (/[;&|`$<>\n\r]/.test(command) || /(?:^|\s)(?:cd|pushd|popd)\s|(?:^|\s)(?:\/|\.\.\/)/.test(command)) throw new Error("Worker shell syntax can escape the worktree");
    const gitInspection = /^git\s+(?:status|diff|show)(?:\s|$)/.test(command);
    const npmValidation = /^npm\s+(?:test|run\s+[A-Za-z0-9:._-]+)(?:\s+--(?:\s+.*)?)?$/.test(command);
    const pnpmValidation = /^pnpm\s+(?:(?:test|lint|typecheck|build)|run\s+[A-Za-z0-9:._-]+|--filter\s+[@A-Za-z0-9/._-]+\s+(?:test|lint|typecheck|build))(?:\s+--(?:\s+.*)?)?$/.test(command);
    const pnpmInstall = /^pnpm\s+install\s+--frozen-lockfile$/.test(command);
    if (!gitInspection && !npmValidation && !pnpmValidation && !pnpmInstall) {
      throw new Error(`${role} shell is restricted to read-only Git inspection and npm/pnpm validation`);
    }
  }
  if (role === "reviewer" && ["write", "edit"].includes(toolName)) throw new Error("Reviewer cannot modify files");
}
