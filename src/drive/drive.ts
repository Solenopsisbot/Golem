// The drive: turns the world into prompt turns. Body events land in the inbox; when the mind is
// idle and the inbox has something, it is drained into one prompt; high-priority items interrupt
// a running turn; a standing goal wakes the mind on a cadence; budgets cap how often any of that
// happens. The owner fast path handles a few commands without waking the mind at all.
import { readFileSync } from "node:fs";
import type { AgentRuntime } from "../agent/runtime.ts";
import { parseDuration } from "../config/schema.ts";
import type { Mind } from "../mind/acp.ts";
import { block } from "../mind/acp.ts";
import { GolemError } from "../primitives/errors.ts";
import type { ReflexEvent } from "../reflexes/engine.ts";
import { fmtPos } from "../util/geom.ts";
import type { Logger } from "../util/log.ts";
import { readGoal } from "../workspace/generate.ts";
import { parseFastCommand, routeChat, type FastCommand } from "./chat.ts";
import { Inbox, renderInbox, type InboxItem } from "./inbox.ts";
import { Journal, Transcript } from "./transcript.ts";
import type * as acp from "@agentclientprotocol/sdk";

export interface DriveOptions {
  rt: AgentRuntime;
  mind: Mind;
  log: Logger;
  transcript: Transcript;
  journal: Journal;
  /** Bridge event sink (SSE, webhooks). */
  emit: (ev: { type: string; [k: string]: unknown }) => void;
}

export class Drive {
  readonly inbox: Inbox;
  goal = "";
  private readonly rt: AgentRuntime;
  private readonly mind: Mind;
  private readonly log: Logger;
  private readonly transcript: Transcript;
  private readonly journal: Journal;
  private readonly emit: DriveOptions["emit"];
  private running = false;
  private wake: (() => void) | null = null;
  private turnStartedAt = 0;
  private lastTurnEndedAt = Date.now();
  private lastDamageItemAt = 0;
  private readonly turnTimes: number[] = [];
  private readonly tokenSpend: { t: number; n: number }[] = [];
  private currentTurnText = "";

  constructor(opts: DriveOptions) {
    this.rt = opts.rt;
    this.mind = opts.mind;
    this.log = opts.log;
    this.transcript = opts.transcript;
    this.journal = opts.journal;
    this.emit = opts.emit;
    this.inbox = new Inbox({ max: this.rt.agent.drive.inbox_max });
    this.goal = readGoal(this.rt.agent);
  }

  // ---- inputs -----------------------------------------------------------------------

  push(item: Omit<InboxItem, "id" | "t">): InboxItem {
    const it = this.inbox.push(item);
    this.emit({ type: "inbox", item: { ...it, image: it.image ? { caption: it.image.caption } : undefined } });
    if (this.mind.busy && it.priority >= this.rt.agent.drive.interrupt_priority) {
      this.log.info(`interrupting the mind for ${it.kind} (p${it.priority})`);
      void this.mind.cancel();
    }
    this.wake?.();
    return it;
  }

  /** From the bridge: an outside system (Discord, a test REPL) putting words in the inbox. */
  pushExternal(b: { text: string; from?: string; kind?: string; priority?: number }): InboxItem {
    const owner = b.from ? this.rt.agent.players.owners.includes(b.from) : false;
    if (owner) {
      // Bridge messages are implicitly addressed to the agent, so owners get the same fast path
      // as in-game chat: "goal ...", "met", "mode x off" never need to wake the mind.
      const fast = parseFastCommand(b.text);
      if (fast) { void this.handleFast(fast, b.from!); return { id: -1, t: Date.now(), kind: "system", priority: 0, text: `(fast path: ${fast.name})`, from: b.from }; }
    }
    return this.push({ kind: (b.kind as InboxItem["kind"]) ?? "bridge", priority: b.priority ?? (owner ? 80 : 50), text: b.text, from: b.from });
  }

  peekInbox(): string { return renderInbox(this.inbox.snapshot()); }

  /** The `[state]` line at the top of every prompt (and the status tool). */
  stateHeader(): string {
    const m = this.rt.mirror;
    const parts = [
      this.rt.agent.name,
      m.inWorld ? `${fmtPos(m.blockPos)} ${m.dimension.replace("minecraft:", "")}` : "not in world",
      m.dead ? "DEAD (respawning)" : "",
      m.phase ? `${m.phase}${m.weather && m.weather !== "clear" ? "/" + m.weather : ""}` : "",
      `hp ${m.health.toFixed(0)}/20 food ${m.food}`,
      `held ${m.heldItem.replace("minecraft:", "")}`,
      m.navActive ? "pathing" : "",
      m.screen ? `screen ${m.screen}` : "",
      this.rt.ctx.activity.current ? `doing: ${this.rt.ctx.activity.current}` : "",
      this.rt.reflexes.active ? `reflex ${this.rt.reflexes.active} acting` : "",
      this.goal ? `goal: ${this.goal}` : "no goal",
    ].filter(Boolean);
    return `[state] ${parts.join(" | ")}`;
  }

