import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { basename, join, resolve } from "node:path";
import { V4RuntimeAdapter } from "./runtime-adapter.ts";
import { V4Store } from "./store.ts";
import { V4SupervisorCore } from "./supervisor.ts";
import { V4_BUILD_ID, V4_PROTOCOL_VERSION, V4_SCHEMA_VERSION } from "./transport.ts";
import type { V4ProjectState } from "./types.ts";

const runtimeDir = resolve(process.env.PI_LEAD_V4_RUNTIME_DIR ?? "");
const stateDir = resolve(process.env.PI_LEAD_V4_STATE_DIR ?? "");
const socketPath = join(runtimeDir, "supervisor.sock");
const tokenPath = join(runtimeDir, "transport.token");
const MAX_FRAME_BYTES = 256 * 1024;
const epoch = randomUUID();
const transportToken = randomBytes(32).toString("hex");
const stateRootHash = createHash("sha256").update(stateDir).digest("hex");

interface ProjectRuntime {
  store: V4Store;
  core: V4SupervisorCore;
  adapter: V4RuntimeAdapter;
}

const projects = new Map<string, Promise<ProjectRuntime>>();
let ticking = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let reconcileCounter = 0;
let daemonReady = false;

function response(socket: Socket, id: string, value: unknown): void {
  const encoded = `${JSON.stringify({ id, ok: true, result: value })}\n`;
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    socket.end(`${JSON.stringify({ id, ok: false, error: "V4 RPC response exceeds 256 KiB; request a narrower record", code: "E2BIG" })}\n`);
    return;
  }
  socket.end(encoded);
}

function failure(socket: Socket, id: string, error: unknown, code?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  socket.end(`${JSON.stringify({ id, ok: false, error: message, code })}\n`);
}

async function projectRuntime(params: Record<string, unknown>): Promise<ProjectRuntime> {
  const projectRoot = typeof params.projectRoot === "string" ? resolve(params.projectRoot) : undefined;
  if (!projectRoot) throw new Error("V4 RPC requires projectRoot");
  let pending = projects.get(projectRoot);
  if (!pending) {
    pending = (async () => {
      const store = new V4Store(stateDir, projectRoot);
      await store.initialize(projectRoot, typeof params.projectName === "string" ? params.projectName : basename(projectRoot), params.config as never);
      await store.beginSupervisorGeneration();
      const core = new V4SupervisorCore(store, stateDir);
      await core.recoverAfterSupervisorRestart();
      const adapter = new V4RuntimeAdapter(
        stateDir,
        process.env.PI_LEAD_V4_EXTENSION_PATH,
        process.env.PI_LEAD_V4_PI_COMMAND || "pi",
      );
      return { store, core, adapter };
    })();
    projects.set(projectRoot, pending);
    void pending.catch(() => {
      if (projects.get(projectRoot) === pending) projects.delete(projectRoot);
    });
  }
  return pending;
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  const runtime = await projectRuntime(params);
  runtime.adapter.setCmuxSocketPath(typeof params.cmuxSocketPath === "string" ? params.cmuxSocketPath : undefined);
  switch (method) {
    case "initializeProject": return runtime.core.status();
    case "attach": return runtime.core.attach(params.input as never);
    case "heartbeat": return runtime.core.heartbeat(params.input as never);
    case "detach": return runtime.core.detach(String(params.attachmentId), String(params.ownershipToken));
    case "createFeature": return runtime.core.createFeature(params.input as never);
    case "claimFeature": return runtime.core.claimFeature(params.input as never);
    case "createTask": return runtime.core.createTask(params.input as never);
    case "workerHello": return runtime.core.workerHello(params.input as never);
    case "workerAgentStart": return runtime.core.workerAgentStart(params.input as never);
    case "workerHeartbeat": return runtime.core.workerHeartbeat(params.input as never);
    case "quarantineWorkerModel": return runtime.core.quarantineWorkerModel(params.input as never);
    case "workerExited": return runtime.core.workerExited(params.input as never);
    case "report": {
      const state = await runtime.store.read();
      const input = await runtime.adapter.bindReviewVerdict(state, params.input as never);
      return runtime.core.report(input as never);
    }
    case "claimDigest": return runtime.core.claimDigest(params.input as never);
    case "acknowledgeDigest": return runtime.core.acknowledgeDigest(params.input as never);
    case "stopTask": return runtime.core.stopTask(params.input as never);
    case "status": return runtime.core.status();
    case "rollbackCheck": {
      const snapshot = await runtime.core.status();
      const unsafe = snapshot.tasks.filter((task) => ["launching", "running", "unknown", "quarantined"].includes(task.processState));
      if (unsafe.length > 0) throw new Error(`Rollback to V2 is unsafe while V4 generations are active/uncertain: ${unsafe.map((task) => task.id).join(", ")}`);
      return { safe: true };
    }
    default: throw new Error(`Unknown V4 supervisor method: ${method}`);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    reconcileCounter++;
    for (const pending of projects.values()) {
      const runtime = await pending;
      const before = await runtime.store.read();
      const scheduled = await runtime.core.tick();
      for (const feature of scheduled.leads) void runtime.adapter.launchLead(before, feature, runtime.core);
      for (const task of scheduled.workers) void runtime.adapter.launchWorker(before, task, runtime.core);
      if (reconcileCounter % 5 === 0) {
        const current = await runtime.store.read();
        await runtime.adapter.reconcile(current, runtime.core);
      }
      if (reconcileCounter % 30 === 0) {
        const current = await runtime.store.read();
        await runtime.adapter.pollPullRequests(current, runtime.core);
      }
    }
  } finally {
    ticking = false;
  }
}

