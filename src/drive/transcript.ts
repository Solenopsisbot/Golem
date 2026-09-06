// Transcript of the mind's turns (what we sent, what it said, what tools it called), as JSONL, plus
// a daily journal in the workspace that Golem writes and the agent may read.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TranscriptRole = "user" | "agent" | "thought" | "tool" | "system" | "event";

export class Transcript {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  add(role: TranscriptRole, text: string, extra: Record<string, unknown> = {}): void {
    appendFileSync(this.path, JSON.stringify({ t: Date.now(), role, text, ...extra }) + "\n");
  }
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** memory/journal/YYYY-MM-DD.md: one line per notable event, written by Golem. */
export class Journal {
  private readonly dir: string;
  constructor(workspaceDir: string) {
    this.dir = resolve(workspaceDir, "memory", "journal");
    mkdirSync(this.dir, { recursive: true });
  }
  note(text: string): void {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    appendFileSync(resolve(this.dir, `${today()}.md`), `- ${p(d.getHours())}:${p(d.getMinutes())} ${text}\n`);
  }
  /** Last `n` lines across the most recent days, for session bootstrap. */
  tail(n = 30): string {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".md")).sort().slice(-3);
    const lines: string[] = [];
    for (const f of files) {
      lines.push(`## ${f.replace(".md", "")}`);
      lines.push(...readFileSync(resolve(this.dir, f), "utf8").trim().split("\n"));
    }
    return lines.slice(-n).join("\n");
  }
}
