import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { V4TransportClient } from "../extensions/lead-v4/transport.ts";
import type { V4StatusSnapshot } from "../extensions/lead-v4/types.ts";

const runtimeScript = resolve("extensions/lead-v4/runtime/supervisor.mjs");

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    } catch {
      return;
    }
  }
  throw new Error(`PID ${pid} did not exit`);
}

test("20 concurrent bootstraps produce one private durable supervisor and SIGKILL restart increments project generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-transport-"));
  const runtimeDir = join(root, "run");
  const stateDir = join(root, "state");
  const clients = Array.from({ length: 20 }, () => new V4TransportClient({ runtimeDir, runtimeScript, stateDir }));
  const handshakes = await Promise.all(clients.map((client) => client.ensure()));
  assert.equal(new Set(handshakes.map((handshake) => handshake.pid)).size, 1);
  const firstPid = handshakes[0].pid;
  t.after(() => {
    try { process.kill(firstPid, "SIGKILL"); } catch { /* already stopped */ }
  });
  const projectRoot = join(root, "repo");
  const initialized = await clients[0].request<V4StatusSnapshot>("initializeProject", { projectRoot, projectName: "repo" });
  assert.equal(initialized.supervisorGeneration, 1);
  assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(clients[0].socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(runtimeDir, "transport.token"))).mode & 0o777, 0o600);
  const wrongStateRoot = new V4TransportClient({ runtimeDir, runtimeScript, stateDir: join(root, "other-state") });
  await assert.rejects(() => wrongStateRoot.ensure(), /protocol\/build mismatch|state-root mismatch/i);
  assert.equal((await stat(clients[0].socketPath)).isSocket(), true);

  const bindLoser = spawn(process.execPath, [runtimeScript], {
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PI_LEAD_V4_RUNTIME_DIR: runtimeDir,
      PI_LEAD_V4_STATE_DIR: stateDir,
    },
  });
  const loserExit = await new Promise<number | null>((resolveExit) => bindLoser.once("exit", resolveExit));
  assert.equal(loserExit, 2, "kernel EADDRINUSE loser exits without unlinking or replacing the token");
  assert.equal((await clients[0].request<V4StatusSnapshot>("status", { projectRoot, projectName: "repo" })).supervisorGeneration, 1);

  process.kill(firstPid, "SIGKILL");
  await waitForExit(firstPid);
  const replacement = new V4TransportClient({ runtimeDir, runtimeScript, stateDir });
  const restarted = await replacement.ensure();
  assert.notEqual(restarted.pid, firstPid);
  t.after(() => {
    try { process.kill(restarted.pid, "SIGTERM"); } catch { /* already stopped */ }
  });
  const recovered = await replacement.request<V4StatusSnapshot>("initializeProject", { projectRoot, projectName: "repo" });
  assert.equal(recovered.supervisorGeneration, 2);
});

test("connect-first bootstrap removes only a proven ECONNREFUSED orphaned socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-stale-socket-"));
  const runtimeDir = join(root, "run");
  const stateDir = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runtimeDir, { recursive: true, mode: 0o700 }));
  const socketPath = join(runtimeDir, "supervisor.sock");
  const owner = spawn(process.execPath, [
    "-e",
    "require('node:net').createServer(() => {}).listen(process.argv[1], () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000)",
    socketPath,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolveReady, rejectReady) => {
    owner.stdout.once("data", () => resolveReady());
    owner.once("error", rejectReady);
    owner.once("exit", (code) => rejectReady(new Error(`stale socket owner exited early: ${code}`)));
  });
  const ownerExit = new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
  owner.kill("SIGKILL");
  await ownerExit;
  assert.equal((await stat(socketPath)).isSocket(), true);
  const client = new V4TransportClient({ runtimeDir, runtimeScript, stateDir });
  const handshake = await client.ensure();
  t.after(() => {
    try { process.kill(handshake.pid, "SIGTERM"); } catch { /* already stopped */ }
  });
  assert.ok(handshake.pid > 0);
});

test("a nonresponding live socket times out closed without unlink or bootstrap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-hung-socket-"));
  const runtimeDir = join(root, "run");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runtimeDir, { recursive: true, mode: 0o700 }));
  const socketPath = join(runtimeDir, "supervisor.sock");
  const server = createServer(() => {
    // Deliberately accept and retain the connection without replying. This is a
    // live daemon pathname, never evidence that unlink/bootstrap is safe.
  });
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
  t.after(() => server.close());
  const client = new V4TransportClient({
    runtimeDir,
    runtimeScript,
    stateDir: join(root, "state"),
    handshakeTimeoutMs: 100,
  });
  await assert.rejects(() => client.ensure(), (error: NodeJS.ErrnoException) => error.code === "ETIMEDOUT");
  assert.equal((await stat(socketPath)).isSocket(), true);
  assert.equal(await stat(client.bootstrapPath).then(() => true, () => false), false);
});

test("malformed and EACCES handshake replies fail closed without bootstrap", async () => {
  for (const scenario of ["malformed", "access-denied"] as const) {
    const root = await mkdtemp(join(tmpdir(), `lead-v4-${scenario}-`));
    const runtimeDir = join(root, "run");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runtimeDir, { recursive: true, mode: 0o700 }));
    const socketPath = join(runtimeDir, "supervisor.sock");
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        if (scenario === "malformed") socket.end("{not-json}\n");
        else {
          const request = JSON.parse(String(chunk).trim()) as { id: string };
          socket.end(`${JSON.stringify({ id: request.id, ok: false, error: "denied", code: "EACCES" })}\n`);
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    const client = new V4TransportClient({ runtimeDir, runtimeScript, stateDir: join(root, "state") });
    await assert.rejects(() => client.ensure(), scenario === "malformed" ? /JSON/ : /denied/);
    assert.equal((await stat(socketPath)).isSocket(), true);
    assert.equal(await stat(client.bootstrapPath).then(() => true, () => false), false);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("protocol/build mismatch fails closed and never unlinks the existing socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lead-v4-protocol-"));
  const runtimeDir = join(root, "run");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runtimeDir, { recursive: true, mode: 0o700 }));
  await chmod(runtimeDir, 0o700);
  const socketPath = join(runtimeDir, "supervisor.sock");
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: 999, schemaVersion: 999, buildId: "other", epoch: "bad", pid: process.pid } })}\n`);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
  t.after(() => server.close());
  const client = new V4TransportClient({ runtimeDir, runtimeScript, stateDir: join(root, "state") });
  await assert.rejects(() => client.ensure(), /protocol\/build mismatch/);
  assert.equal((await stat(socketPath)).isSocket(), true);
});