  // ---- wiring -----------------------------------------------------------------------

  start(): void {
    const b = this.rt.body;
    const m = this.rt.mirror;
    const a = this.rt.agent;
    b.on("chat", (d: { text: string; sender?: string; kind: string }) => {
      const r = routeChat(a, d);
      if (r.action === "drop") return;
      if (r.action === "fast") { void this.handleFast(r.command, d.sender ?? "?"); return; }
      this.journal.note(`${d.sender ?? "?"}: ${d.text}`);
      this.push({ kind: d.kind === "whisper" ? "whisper" : "chat", priority: r.priority, text: d.text, from: d.sender });
    });
    b.on("damage", (d: { amount: number; health: number }) => {
      const now = Date.now();
      if (d.health > 10 || now - this.lastDamageItemAt < 5000) return;
      this.lastDamageItemAt = now;
      const attacker = m.lastAttacker && now - m.lastAttacker.at < 3000 ? ` from ${m.lastAttacker.type.replace("minecraft:", "")}#${m.lastAttacker.id}` : "";
      this.push({ kind: "damage", priority: d.health <= 6 ? 85 : 70, text: `took ${d.amount.toFixed(1)} damage${attacker}; hp ${d.health.toFixed(0)}` });
    });
    b.on("death", () => {
      const where = fmtPos(m.blockPos);
      this.journal.note(`died at ${where}`);
      this.push({ kind: "death", priority: 95, text: `you died at ${where}. Your items are there if you want them back.` });
    });
    b.on("respawn", () => this.push({ kind: "respawn", priority: 60, text: `respawned at ${fmtPos(m.blockPos)}` }));
    b.on("join", (d: { name: string }) => { if (d.name !== a.body.username) this.push({ kind: "player_join", priority: 20, text: `${d.name} joined`, from: d.name }); });
    b.on("leave", (d: { name: string }) => this.push({ kind: "player_leave", priority: 15, text: `${d.name} left`, from: d.name }));
    b.on("title", (d: { title?: string; subtitle?: string; actionBar?: string }) => {
      const t = [d.title, d.subtitle].filter(Boolean).join(" / ");
      if (t) this.push({ kind: "system", priority: 30, text: `server title: ${t}` });
    });
    this.running = true;
    void this.loop();
  }

  onReflex(ev: ReflexEvent): void {
    if (/ fired$/.test(ev.note)) return;   // engine-level "fired" with no note: not worth a prompt line
    this.journal.note(`reflex ${ev.name}: ${ev.note}`);
    this.push({ kind: "reflex", priority: ev.name === "self_preservation" ? 65 : 30, text: `${ev.name}: ${ev.note}` });
  }

  stop(): void { this.running = false; this.wake?.(); }

  // ---- the loop -----------------------------------------------------------------------

  private async loop(): Promise<void> {
    const a = this.rt.agent;
    const idleMs = parseDuration(a.drive.idle_wake);
    while (this.running) {
      if (this.inbox.empty) {
        // Nothing to do: wait for a push, or for the goal cadence.
        const waitMs = this.goal ? Math.max(1000, idleMs - (Date.now() - this.lastTurnEndedAt)) : 3_600_000;
        await new Promise<void>((r) => { this.wake = r; setTimeout(r, waitMs); });
        this.wake = null;
        if (!this.running) break;
        if (this.inbox.empty && this.goal && Date.now() - this.lastTurnEndedAt >= idleMs) {
          this.push({ kind: "goal", priority: 10, text: `Nothing new happened. Continue toward your goal: ${this.goal}` });
        }
        if (this.inbox.empty) continue;
      }
      await this.waitForBudget();
      if (!this.running) break;
      await this.runTurn();
    }
  }

  private async waitForBudget(): Promise<void> {
    const b = this.rt.agent.mind.budget;
    const hour = 3_600_000;
    for (;;) {
      const now = Date.now();
      while (this.turnTimes.length && now - this.turnTimes[0]! > hour) this.turnTimes.shift();
      while (this.tokenSpend.length && now - this.tokenSpend[0]!.t > hour) this.tokenSpend.shift();
      const tokens = this.tokenSpend.reduce((s, x) => s + x.n, 0);
      if (this.turnTimes.length < b.turns_per_hour && tokens < b.tokens_per_hour) return;
      const until = Math.min(this.turnTimes[0] ?? now, this.tokenSpend[0]?.t ?? now) + hour;
      this.log.warn(`budget reached (${this.turnTimes.length} turns, ${tokens} tokens this hour); sleeping ${Math.ceil((until - now) / 1000)}s`);
      await new Promise((r) => setTimeout(r, Math.max(1000, until - now)));
      if (!this.running) return;
    }
  }

  private buildPrompt(items: InboxItem[]): acp.ContentBlock[] {
    const blocks: acp.ContentBlock[] = [block.text(`${this.stateHeader()}\n${renderInbox(items)}`)];
    if (this.mind.supportsImages) {
      for (const it of items) if (it.image) blocks.push(block.image(it.image.data, it.image.mimeType));
    }
    return blocks;
  }

