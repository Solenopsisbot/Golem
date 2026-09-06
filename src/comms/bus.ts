// The agent bus: how golems in one Golem process talk to each other without spamming server chat.
// A message becomes an inbox item on the recipient's drive. Pairs are rate-capped so two agents
// can't loop forever agreeing with each other: at most `max_turns` messages per pair per
// `cooldown` window, after which both sides are told the conversation is paused.
import { parseDuration } from "../config/schema.ts";

export interface BusMessage { from: string; to: string; text: string; t: number }
export interface BusPeer {
  name: string;
  /** Deliver a message to this agent (usually: push into its inbox). */
  deliver(msg: BusMessage): void;
  /** One-line state for `agents()`. */
  state(): string;
  /** Say something in game as this agent (used to mirror bus traffic for spectators). */
  say?(text: string): Promise<unknown>;
}

export interface BusOptions {
  maxTurns?: number;
  cooldownMs?: number;
  /** comms.agents = "both": every dm is also said in public chat as "<to>: <text>" so players can watch. */
  mirrorInGame?: boolean;
}

export class AgentBus {
  private readonly peers = new Map<string, BusPeer>();
  private readonly pairs = new Map<string, { count: number; windowStart: number; paused: boolean }>();
  private readonly maxTurns: number;
  private readonly cooldownMs: number;
  readonly mirrorInGame: boolean;
  readonly log: BusMessage[] = [];

  constructor(opts: BusOptions = {}) {
    this.maxTurns = opts.maxTurns ?? 12;
    this.cooldownMs = opts.cooldownMs ?? parseDuration("2m");
    this.mirrorInGame = !!opts.mirrorInGame;
  }

  register(peer: BusPeer): () => void {
    this.peers.set(peer.name, peer);
    return () => { this.peers.delete(peer.name); };
  }
  names(): string[] { return [...this.peers.keys()]; }
  has(name: string): boolean { return this.peers.has(name); }
  roster(except?: string): string {
    const rows = [...this.peers.values()].filter((p) => p.name !== except).map((p) => `${p.name}: ${p.state()}`);
    return rows.length ? rows.join("\n") : "no other agents in this fleet";
  }

  private pairKey(a: string, b: string): string { return [a, b].sort().join("|"); }

  /** Returns the number of messages left in this pair's window, or 0 when paused. */
  remaining(a: string, b: string): number {
    const p = this.pairs.get(this.pairKey(a, b));
    if (!p) return this.maxTurns;
    if (Date.now() - p.windowStart > this.cooldownMs) return this.maxTurns;
    return Math.max(0, this.maxTurns - p.count);
  }

  /**
   * Send a direct message. Throws when the recipient is unknown or the pair is paused.
   * Returns how many messages remain before the pause.
   */
  send(from: string, to: string, text: string): { remaining: number } {
    const peer = this.peers.get(to);
    if (!peer) throw new Error(`no agent named ${to} in this fleet (have: ${this.names().filter((n) => n !== from).join(", ") || "nobody"})`);
    if (to === from) throw new Error("that's you");
    const key = this.pairKey(from, to);
    const now = Date.now();
    let p = this.pairs.get(key);
    if (!p || now - p.windowStart > this.cooldownMs) { p = { count: 0, windowStart: now, paused: false }; this.pairs.set(key, p); }
    if (p.count >= this.maxTurns) {
      const wait = Math.ceil((p.windowStart + this.cooldownMs - now) / 1000);
      throw new Error(`conversation with ${to} is paused (${this.maxTurns} messages in this window); try again in ${wait}s or go do something`);
    }
    p.count++;
    const msg: BusMessage = { from, to, text, t: now };
    this.log.push(msg);
    if (this.log.length > 500) this.log.shift();
    peer.deliver(msg);
    if (this.mirrorInGame) void this.peers.get(from)?.say?.(`${to}: ${text}`)?.catch(() => { /* chat is best-effort */ });
    const remaining = this.maxTurns - p.count;
    if (remaining === 0) {
      // Tell both sides once so neither waits on a reply that can't come.
      const note = `(conversation between ${from} and ${to} paused for ${Math.round(this.cooldownMs / 60000)} min: ${this.maxTurns} messages exchanged)`;
      peer.deliver({ from: "golem", to, text: note, t: now });
      this.peers.get(from)?.deliver({ from: "golem", to: from, text: note, t: now });
    }
    return { remaining };
  }

  /** Message every other agent. */
  broadcast(from: string, text: string): string[] {
    const sent: string[] = [];
    for (const name of this.names()) if (name !== from) { try { this.send(from, name, text); sent.push(name); } catch { /* paused or gone */ } }
    return sent;
  }
}
