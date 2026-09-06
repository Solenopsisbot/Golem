// The inbox: everything that might deserve the mind's attention, with a priority, waiting to be
// folded into the next prompt turn. Nothing is dropped; when it overflows, the oldest low-priority
// items are summarised into one line.
export type InboxKind =
  | "chat" | "whisper" | "damage" | "death" | "respawn" | "player_join" | "player_leave"
  | "reflex" | "run_done" | "run_failed" | "bridge" | "goal" | "system" | "agent";

export interface InboxItem {
  id: number;
  t: number;
  kind: InboxKind;
  priority: number;          // 0..100
  text: string;
  from?: string;             // player / agent / bridge source
  image?: { data: Buffer; mimeType: string; caption?: string };
}

export interface InboxOptions { max?: number }

export class Inbox {
  private items: InboxItem[] = [];
  private nextId = 1;
  private readonly max: number;
  private summarised = 0;
  constructor(opts: InboxOptions = {}) { this.max = opts.max ?? 40; }

  push(item: Omit<InboxItem, "id" | "t"> & { t?: number }): InboxItem {
    const full: InboxItem = { id: this.nextId++, t: item.t ?? Date.now(), ...item };
    this.items.push(full);
    if (this.items.length > this.max) this.overflow();
    return full;
  }
  get size(): number { return this.items.length; }
  get empty(): boolean { return this.items.length === 0; }
  peekMaxPriority(): number { return this.items.reduce((m, i) => Math.max(m, i.priority), -1); }
  /** Take everything, oldest first. */
  drain(): InboxItem[] { const out = this.items; this.items = []; return out; }
  snapshot(): InboxItem[] { return [...this.items]; }

  private overflow(): void {
    // Keep the newest and the important; fold the rest into a count.
    const keep = this.items.filter((i) => i.priority >= 60);
    const rest = this.items.filter((i) => i.priority < 60);
    const dropped = rest.splice(0, rest.length - Math.max(0, this.max - keep.length - 1));
    this.summarised += dropped.length;
    if (dropped.length) {
      const kinds = new Map<string, number>();
      for (const d of dropped) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
      rest.unshift({
        id: this.nextId++, t: dropped[0]!.t, kind: "system", priority: 10,
        text: `(${dropped.length} older items folded: ${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ")})`,
      });
    }
    this.items = [...keep, ...rest].sort((a, b) => a.t - b.t);
  }
}

function hhmmss(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Render inbox items as the compact block that goes into a prompt. */
export function renderInbox(items: InboxItem[]): string {
  if (!items.length) return "[inbox] (empty)";
  const lines = items.map((i) => {
    const who = i.from ? `${i.from}: ` : "";
    return `${hhmmss(i.t)} ${i.kind.padEnd(11)} ${who}${i.text}`;
  });
  return `[inbox]\n${lines.join("\n")}`;
}
