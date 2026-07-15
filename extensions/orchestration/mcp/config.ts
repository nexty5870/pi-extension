import { chmod, readFile } from "node:fs/promises";
import type { McpConfig, McpServerConfig, McpToolPolicy } from "../types.ts";

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function policyFrom(value: unknown, serverId: string): McpToolPolicy {
  if (!value || typeof value !== "object") throw new Error(`servers.${serverId}.policy is required`);
  const policy = value as Record<string, unknown>;
  return {
    read: stringArray(policy.read, `servers.${serverId}.policy.read`),
    write: stringArray(policy.write, `servers.${serverId}.policy.write`),
    destructive: stringArray(policy.destructive, `servers.${serverId}.policy.destructive`),
  };
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object of strings`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error(`${field} must contain only string values`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function serverFrom(serverId: string, value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`servers.${serverId} must be an object`);
  }
  const server = value as Record<string, unknown>;
  const policy = policyFrom(server.policy, serverId);
  if (server.linear !== undefined || /linear/i.test(serverId)) {
    throw new Error(`servers.${serverId}: Linear MCP configuration is deprecated; install npm:@alasano/pi-linear`);
  }

  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || !server.command.trim()) {
      throw new Error(`servers.${serverId}.command is required for stdio`);
    }
    return {
      transport: "stdio",
      command: server.command,
      args: server.args === undefined ? undefined : stringArray(server.args, `servers.${serverId}.args`),
      env: stringRecord(server.env, `servers.${serverId}.env`),
      cwd: typeof server.cwd === "string" ? server.cwd : undefined,
      policy,
    };
  }

  if (server.transport === "http") {
    if (typeof server.url !== "string" || !server.url.trim()) {
      throw new Error(`servers.${serverId}.url is required for http`);
    }
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error(`servers.${serverId}.url must be a valid URL`);
    }
    if (url.hostname === "mcp.linear.app" || url.hostname.endsWith(".linear.app")) {
      throw new Error(`servers.${serverId}: hosted Linear MCP is deprecated; install npm:@alasano/pi-linear`);
    }
    return {
      transport: "http",
      url: server.url,
      headers: stringRecord(server.headers, `servers.${serverId}.headers`),
      policy,
    };
  }

  throw new Error(`servers.${serverId}.transport must be "stdio" or "http"`);
}

export function parseMcpConfig(value: unknown): McpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP config must be an object");
  }
  const serversValue = (value as Record<string, unknown>).servers;
  if (!serversValue || typeof serversValue !== "object" || Array.isArray(serversValue)) {
    throw new Error("MCP config requires a servers object");
  }
  return {
    servers: Object.fromEntries(
      Object.entries(serversValue as Record<string, unknown>).map(([id, server]) => [id, serverFrom(id, server)]),
    ),
  };
}

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`MCP config not found: ${path}`);
    }
    throw error;
  }
  await chmod(path, 0o600);
  try {
    return parseMcpConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in MCP config: ${path}`);
    throw error;
  }
}
