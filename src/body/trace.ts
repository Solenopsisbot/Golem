// Append-only JSONL trace of everything on the wire between Golem and a body, plus Golem-side
// markers (primitive start/end, reflex firings). `golem replay` reads this back.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface TraceRecord {
  t: number;                // epoch ms
  kind: "cmd" | "res" | "err" | "ev" | "mark";
  [k: string]: unknown;
}

export class TraceWriter {
  private stream: WriteStream | undefined;
  readonly path: string | undefined;
  constructor(path: string | undefined) {
    this.path = path;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }
  record(rec: Omit<TraceRecord, "t"> & { t?: number }): void {
    if (!this.stream) return;
    const full = { t: Date.now(), ...rec };
    this.stream.write(JSON.stringify(full) + "\n");
  }
  mark(what: string, data: Record<string, unknown> = {}): void {
    this.record({ kind: "mark", what, ...data });
  }
  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }
}