async function handle(socket: Socket, line: string): Promise<void> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    failure(socket, "parse", error, "EBADMSG");
    return;
  }
  const id = typeof request.id === "string" ? request.id : "unknown";
  if (request.protocolVersion !== V4_PROTOCOL_VERSION) {
    failure(socket, id, `Protocol mismatch: supervisor=${V4_PROTOCOL_VERSION}`, "EPROTO");
    return;
  }
  if (request.method === "handshake") {
    if (!daemonReady) {
      failure(socket, id, "Supervisor bind is not ready", "EAGAIN");
      return;
    }
    const params = request.params as Record<string, unknown> | undefined;
    if (params?.schemaVersion !== V4_SCHEMA_VERSION || params?.buildId !== V4_BUILD_ID || params?.stateRootHash !== stateRootHash) {
      failure(socket, id, `Build/schema/state-root mismatch: supervisor=${V4_BUILD_ID}/${V4_SCHEMA_VERSION}`, "EPROTO");
      return;
    }
    response(socket, id, { protocolVersion: V4_PROTOCOL_VERSION, schemaVersion: V4_SCHEMA_VERSION, buildId: V4_BUILD_ID, epoch, pid: process.pid });
    return;
  }
  if (request.epoch !== epoch) {
    failure(socket, id, "Supervisor fencing epoch is stale", "ESTALE");
    return;
  }
  if (request.token !== transportToken) {
    failure(socket, id, "Supervisor transport authentication failed", "EACCES");
    return;
  }
  const method = typeof request.method === "string" ? request.method : "";
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  try {
    response(socket, id, await dispatch(method, params));
  } catch (error) {
    failure(socket, id, error);
  }
}

async function main(): Promise<void> {
  if (!runtimeDir || !stateDir) throw new Error("V4 supervisor runtime/state directories are required");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        failure(socket, "oversize", "V4 RPC frame exceeds 256 KiB", "E2BIG");
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = "";
      void handle(socket, line);
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    // Kernel bind is authoritative. In particular, never unlink/retry on
    // EADDRINUSE: another daemon (or an uncertain owner) wins safely.
    if (error.code === "EADDRINUSE") process.exitCode = 2;
    else process.exitCode = 1;
  });
  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o600);
    // Publish the new transport token only after this daemon owns the kernel
    // bind. An EADDRINUSE loser must never overwrite the live daemon's token.
    await writeFile(tokenPath, `${transportToken}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tokenPath, 0o600);
    daemonReady = true;
    tickTimer = setInterval(() => void tick(), 1_000);
    tickTimer.unref();
  });

  const shutdown = () => {
    if (tickTimer) clearInterval(tickTimer);
    server.close(() => {
      // Only this successfully bound server removes its own pathname.
      void rm(socketPath, { force: true }).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch(() => {
  process.exitCode = 1;
});
