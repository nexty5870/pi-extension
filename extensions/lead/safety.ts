import { homedir } from "node:os";
import { resolve } from "node:path";

export type BashRisk = "force-push" | "merge" | "deployment" | "production-mutation" | "destructive";

function compact(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyBashRisk(command: string): BashRisk | undefined {
  const value = compact(command);
  if (/\bgit(?:\s+(?:-C|-c)\s+\S+)*\s+push\b[^\n]*(?:--force(?:-with-lease|-if-includes)?|(?:^|\s)-f(?:\s|$))/i.test(value)) return "force-push";
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
  if (/^\s*(?:env|printenv|set)\s*$/i.test(value) || /\$(?:\{)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)(?:\})?/i.test(value)) {
    return "commands that print credential-bearing environment values are blocked";
  }
  return undefined;
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
