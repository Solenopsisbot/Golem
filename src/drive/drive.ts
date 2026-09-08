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
import type { AgentBus, BusMessage } from "../comms/bus.ts";

export interface DriveOptions {
  rt: AgentRuntime;
  mind: Mind;
  log: Logger;
  transcript: Transcript;
  journal: Journal;
  /** Bridge event sink (SSE, webhooks). */
  emit: (ev: { type: string; [k: string]: unknown }) => void;
  /** The fleet's agent bus, when there is one. */
  bus?: AgentBus;
}

export class Drive {
  readonly inbox: Inbox;
  readonly bus: AgentBus | undefined;
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
  /** Set by the plan_next tool: the next turn runs on the planning profile. */
  escalateNext = false;
  private turnToolCalls = 0;
  private turnsSincePlan = 0;
  private emptyGoalTurns = 0;
  private lastTurnWasGoalTick = false;
  private readonly deathTimes: number[] = [];
  /** Where the bot last died, when that death moved it to a different world. Cleared on return. */
  private diedInOtherDimension: { dim: string; where: string } | null = null;
  private lastContextUsed = 0;
  compactions = 0;
  /** Tool calls in the previous turn, shown in the state header as a nudge toward batching. */
  private lastTurnToolCalls = -1;

  /**
   * Counters for the dashboard's mind panel: what the mind is running on and how much of the hourly
   * budget it has spent. Same one-hour window as waitForBudget, read without mutating.
   */
  stats(): { model: string; profile: string; sessionId: string | undefined; resumed: boolean; busy: boolean; turnsThisHour: number; tokensThisHour: number; contextUsed: number; compactions: number; lastTurnToolCalls: number; lastTurnEndedAt: number; turnStartedAt: number } {
    const hour = 3_600_000, now = Date.now();
    return {
      model: this.mind.currentModel, profile: this.mind.profile, sessionId: this.mind.sessionId, resumed: this.mind.resumed, busy: this.mind.busy,
      turnsThisHour: this.turnTimes.filter((t) => now - t <= hour).length,
      tokensThisHour: this.tokenSpend.filter((x) => now - x.t <= hour).reduce((s, x) => s + x.n, 0),
      contextUsed: this.lastContextUsed, compactions: this.compactions, lastTurnToolCalls: this.lastTurnToolCalls,
      lastTurnEndedAt: this.lastTurnEndedAt, turnStartedAt: this.mind.busy ? this.turnStartedAt : 0,
    };
  }
  private deathLoopUntil = 0;   // while set, deaths/damage don't wake the mind; reflexes carry on

  constructor(opts: DriveOptions) {
    this.rt = opts.rt;
    this.mind = opts.mind;
    this.log = opts.log;
    this.transcript = opts.transcript;
    this.journal = opts.journal;
    this.emit = opts.emit;
    this.bus = opts.bus;
    this.inbox = new Inbox({ max: this.rt.agent.drive.inbox_max });
    this.goal = readGoal(this.rt.agent);
  }

  // ---- inputs -----------------------------------------------------------------------

