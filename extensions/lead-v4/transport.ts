import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const V4_PROTOCOL_VERSION = 4;
export const V4_SCHEMA_VERSION = 4;
export const V4_BUILD_ID = "lead-v4.0.0";
const MAX_FRAME_BYTES = 256 * 1024;

export interface SupervisorHandshake {
  protocolVersion: number;
  schemaVersion: number;
  buildId: string;
  epoch: string;
  pid: number;
}

export interface V4TransportOptions {
  runtimeDir?: string;
  runtimeScript: string;
  stateDir: string;
  extensionPath?: string;
  piCommand?: string;
  handshakeTimeoutMs?: number;
}

interface RpcResponse<T> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
  code?: string;
}

export function defaultV4RuntimeDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `pi-lead-v4-${uid}`);
}

function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function rawRequest<T>(socketPath: string, request: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error("V4 supervisor request exceeds the bounded 256 KiB frame");
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("V4 supervisor request timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encoded));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy();
        reject(new Error("V4 supervisor response exceeds the bounded 256 KiB frame"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(line) as RpcResponse<T>;
        if (!response.ok) reject(Object.assign(new Error(response.error ?? "V4 supervisor RPC failed"), { code: response.code }));
        else resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

function isProvenStalePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  // Only these kernel connect results prove that no daemon is accepting on the
  // pathname. Timeouts, access failures, resets, and malformed replies may all
  // come from a live or transiently unhealthy daemon and must fail closed.
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function handshake(socketPath: string, stateRootHash: string, timeoutMs = 5_000): Promise<SupervisorHandshake> {
  const result = await rawRequest<SupervisorHandshake>(socketPath, {
    id: randomUUID(),
    protocolVersion: V4_PROTOCOL_VERSION,
    method: "handshake",
    params: { buildId: V4_BUILD_ID, schemaVersion: V4_SCHEMA_VERSION, stateRootHash },
  }, timeoutMs);
  if (result.protocolVersion !== V4_PROTOCOL_VERSION || result.schemaVersion !== V4_SCHEMA_VERSION || result.buildId !== V4_BUILD_ID) {
    throw Object.assign(new Error(`V4 supervisor protocol/build mismatch: expected ${V4_PROTOCOL_VERSION}/${V4_SCHEMA_VERSION}/${V4_BUILD_ID}, got ${result.protocolVersion}/${result.schemaVersion}/${result.buildId}`), { code: "EPROTO" });
  }
  return result;
}

async function waitForHandshake(socketPath: string, stateRootHash: string, timeoutMs = 10_000, requestTimeoutMs = 5_000): Promise<SupervisorHandshake> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await handshake(socketPath, stateRootHash, requestTimeoutMs);
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      // EAGAIN is the authenticated protocol's explicit pre-ready response. It
      // may be retried only while waiting on a known bootstrap owner; it never
      // establishes staleness and never permits unlink/spawn.
      if (!isProvenStalePathError(error) && code !== "EAGAIN") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw last instanceof Error ? last : new Error("V4 supervisor did not become ready");
}

export class V4TransportClient {
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly bootstrapPath: string;
  readonly tokenPath: string;
  private epoch = "";
  private authToken = "";
  private readonly stateRootHash: string;

  constructor(private readonly options: V4TransportOptions) {
    this.runtimeDir = options.runtimeDir ?? defaultV4RuntimeDir();
    this.socketPath = join(this.runtimeDir, "supervisor.sock");
    this.bootstrapPath = join(this.runtimeDir, "bootstrap.lock");
    this.tokenPath = join(this.runtimeDir, "transport.token");
    this.stateRootHash = createHash("sha256").update(resolve(this.options.stateDir)).digest("hex");
  }

  async ensure(): Promise<SupervisorHandshake> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(this.runtimeDir, 0o700);
    try {
      const ready = await handshake(this.socketPath, this.stateRootHash, this.options.handshakeTimeoutMs);
      await this.bindHandshake(ready);
      return ready;
    } catch (error) {
      if (!isProvenStalePathError(error)) throw error;
    }

    let lock;
    try {
      lock = await open(this.bootstrapPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, incarnation: randomUUID(), createdAt: new Date().toISOString() }), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata: { pid?: number } = await readFile(this.bootstrapPath, "utf8").then((value) => JSON.parse(value) as { pid?: number }).catch(() => ({}));
      if (!metadata.pid || !livePid(metadata.pid)) {
        // A failed handshake was already observed. A dead bootstrap owner cannot
        // finish the bind, so remove only its O_EXCL lock; socket cleanup remains
        // the next bootstrap winner's responsibility after another failed probe.
        await rm(this.bootstrapPath, { force: true });
        return this.ensure();
      }
      const ready = await waitForHandshake(this.socketPath, this.stateRootHash, 10_000, this.options.handshakeTimeoutMs);
      await this.bindHandshake(ready);
      return ready;
    }

    try {
      try {
        const ready = await handshake(this.socketPath, this.stateRootHash, this.options.handshakeTimeoutMs);
        await this.bindHandshake(ready);
        return ready;
      } catch (error) {
        if (!isProvenStalePathError(error)) throw error;
      }
      // Connect-first and recheck both produced ENOENT/ECONNREFUSED while this
      // process owns the O_EXCL lock. Only those documented stale-path results
      // permit unlink/bootstrap. EADDRINUSE remains kernel-authoritative.
      await rm(this.socketPath, { force: true });
      const inheritedEnvironment = Object.fromEntries([
        "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "CMUX_SOCKET_PATH", "PI_CODING_AGENT_DIR",
      ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
      const child = spawn(process.execPath, [this.options.runtimeScript], {
        detached: true,
        stdio: "ignore",
        env: {
          ...inheritedEnvironment,
          PI_LEAD_V4_RUNTIME_DIR: this.runtimeDir,
          PI_LEAD_V4_STATE_DIR: this.options.stateDir,
          PI_LEAD_V4_PROTOCOL: String(V4_PROTOCOL_VERSION),
          PI_LEAD_V4_SCHEMA: String(V4_SCHEMA_VERSION),
          PI_LEAD_V4_BUILD: V4_BUILD_ID,
          PI_LEAD_V4_EXTENSION_PATH: this.options.extensionPath ?? "",
          PI_LEAD_V4_PI_COMMAND: this.options.piCommand ?? "pi",
        },
      });
      child.unref();
      const ready = await waitForHandshake(this.socketPath, this.stateRootHash, 10_000, this.options.handshakeTimeoutMs);
      await this.bindHandshake(ready);
      return ready;
    } finally {
      await lock.close().catch(() => undefined);
      await rm(this.bootstrapPath, { force: true });
    }
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.epoch || !this.authToken) await this.ensure();
    try {
      return await rawRequest<T>(this.socketPath, {
        id: randomUUID(),
        protocolVersion: V4_PROTOCOL_VERSION,
        epoch: this.epoch,
        token: this.authToken,
        method,
        params,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ESTALE", "ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes(code ?? "")) throw error;
      await this.ensure();
      return rawRequest<T>(this.socketPath, {
        id: randomUUID(),
        protocolVersion: V4_PROTOCOL_VERSION,
        epoch: this.epoch,
        token: this.authToken,
        method,
        params,
      });
    }
  }

  private async bindHandshake(ready: SupervisorHandshake): Promise<void> {
    this.epoch = ready.epoch;
    this.authToken = (await readFile(this.tokenPath, "utf8")).trim();
    if (!this.authToken) throw new Error("V4 supervisor transport token is missing");
  }
}