  private async runTurn(): Promise<void> {
    const items = this.inbox.drain();
    const blocks = this.buildPrompt(items);
    const promptText = (blocks[0] as { text: string }).text;
    this.transcript.add("user", promptText, { items: items.length });
    this.emit({ type: "prompt", text: promptText });
    this.turnStartedAt = Date.now();
    this.turnTimes.push(this.turnStartedAt);
    this.currentTurnText = "";
    try {
      const r = await this.mind.prompt(blocks);
      if (r.usage?.totalTokens) {
        // Agents report every API round trip's input, most of it cache reads; budget the rest.
        const billable = Math.max(0, r.usage.totalTokens - (r.usage.cachedReadTokens ?? 0));
        this.tokenSpend.push({ t: Date.now(), n: billable });
      }
      const text = r.text.trim();
      if (text) this.transcript.add("agent", text, { stopReason: r.stopReason });
      this.emit({ type: "turn_end", stopReason: r.stopReason, text, ms: Date.now() - this.turnStartedAt, tokens: r.usage?.totalTokens ?? null });
      this.log.info(`turn ended: ${r.stopReason} after ${((Date.now() - this.turnStartedAt) / 1000).toFixed(1)}s${r.usage ? ` (${r.usage.totalTokens} tokens, ${r.usage.cachedReadTokens ?? 0} cached)` : ""}`);
      if (r.stopReason === "cancelled") this.push({ kind: "system", priority: 5, text: "(your previous turn was interrupted by what follows)" });
      if (this.rt.agent.chat.speech === "auto" && text) {
        const line = text.split(/\n+/).find((l) => l.trim()) ?? "";
        if (line) await this.rt.p.say(line).catch((e) => this.log.warn(`auto-speech failed: ${(e as Error).message}`));
      }
    } catch (e) {
      const msg = e instanceof GolemError ? `${e.kind}: ${e.message}` : (e as Error).message;
      this.log.error(`turn failed: ${msg}`);
      this.transcript.add("system", `turn failed: ${msg}`);
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      this.lastTurnEndedAt = Date.now();
    }
  }

  /** Streamed updates from the mind (called by the runtime's Mind onUpdate). */
  onUpdate(u: acp.SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") { this.currentTurnText += u.content.text; this.emit({ type: "agent_text", text: u.content.text }); }
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.transcript.add("thought", u.content.text);
        break;
      case "tool_call":
        this.emit({ type: "tool_call", title: u.title, status: u.status ?? "pending", id: u.toolCallId });
        break;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") this.emit({ type: "tool_call_update", id: u.toolCallId, status: u.status });
        break;
      case "usage_update":
        this.emit({ type: "usage", used: u.used, size: u.size });
        break;
      default:
        break;
    }
  }

  /** Recorded by the MCP layer for every Golem tool call. */
  noteToolCall(name: string, args: unknown, result: string, ms: number, isError = false): void {
    this.transcript.add("tool", `${name}(${JSON.stringify(args)}) -> ${result}`, { ms, isError });
    this.emit({ type: "golem_tool", name, args, result: result.slice(0, 500), ms, isError });
  }

  // ---- owner fast path ----------------------------------------------------------------

  private async handleFast(cmd: FastCommand, from: string): Promise<void> {
    const p = this.rt.p;
    this.log.info(`fast path from ${from}: ${cmd.name}`);
    try {
      switch (cmd.name) {
        case "met": await this.rt.met(); await this.mind.cancel(); await p.say("met."); break;
        case "status": await p.say(this.rt.mirror.summary(this.rt.agent.name).replace(/^[^|]*\| /, "").slice(0, this.rt.agent.chat.max_len)); break;
        case "reflex": this.rt.reflexes.enable(cmd.reflex, cmd.on); await p.say(`${cmd.reflex} ${cmd.on ? "on" : "off"}`); break;
        case "goal": {
          const { writeGoal } = await import("../workspace/generate.ts");
          writeGoal(this.rt.agent, cmd.text); this.goal = cmd.text;
          await p.say(`goal: ${cmd.text}`);
          this.push({ kind: "goal", priority: 60, text: `${from} set your goal: ${cmd.text}`, from });
          break;
        }
        case "goal_clear": {
          const { writeGoal } = await import("../workspace/generate.ts");
          writeGoal(this.rt.agent, ""); this.goal = "";
          await p.say("goal cleared"); break;
        }
        case "come": {
          this.push({ kind: "chat", priority: 60, text: `${from} asked you to come to them`, from });
          break;
        }
      }
    } catch (e) {
      this.log.warn(`fast path ${cmd.name} failed: ${(e as Error).message}`);
    }
  }
}

/** Journal tail for session bootstrap (kept here so the runtime doesn't need fs details). */
export function journalTail(path: string, n = 30): string {
  try { return readFileSync(path, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return ""; }
}
