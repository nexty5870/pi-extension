import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMcpConfig, loadMcpConfig } from "../extensions/orchestration/mcp/config.ts";
import { OrchestrationStore, projectIdForRoot } from "../extensions/orchestration/store.ts";
import type { InitiativeState } from "../extensions/orchestration/types.ts";

test("parses HTTP and stdio MCP server definitions", () => {
  const config = parseMcpConfig({
    servers: {
      knowledge: {
        transport: "http",
        url: "https://mcp.example.test",
        headers: { Authorization: "Bearer placeholder" },
        policy: { read: ["get_*"], write: ["update_note"], destructive: ["delete_note"] },
      },
      local: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "placeholder" },
        policy: { read: ["read"], write: [], destructive: [] },
      },
    },
  });
  assert.equal(config.servers.knowledge.transport, "http");
  assert.equal(config.servers.local.transport, "stdio");
  if (config.servers.knowledge.transport !== "http") assert.fail("expected HTTP config");
  assert.equal(config.servers.knowledge.headers?.Authorization, "Bearer placeholder");
});

test("rejects MCP servers without explicit policy", () => {
  assert.throws(
    () => parseMcpConfig({ servers: { notes: { transport: "http", url: "https://example.test" } } }),
    /policy is required/,
  );
});

test("loads private MCP config and tightens permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestration-config-"));
  const path = join(root, "mcp.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, JSON.stringify({
      servers: {
        notes: {
          transport: "http",
          url: "https://example.test",
          policy: { read: [], write: [], destructive: [] },
        },
      },
    })),
  );
  await chmod(path, 0o644);
  await loadMcpConfig(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("rejects deprecated Linear MCP configuration", () => {
  assert.throws(
    () => parseMcpConfig({ servers: { linear: {
      transport: "http",
      url: "https://mcp.example.test",
      policy: { read: [], write: [], destructive: [] },
    } } }),
    /Linear MCP configuration is deprecated/,
  );
});

test("rejects hosted Linear MCP even under a neutral server name", () => {
  assert.throws(
    () => parseMcpConfig({ servers: { notes: {
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      policy: { read: [], write: [], destructive: [] },
    } } }),
    /hosted Linear MCP is deprecated/,
  );
});

test("writes initiative state and Markdown atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orchestration-store-"));
  const store = new OrchestrationStore(root);
  await store.registerProject({
    projectId: projectIdForRoot("/tmp/example"),
    projectRoot: "/tmp/example",
    projectName: "example",
    cmuxWorkspaceId: "workspace-1",
  });
  assert.equal((await store.listProjects())[0]?.projectName, "example");
  const now = new Date().toISOString();
  const state: InitiativeState = {
    schemaVersion: 1,
    initiativeId: "initiative-1",
    projectId: projectIdForRoot("/tmp/example"),
    projectRoot: "/tmp/example",
    status: "review",
    createdAt: now,
    updatedAt: now,
  };
  state.contractPath = await store.writeContract(state, "# Contract\n");
  await store.writeInitiative(state);
  assert.equal(await readFile(state.contractPath, "utf8"), "# Contract\n");
  assert.deepEqual(await store.readInitiative(state.projectId, state.initiativeId), state);
  assert.equal((await stat(state.contractPath)).mode & 0o777, 0o600);

  await store.writeUsage({
    schemaVersion: 1,
    timestamp: now,
    projectId: state.projectId,
    initiativeId: state.initiativeId,
    role: "cto",
    runtime: "pi",
    input: 100,
    output: 25,
    cacheRead: 10,
    cacheWrite: 5,
    cost: 0.01,
    estimatedCost: false,
    turns: 1,
    toolCalls: 2,
  });
  assert.equal((await store.listInitiatives(state.projectId))[0]?.initiativeId, state.initiativeId);
  assert.equal((await store.listUsage(state.projectId))[0]?.input, 100);
});
