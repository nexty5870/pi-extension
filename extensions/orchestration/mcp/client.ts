import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpConfig,
  McpOperationClass,
  McpPolicyContext,
  McpServerConfig,
} from "../types.ts";
import { authorizeMcpCall, classifyMcpTool } from "./policy.ts";

interface ConnectedServer {
  client: Client;
  transport: Transport;
}

export interface ListedMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  operation: McpOperationClass;
}

export interface McpDenial {
  serverId: string;
  toolName: string;
  operation: McpOperationClass;
  reason: string;
  args: Record<string, unknown>;
}

export class McpManager {
  private readonly connections = new Map<string, ConnectedServer>();

  constructor(
    readonly config: McpConfig,
    private readonly onDenied?: (denial: McpDenial) => Promise<void> | void,
  ) {}

  listServers(): Array<{ id: string; transport: "stdio" | "http"; connected: boolean }> {
    return Object.entries(this.config.servers).map(([id, server]) => ({
      id,
      transport: server.transport,
      connected: this.connections.has(id),
    }));
  }

  getServerConfig(serverId: string): McpServerConfig {
    const server = this.config.servers[serverId];
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    return server;
  }

  private createTransport(server: McpServerConfig): Transport {
    if (server.transport === "stdio") {
      return new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: { ...getDefaultEnvironment(), ...server.env },
        stderr: "pipe",
      });
    }
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
  }

  private async connection(serverId: string): Promise<ConnectedServer> {
    const current = this.connections.get(serverId);
    if (current) return current;

    const server = this.getServerConfig(serverId);
    const client = new Client({ name: "pi-team-orchestration", version: "0.1.0" });
    const transport = this.createTransport(server);
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    const connected = { client, transport };
    this.connections.set(serverId, connected);
    return connected;
  }

  async listTools(serverId: string): Promise<ListedMcpTool[]> {
    const server = this.getServerConfig(serverId);
    const { client } = await this.connection(serverId);
    const response = await client.listTools();
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      operation: classifyMcpTool(server, tool.name),
    }));
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: McpPolicyContext,
  ): Promise<unknown> {
    const server = this.getServerConfig(serverId);
    const operation = classifyMcpTool(server, toolName);
    const authorization = authorizeMcpCall(
      operation,
      toolName,
      args,
      context,
    );
    if (!authorization.allowed) {
      await this.onDenied?.({ serverId, toolName, operation, reason: authorization.reason, args });
      throw new Error(authorization.reason);
    }
    const { client } = await this.connection(serverId);
    return client.callTool({ name: toolName, arguments: args });
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map(({ transport }) => transport.close()));
  }
}