  push(item: Omit<InboxItem, "id" | "t">): InboxItem {
    const a = this.rt.agent;
    const urgent = this.mind.busy && item.priority >= a.drive.interrupt_priority;
    const chatty = item.kind === "chat" || item.kind === "whisper" || item.kind === "bridge" || item.kind === "goal" || item.kind === "agent";
    // Queueing costs nothing (no cancel), so anything conversational from an addressed player or
    // another agent rides into the running turn; ambient chat waits for the next one.
    // Damage folds into the running turn as well, for a different reason than chat does: it is
    // information, not an instruction. The reflex layer already answered it in milliseconds - that is
    // the entire point of reflexes, and they run at a higher priority than the mind regardless of
    // what it is doing - so cancelling the turn on top of that throws away the thinking and re-asks
    // the same question of a mind that is still being hit. In a boss fight, where being under 6 hp is
    // the normal condition rather than an emergency, that is every turn: Tester planned for 90
    // seconds, was cancelled at hp 6, and made zero tool calls for an entire run. Death still
    // cancels - after dying the plan is genuinely void, because the world moved out from under it.
    const foldable = chatty || item.kind === "damage";
    const conversational = this.mind.busy && foldable && item.priority >= 50;
    if (conversational && a.drive.interrupt_mode === "queue") {
      // Fold the message into the running turn: no cancel, no lost work. It never enters the inbox.
      const it: InboxItem = { id: -1, t: Date.now(), ...item };
      const text = `${this.stateHeader()}\n${renderInbox([it])}`;
      if (this.mind.queue([block.text(text)])) {
        this.transcript.add("user", text, { queued: true });
        this.emit({ type: "prompt", text, queued: true });
        this.emit({ type: "inbox", item: { ...it, queued: true } });
        this.log.info(`queued ${item.kind} from ${item.from ?? "?"} into the running turn`);
        return it;
      }
    }
    const it = this.inbox.push(item);
    this.emit({ type: "inbox", item: { ...it, image: it.image ? { caption: it.image.caption } : undefined } });
    if (urgent) {
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

  /** A message from another agent (or the bus itself) arrives like chat from a trusted player. */
  deliverFromBus(msg: BusMessage): void {
    this.journal.note(`${msg.from} (agent): ${msg.text}`);
    this.push({ kind: "agent", priority: msg.from === "golem" ? 30 : 55, text: msg.text, from: msg.from });
  }
  /** Cancel the mind's current turn (used by met from the bridge). */
  async mindCancel(): Promise<void> { await this.mind.cancel(); }

  /** The `[state]` line at the top of every prompt (and the status tool). */
  /** Inventory and nearby-hostile summaries for the prompt header: one body round trip each, bounded. */
  private async gatherExtras(): Promise<{ inv?: string; near?: string }> {
    if (!this.rt.mirror.inWorld || this.rt.mirror.dead) return {};
    const p = this.rt.p;
    const withTimeout = <T,>(x: Promise<T>): Promise<T | undefined> => Promise.race([x.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 800))]);
    const [inv, threats] = await Promise.all([withTimeout(p.inventory()), withTimeout(p.threats(16))]);
    const out: { inv?: string; near?: string } = {};
    if (inv) {
      const counts = new Map<string, number>();
      for (const it of inv.items) { const id = it.item.replace("minecraft:", ""); counts.set(id, (counts.get(id) ?? 0) + it.count); }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => `${id} ${n}`);
      out.inv = top.length ? `inv: ${top.join(", ")}${counts.size > 10 ? `, +${counts.size - 10} more` : ""}` : "inv: empty";
    }
    if (threats) {
      out.near = threats.length ? `hostiles(16): ${threats.slice(0, 4).map((t) => `${t.type.replace("minecraft:", "")} ${Math.round(t.distance)}m`).join(", ")}${threats.length > 4 ? ` +${threats.length - 4}` : ""}` : "no hostiles within 16";
    }
    return out;
  }

  stateHeader(extras: { inv?: string; near?: string } = {}): string {
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
    const lines = [`[state] ${parts.join(" | ")}`];
    // Sticky until the bot is back in the world it died in. The three dimensions share a coordinate
    // space, so numbers noted before a death are silently valid - and wrong - after it.
    const died = this.diedInOtherDimension;
    if (died) {
      const now = m.dimension.replace("minecraft:", "");
      if (now === died.dim) this.diedInOtherDimension = null;
      else if (m.inWorld) lines.push(`[warning] you died at ${died.where} in the ${died.dim.replace(/_/g, " ")} and you are now in the ${now.replace(/_/g, " ")}. Coordinates from before that death point at nothing here; travel there first.`);
    }
    if (extras.inv) lines.push(`[inv] ${extras.inv.replace(/^inv: /, "")}`);
    if (extras.near) lines.push(`[near] ${extras.near}`);
    if (this.lastTurnToolCalls >= 0) lines.push(`[last turn] ${this.lastTurnToolCalls} tool call${this.lastTurnToolCalls === 1 ? "" : "s"}${this.lastTurnToolCalls > 4 ? " (batch more into one shem_eval)" : ""}`);
    // What the reflexes have actually been doing. A reflex cancels the running script when it acts,
    // so from up here it looks purely like interference and the rational response is `reflex_set off`
    // - which is what agents do, and then they die to the thing it was catching. The work it did is
    // invisible unless we say it, so say it.
    const fired = this.rt.reflexes.fired().filter((f) => f.n > 0).slice(0, 4);
    if (fired.length) lines.push(`[reflexes] ${fired.map((f) => `${f.name} acted ${f.n}x`).join(", ")}`);
    return lines.join("\n");
  }

  // ---- wiring -----------------------------------------------------------------------

  start(): void {
    const b = this.rt.body;
    const m = this.rt.mirror;
    const a = this.rt.agent;
    b.on("chat", (d: { text: string; sender?: string; kind: string }) => {
      // Our own line echoing back from the server is the ground truth for "the golem said": it covers
      // the mind's say tool, the owner fast path, reflex announcements and mirrored dms alike.
      if (d.sender === a.name) { this.emit({ type: "said", text: d.text.replace(/^<[^>]+>\s*/, ""), kind: d.kind }); return; }
      // Fleet-mates talk over the bus; their in-game lines (including mirrored dms) are for players.
      if (d.sender && d.sender !== a.name && this.bus?.has(d.sender)) return;
      const r = routeChat(a, d);
      if (r.action === "drop") return;
      if (r.action === "fast") { void this.handleFast(r.command, d.sender ?? "?"); return; }
      this.journal.note(`${d.sender ?? "?"}: ${d.text}`);
      this.push({ kind: d.kind === "whisper" ? "whisper" : "chat", priority: r.priority, text: d.text, from: d.sender });
    });
    b.on("damage", (d: { amount: number; health: number }) => {
      const now = Date.now();
      if (now < this.deathLoopUntil) { this.deathLoopUntil = now + 60_000; return; }   // still under fire: keep quiet
      if (d.health > 10 || now - this.lastDamageItemAt < 5000) return;
      this.lastDamageItemAt = now;
      const attacker = m.lastAttacker && now - m.lastAttacker.at < 3000 ? ` from ${m.lastAttacker.type.replace("minecraft:", "")}#${m.lastAttacker.id}` : "";
      this.push({ kind: "damage", priority: d.health <= 6 ? 85 : 70, text: `took ${d.amount.toFixed(1)} damage${attacker}; hp ${d.health.toFixed(0)}` });
    });
    b.on("death", () => {
      // Name the dimension. "You died at (73, 57, -10)" is ambiguous across three worlds that share a
      // coordinate space, and the bot respawns somewhere that may not be the one it died in: Tester
      // died in the End, woke in the overworld, and walked two hundred blocks to those coordinates
      // THERE while its gear sat in the End and despawned. It was reasoning correctly from what we
      // told it; we just did not tell it which world.
      // `m.dimension`, not `m.status?.player?.dimension`: the mirror exposes it directly and that is
      // what stateHeader reads. The status path is undefined here, so the guard below never armed and
      // the warning never appeared - a fix that silently did nothing, which is this project's whole
      // recurring theme.
      const dim = m.dimension.replace("minecraft:", "");
      const where = `${fmtPos(m.blockPos)}${dim ? ` in the ${dim.replace(/_/g, " ")}` : ""}`;
      this.journal.note(`died at ${where}`);
      // Remember it if the respawn is going to land somewhere else, so the state header can keep
      // saying so. Naming the dimension in the death message once is not enough: the mistake happens
      // later, when the mind writes a NEW script from coordinates it still has in mind. Three runs
      // have been lost to a plan full of End coordinates executing in the overworld.
      if (dim) this.diedInOtherDimension = { dim, where: fmtPos(m.blockPos) };
      const now = Date.now();
      this.deathTimes.push(now);
      while (this.deathTimes.length && now - this.deathTimes[0]! > 120_000) this.deathTimes.shift();
      if (this.deathTimes.length >= 3) {
        // Dying every few seconds at spawn: the mind can't help in that window and every death was
        // costing a cancelled turn. Go quiet until the body has stayed alive for a minute.
        if (now > this.deathLoopUntil) {
          this.log.warn(`death loop (${this.deathTimes.length} deaths in 2 min): leaving it to the reflexes`);
          this.push({ kind: "system", priority: 40, text: `You've died ${this.deathTimes.length} times in two minutes at ${where}. Golem will stop waking you for deaths until you've survived a full minute; the reflexes (bunker, self-preservation) are handling it. When you do get a turn: dig in or get away from spawn before anything else.` });
        }
        this.deathLoopUntil = now + 60_000;
        return;
      }
      this.push({ kind: "death", priority: 95, text: `you died at ${where}. Your items are there if you want them back - and if that is not the dimension you just respawned in, you have to travel there first.` });
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
        // Nothing to do: wait for a push, or for the goal cadence. The cadence doubles every time a
        // goal turn did nothing (no tool calls), up to idle_wake_max, and resets on real input.
        const backoff = Math.min(idleMs * 2 ** this.emptyGoalTurns, parseDuration(a.drive.idle_wake_max));
        const waitMs = this.goal ? Math.max(1000, backoff - (Date.now() - this.lastTurnEndedAt)) : 3_600_000;
        await new Promise<void>((r) => { this.wake = r; setTimeout(r, waitMs); });
        this.wake = null;
        if (!this.running) break;
        if (this.inbox.empty && this.goal && Date.now() - this.lastTurnEndedAt >= backoff) {
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

  private buildPrompt(items: InboxItem[], extras: { inv?: string; near?: string } = {}): acp.ContentBlock[] {
    const blocks: acp.ContentBlock[] = [block.text(`${this.stateHeader(extras)}\n${renderInbox(items)}`)];
    if (this.mind.supportsImages) {
      for (const it of items) if (it.image) blocks.push(block.image(it.image.data, it.image.mimeType));
    }
    return blocks;
  }

  /** Which model tier a turn deserves. Owners, goal changes, failures, the first turn, a plan_next
   *  request, or plan_every turns since the last planning turn get the planning model. Deaths don't:
   *  the reflexes and the death-loop guard handle the moment, and the act model can walk back for the drops. */
  private wantsPlanning(items: InboxItem[]): boolean {
    if (this.escalateNext) return true;
    const every = this.rt.agent.drive.plan_every;
    if (every > 0 && this.turnsSincePlan >= every) return true;
    return items.some((i) => i.kind === "run_failed" || (i.kind !== "death" && i.priority >= this.rt.agent.drive.interrupt_priority)
      || (i.kind === "goal" && !!i.from) || (i.kind === "system" && /woke up|resumed/.test(i.text)));
  }

  private async runTurn(): Promise<void> {
    const items = this.inbox.drain();
    const extras = await this.gatherExtras().catch(() => ({}));
    const blocks = this.buildPrompt(items, extras);
    const promptText = (blocks[0] as { text: string }).text;
    const planning = this.wantsPlanning(items);
    this.escalateNext = false;
    await this.mind.useProfile(planning ? "plan" : "act").catch((e) => this.log.warn(`profile switch failed: ${(e as Error).message}`));
    if (planning) this.turnsSincePlan = 0; else this.turnsSincePlan++;
    this.lastTurnWasGoalTick = items.length > 0 && items.every((i) => i.kind === "goal" && !i.from);
    this.turnToolCalls = 0;
    this.transcript.add("user", promptText, { items: items.length, model: this.mind.currentModel, planning });
    this.emit({ type: "prompt", text: promptText, model: this.mind.currentModel, planning });
    this.turnStartedAt = Date.now();
    this.turnTimes.push(this.turnStartedAt);
    this.currentTurnText = "";
    try {
      const r = await this.mind.prompt(blocks);
      if (this.lastTurnWasGoalTick && this.turnToolCalls === 0) this.emptyGoalTurns = Math.min(this.emptyGoalTurns + 1, 8); else this.emptyGoalTurns = 0;
      if (r.usage?.totalTokens) {
        // Agents report every API round trip's input, most of it cache reads; budget the rest.
        const billable = Math.max(0, r.usage.totalTokens - (r.usage.cachedReadTokens ?? 0));
        this.tokenSpend.push({ t: Date.now(), n: billable });
      }
      const text = r.text.trim();
      this.transcript.add("agent", text, { stopReason: r.stopReason, model: this.mind.currentModel, planning, tokens: r.usage?.totalTokens ?? null, cached: r.usage?.cachedReadTokens ?? null, ms: Date.now() - this.turnStartedAt, toolCalls: this.turnToolCalls });
      this.lastTurnToolCalls = this.turnToolCalls;
      this.emit({ type: "turn_end", stopReason: r.stopReason, text, ms: Date.now() - this.turnStartedAt, tokens: r.usage?.totalTokens ?? null, model: this.mind.currentModel, toolCalls: this.turnToolCalls });
      this.log.info(`turn ended: ${r.stopReason} after ${((Date.now() - this.turnStartedAt) / 1000).toFixed(1)}s, ${this.turnToolCalls} tool calls, ${this.mind.currentModel || "default model"}${planning ? " (planning)" : ""}${this.lastContextUsed ? ` ctx ${Math.round(this.lastContextUsed / 1000)}k` : ""}${r.usage ? ` (${r.usage.totalTokens} tokens, ${r.usage.cachedReadTokens ?? 0} cached)` : ""}`);
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
      case "usage_update": {
        const used = Number(u.used ?? 0), size = Number(u.size ?? 0);
        // The adapter doesn't forward compact_boundary; a context that shrinks by a third is one.
        if (this.lastContextUsed > 40_000 && used < this.lastContextUsed * 0.67) {
          this.compactions++;
          this.log.info(`context compacted: ${Math.round(this.lastContextUsed / 1000)}k -> ${Math.round(used / 1000)}k of ${Math.round(size / 1000)}k`);
          this.transcript.add("event", `context compacted ${Math.round(this.lastContextUsed / 1000)}k -> ${Math.round(used / 1000)}k`, { compaction: true, from: this.lastContextUsed, to: used });
        }
        this.lastContextUsed = used;
        this.emit({ type: "usage", used, size });
        break;
      }
      default:
        break;
    }
  }

  /** Recorded by the MCP layer for every Golem tool call. */
  noteToolCall(name: string, args: unknown, result: string, ms: number, isError = false): void {
    this.turnToolCalls++;
    this.transcript.add("tool", `${name}(${JSON.stringify(args)}) -> ${result}`, { ms, isError });
    this.emit({ type: "golem_tool", name, args, result: result.slice(0, 500), ms, isError });
    // A dm gets its own event so outside systems don't have to fish it out of tool calls.
    if (!isError && name === "dm" && args && typeof (args as { text?: unknown }).text === "string") this.emit({ type: "dm", to: (args as { agent?: string }).agent, text: (args as { text: string }).text });
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
