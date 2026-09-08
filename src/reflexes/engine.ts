// The reflex engine: Mindcraft's "modes", run as deterministic code with no model in the loop.
// Reflexes are checked every 250 ms in priority order. One acts at a time. Those marked
// `interrupts` cancel the foreground work (a shell command, later a Shem run) before acting; the
// rest only run when nothing else is happening (`idleOnly`) or alongside it.
//
// Later (M3) these move to shem/reflexes/*.shem; the engine stays the same.
import type { Ctx } from "../primitives/context.ts";
import { withToken } from "../primitives/context.ts";
import { CancelToken, GolemError } from "../primitives/errors.ts";
import { makePrimitives, type Primitives } from "../primitives/index.ts";
import type { Logger } from "../util/log.ts";

export interface Reflex<T = unknown> {
  name: string;
  description: string;
  priority: number;          // higher wins
  idleOnly?: boolean;        // only when no foreground work is running
  interrupts?: boolean;      // cancel foreground work before acting
  cooldownMs?: number;       // minimum gap between firings
  /** Cheap check on the mirror. Return a truthy trigger to act. */
  check(ctx: Ctx): T | null | undefined | false | Promise<T | null | undefined | false>;
  /** Do the thing. Return a one-line note for the inbox, or nothing (nothing = don't tell the mind). */
  act(p: Primitives, trigger: T): Promise<string | void>;
  /** Tell the mind even when act() returns nothing (default: only interrupting reflexes). */
  notify?: boolean;
}

export interface ReflexEvent { name: string; note: string; at: number; trigger: unknown }

export interface ReflexEngineOptions {
  ctx: Ctx;
  log: Logger;
  /** Cancel whatever foreground work is running. Called before an interrupting reflex acts. */
  preempt: (reason: string) => void;
  onFire?: (ev: ReflexEvent) => void;
  intervalMs?: number;
}

export class ReflexEngine {
  private readonly reflexes = new Map<string, Reflex<any>>();
  private readonly enabled = new Set<string>();
  private readonly lastFired = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private acting: { name: string; token: CancelToken; priority: number } | null = null;
  private readonly opts: ReflexEngineOptions;
  private readonly ctx: Ctx;
  private readonly log: Logger;

  constructor(opts: ReflexEngineOptions) {
    this.opts = opts;
    this.ctx = opts.ctx;
    this.log = opts.log;
  }

  register(r: Reflex<any>): void { this.reflexes.set(r.name, r); }
  enable(name: string, on = true): void {
    if (!this.reflexes.has(name)) throw new GolemError("not_found", `no reflex named ${name}`);
    if (on) this.enabled.add(name); else this.enabled.delete(name);
  }
  isEnabled(name: string): boolean { return this.enabled.has(name); }
  list(): { name: string; description: string; priority: number; on: boolean; active: boolean }[] {
    return [...this.reflexes.values()].sort((a, b) => b.priority - a.priority).map((r) => ({
      name: r.name, description: r.description, priority: r.priority, on: this.enabled.has(r.name), active: this.acting?.name === r.name,
    }));
  }
  get active(): string | null { return this.acting?.name ?? null; }

  /** How many times each reflex has acted this session, most-fired first. */
  private readonly fireCounts = new Map<string, number>();
  fired(): { name: string; n: number }[] {
    return [...this.fireCounts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs ?? 250);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Cancel a running reflex action (used by met). */
  cancelActive(reason = "met"): void {
    this.acting?.token.cancel(reason);
  }

  private async tick(): Promise<void> {
    const m = this.ctx.mirror;
    if (!m.inWorld || !this.ctx.body.open) return;
    const now = Date.now();
    const ordered = [...this.reflexes.values()].filter((r) => this.enabled.has(r.name)).sort((a, b) => b.priority - a.priority);
    for (const r of ordered) {
      // While something is acting, only strictly higher-priority reflexes are considered; if one
      // triggers it cancels the running action (a bunker beats walking to a dropped item).
      if (this.acting && r.priority <= this.acting.priority) return;
      if (r.idleOnly && this.ctx.activity.busy) continue;
      // Cooldown doubles after each consecutive failure (max ~4 min), so a reflex that can't act
      // (no food, no bed) doesn't hammer the body every few seconds.
      const fails = this.failures.get(r.name) ?? 0;
      const cooldown = (r.cooldownMs ?? 0) * 2 ** Math.min(fails, 5);
      if (cooldown && now - (this.lastFired.get(r.name) ?? 0) < cooldown) continue;
      let trigger: unknown;
      try { trigger = await r.check(this.ctx); } catch (e) { this.log.debug(`${r.name}.check threw: ${(e as Error).message}`); continue; }
      if (!trigger) continue;
      if (this.acting) {
        if (r.priority <= this.acting.priority) return; // another tick got there first
        this.log.info(`reflex ${r.name} (p${r.priority}) overrides ${this.acting.name} (p${this.acting.priority})`);
        this.acting.token.cancel(`overridden by reflex ${r.name}`);
      }
      this.lastFired.set(r.name, now);
      const token = new CancelToken();
      const mine = { name: r.name, token, priority: r.priority };
      this.acting = mine;
      if (r.interrupts) this.opts.preempt(`reflex ${r.name}`);
      const p = makePrimitives(withToken(this.ctx, token));
      this.ctx.trace.mark("reflex", { name: r.name, phase: "start", trigger });
      void (async () => {
        try {
          const note = await r.act(p, trigger);
          this.fireCounts.set(r.name, (this.fireCounts.get(r.name) ?? 0) + 1);
          const text = note ?? `${r.name} fired`;
          if (note || r.interrupts) this.log.info(`reflex ${r.name}: ${text}`); else this.log.debug(`reflex ${r.name}: ${text}`);
          this.ctx.trace.mark("reflex", { name: r.name, phase: "end", note: text });
          this.failures.delete(r.name);
          if (note || r.interrupts || r.notify) this.opts.onFire?.({ name: r.name, note: text, at: Date.now(), trigger });
        } catch (e) {
          const msg = e instanceof GolemError ? `${e.kind}: ${e.message}` : String(e);
          if (token.cancelled) { this.log.debug(`reflex ${r.name} stopped: ${token.reason}`); this.ctx.trace.mark("reflex", { name: r.name, phase: "cancelled", reason: token.reason }); return; }
          const n = (this.failures.get(r.name) ?? 0) + 1;
          this.failures.set(r.name, n);
          if (n <= 2) this.log.warn(`reflex ${r.name} failed: ${msg}`); else this.log.debug(`reflex ${r.name} failed (${n}x): ${msg}`);
          if (n === 3) this.opts.onFire?.({ name: r.name, note: `keeps failing: ${msg}`, at: Date.now(), trigger });
          this.ctx.trace.mark("reflex", { name: r.name, phase: "error", error: msg });
        } finally {
          if (this.acting === mine) this.acting = null;   // an override may already own the slot
        }
      })();
      return;
    }
  }
}
