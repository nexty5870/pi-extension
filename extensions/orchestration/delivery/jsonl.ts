export class StrictJsonlParser {
  private buffer = "";
  constructor(private readonly onValue: (value: Record<string, unknown>) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n"); if (index < 0) return;
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); this.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }
  finish(): void { if (this.buffer) this.parse(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer); this.buffer = ""; }
  private parse(line: string): void { if (!line.trim()) return; let value: unknown; try { value = JSON.parse(line); } catch { throw new Error("Malformed JSONL record"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSONL record must be an object"); this.onValue(value as Record<string, unknown>); }
}
