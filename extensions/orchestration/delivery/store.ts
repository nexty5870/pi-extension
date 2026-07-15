import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliveryState } from "./types.ts";

export class DeliveryStore {
  constructor(readonly initiativeDir: string) {}
  get deliveryDir(): string { return join(this.initiativeDir, "delivery"); }
  statePath(runId: string): string { return join(this.deliveryDir, runId, "state.json"); }
  logPath(runId: string, name: string): string { return join(this.deliveryDir, runId, "logs", `${name.replace(/[^A-Za-z0-9._-]/g, "-")}.log`); }

  async write(state: DeliveryState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const path = this.statePath(state.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  async read(runId: string): Promise<DeliveryState | undefined> {
    try { return JSON.parse(await readFile(this.statePath(runId), "utf8")) as DeliveryState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async latest(): Promise<DeliveryState | undefined> {
    let ids: string[];
    try { ids = await readdir(this.deliveryDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const states = (await Promise.all(ids.map((id) => this.read(id)))).filter((v): v is DeliveryState => Boolean(v));
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  async writeLog(runId: string, name: string, text: string): Promise<string> {
    const path = this.logPath(runId, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 }); await chmod(path, 0o600); return path;
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    const path = join(this.deliveryDir, runId, "run.lock"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(path, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
        let active = Number.isInteger(pid) && pid > 0;
        if (active) { try { process.kill(pid, 0); } catch { active = false; } }
        if (active) throw new Error("Delivery run is already active");
        await rm(path, { force: true });
      }
    }
    if (!handle) throw new Error("Could not acquire delivery run lock");
    await handle.writeFile(`${process.pid}\n`); await handle.sync();
    return async () => { await handle.close(); await rm(path, { force: true }); };
  }

  async cleanup(runId: string): Promise<void> { await rm(join(this.deliveryDir, runId), { recursive: true, force: true }); }
}
