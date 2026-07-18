import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export type BashRisk = "force-push" | "merge" | "deployment" | "production-mutation" | "destructive";

function compact(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyBashRisk(command: string): BashRisk | undefined {
  const value = compact(command);
  const pushCommands = [...value.matchAll(/\bgit(?:\s+(?:-C|-c)\s+\S+)*\s+push\b([^;&|]*)/gi)];
  if (pushCommands.some((match) => {
    const original = match[1];
    const args = original.replace(/["']/g, "").replace(/\\(?=\+)/g, "");
    return /--force(?:-with-lease|-if-includes)?|(?:^|\s)-f(?:\s|$)|(?:^|\s)\$*\+\S+/i.test(args)
      || /\$(?:\{|\(|[A-Za-z_])/.test(original);
  })) return "force-push";
  if (/\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\/merge(?:\s|$)/i.test(value)) return "merge";
  if (/\b(?:kubectl\s+(?:apply|delete|patch|replace|edit|scale)|helm\s+(?:install|upgrade|uninstall|rollback)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy)|fly(?:ctl)?\s+deploy|vercel\b[^\n]*--prod|railway\s+up|serverless\s+deploy|sam\s+deploy|cdk\s+deploy|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?::[\w-]+)?|(?:make|just)\s+deploy)\b/i.test(value)) {
    return "deployment";
  }
  if (/\b(?:aws|gcloud|az)\b[^\n]*\b(?:delete|terminate|update|put|create|deploy|set|remove)\b/i.test(value)) return "production-mutation";
  if (/\brm\s+[^\n]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive[^\n]*--force|--force[^\n]*--recursive)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)|\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdocker\s+system\s+prune\b/i.test(value)) {
    return "destructive";
  }
  return undefined;
}

export function isDestructiveLinearTool(toolName: string): boolean {
  return /^linear_(?:delete|archive|unarchive|remove|switch_workspace)(?:_|$)/i.test(toolName);
}

export function isLinearMutationTool(toolName: string): boolean {
  return /^linear_/i.test(toolName) && !/^linear_(?:list|get|search)_/i.test(toolName);
}

export function sensitiveCommandReason(command: string, home = homedir()): string | undefined {
  const value = command
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home)
    .replace(/~\//g, `${home}/`)
    .replaceAll("\\", "/");
  const privateRoots = ["/.ssh/", "/.aws/", "/.gnupg/", "/.config/gcloud/", "/.config/gh/hosts.yml", "/.pi/agent/auth.json"];
  if (privateRoots.some((root) => value.includes(root))) return "shell access to credential stores is blocked";
  const envPaths = value.match(/(?:^|[\s'"=])([^\s'";|]*\.env(?:\.[A-Za-z0-9_-]+)?)(?=$|[\s'";|])/g) ?? [];
  if (envPaths.some((match) => !/\.(?:example|sample|template)(?:\s|$)/i.test(match))) {
    return "shell access to secret environment files is blocked";
  }
  const environmentDump = [...value.matchAll(/(?:^|[;&|]\s*)(?:\/usr\/bin\/)?env\b([^;&|]*)/gi)].some((match) => {
    const args = match[1].trim().split(/\s+/).filter(Boolean);
    while (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args.shift();
    return args.length === 0 || args[0].startsWith("-");
  });
  if (/\bprintenv\b/i.test(value)
    || /(?:^|[;&|]\s*)(?:set|export(?:\s+-p)?|declare\s+-x|typeset\s+-x)\s*(?:$|[|>])/i.test(value)
    || /(?:^|\s)(?:\S*\/)?(?:bash|sh|zsh)\s+-c\s+[^;&|]*\b(?:env|set|export)\b/i.test(value)
    || environmentDump
    || /\$(?:\{)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)(?:\})?/i.test(value)) {
    return "commands that print credential-bearing environment values are blocked";
  }
  return undefined;
}

export async function sensitiveResolvedPathReason(path: string, home = homedir()): Promise<string | undefined> {
  const lexical = sensitivePathReason(path, home);
  if (lexical) return lexical;
  let cursor = resolve(path.replace(/^~/, home));
  const suffix: string[] = [];
  while (true) {
    try {
      const resolvedBase = await realpath(cursor);
      return sensitivePathReason(resolve(resolvedBase, ...suffix), home);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function sensitiveCommandResolvedPathReason(
  command: string,
  cwd: string,
  home = homedir(),
): Promise<string | undefined> {
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s;&|<>]+/g) ?? [];
  for (const raw of tokens) {
    let token = raw.replace(/^['"]|['"]$/g, "");
    if (token.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) token = token.slice(token.indexOf("=") + 1);
    if (!token || token.startsWith("-") || token.includes("$") || token.includes("*")) continue;
    const candidate = token.startsWith("/") || token.startsWith("~") ? token : resolve(cwd, token);
    const reason = await sensitiveResolvedPathReason(candidate, home);
    if (reason) return reason;
  }
  return undefined;
}

const READ_ONLY_COMMANDS = new Set([
  "[", "cat", "cd", "cmp", "command", "cut", "diff", "du", "echo", "false", "file", "find", "gh", "git",
  "grep", "head", "jq", "ls", "pwd", "rg", "sha256sum", "shasum", "sort", "stat", "tail", "test", "true",
  "type", "uniq", "wc", "which",
]);

function commandName(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return words[0]?.replace(/^['"]|['"]$/g, "");
}

export function readOnlyWorkerCommandReason(command: string): string | undefined {
  const value = command
    .replace(/\\\r?\n/g, " ")
    .replace(/\r?\n/g, ";")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return undefined;
  if (reviewMutationPattern(value)) return "review/research worker shell commands must be read-only";
  if (/(?:^|&&|\|\||[;|])\s*[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return "environment overrides are not allowed in read-only worker shell commands";
  if (/\$\(|`|<\(|>\(/.test(value)) return "command substitution is not allowed in read-only worker shell commands";
  if (/\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-f(?:print|printf|ls))\b/i.test(value)) return "mutating find actions are not allowed in read-only workers";
  if (/\b(?:sort|diff)\b[^;&|]*(?:\s-o(?:\S+|\s)|--output(?:=|\s))/i.test(value)) return "output files are not allowed in read-only workers";
  const segments = value.split(/&&|\|\||[;&|]/).map((part) => part.trim()).filter(Boolean);
  for (const segment of segments) {
    const name = commandName(segment);
    if (!name || !READ_ONLY_COMMANDS.has(name)) return `command ${name ?? "(unknown)"} is not in the read-only worker shell allowlist`;
    if (name === "command" && !/^command\s+-v\s+\S+$/i.test(segment)) return "only command -v is allowed in read-only workers";
    if (name === "git") {
      const match = segment.match(/\bgit\s+(?:(?:-C\s+\S+|--no-pager)\s+)*(\S+)/i);
      const subcommand = match?.[1]?.toLowerCase();
      if (!subcommand || !["diff", "status", "show", "log", "rev-parse", "merge-base", "ls-files", "grep"].includes(subcommand)) {
        return `git ${subcommand ?? "(unknown)"} is not read-only worker shell activity`;
      }
      if (/--(?:ext-diff|textconv|paginate|exec-path)|--open-files-in-pager|--output(?:=|\s)/i.test(segment)) return "git external helpers are not allowed in read-only workers";
    }
    if (name === "gh" && !/\bgh\s+(?:pr\s+(?:view|diff|checks|status)|run\s+(?:view|list)|repo\s+view)\b/i.test(segment)) {
      return "only read-only gh view/diff/check commands are allowed in review/research workers";
    }
  }
  return undefined;
}

function reviewMutationPattern(value: string): boolean {
  return /(?:^|[;&|]\s*|\b)(?:rm|mv|cp|touch|mkdir|rmdir|truncate|install|tee|dd)\b|\bsed\s+-i\b|\bperl\s+-p?i\b|\bgit\s+(?:add|commit|checkout|switch|reset|clean|restore|rebase|cherry-pick)\b|(?:^|[^<])>{1,2}(?!>)/i.test(value);
}

export function sensitivePathReason(path: string, home = homedir()): string | undefined {
  const absolute = resolve(path.replace(/^~/, home));
  const normalized = absolute.replaceAll("\\", "/");
  const homePath = resolve(home).replaceAll("\\", "/");
  const privateRoots = [
    `${homePath}/.ssh/`,
    `${homePath}/.aws/`,
    `${homePath}/.gnupg/`,
    `${homePath}/.config/gcloud/`,
    `${homePath}/.config/gh/hosts.yml`,
    `${homePath}/.pi/agent/auth.json`,
  ];
  if (privateRoots.some((root) => normalized === root.replace(/\/$/, "") || normalized.startsWith(root))) {
    return "credential store access is outside the worker boundary";
  }
  const name = normalized.split("/").at(-1) ?? "";
  if (/^\.env(?:\.[^.]+)?$/i.test(name) && !/\.(?:example|sample|template)$/i.test(name)) {
    return "secret environment files are protected; use an example/template instead";
  }
  if (/^(?:id_rsa|id_ed25519|credentials(?:\.json)?|service-account(?:\.json)?)$/i.test(name)) {
    return "credential files are protected";
  }
  return undefined;
}

export function riskDescription(risk: BashRisk): string {
  switch (risk) {
    case "force-push": return "Force-push is disabled. Use a normal push or ask the operator to resolve branch history explicitly.";
    case "merge": return "This command merges a pull request.";
    case "deployment": return "This command appears to deploy or mutate a runtime environment.";
    case "production-mutation": return "This command appears to mutate cloud or production resources.";
    case "destructive": return "This command performs a destructive local or data operation.";
  }
}
