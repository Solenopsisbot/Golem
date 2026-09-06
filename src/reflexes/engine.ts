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
  /** Do the thing. Return a one-line note for the inbox, or nothing. */
  act(p: Primitives, trigger: T): Promise<string | void>;
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private acting: { name: string; token: CancelToken } | null = null;
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
    if (this.acting) return;
    const m = this.ctx.mirror;
    if (!m.inWorld || !this.ctx.body.open) return;
    const now = Date.now();
    const ordered = [...this.reflexes.values()].filter((r) => this.enabled.has(r.name)).sort((a, b) => b.priority - a.priority);
    for (const r of ordered) {
      if (r.idleOnly && this.ctx.activity.busy) continue;
      if (r.cooldownMs && now - (this.lastFired.get(r.name) ?? 0) < r.cooldownMs) continue;
      let trigger: unknown;
      try { trigger = await r.check(this.ctx); } catch (e) { this.log.debug(`${r.name}.check threw: ${(e as Error).message}`); continue; }
      if (!trigger) continue;
      if (this.acting) return; // another tick got there first
      this.lastFired.set(r.name, now);
      const token = new CancelToken();
      this.acting = { name: r.name, token };
      if (r.interrupts) this.opts.preempt(`reflex ${r.name}`);
      const p = makePrimitives(withToken(this.ctx, token));
      this.ctx.trace.mark("reflex", { name: r.name, phase: "start", trigger });
      void (async () => {
        try {
          const note = await r.act(p, trigger);
          const text = note ?? `${r.name} fired`;
          this.log.info(`reflex ${r.name}: ${text}`);
          this.ctx.trace.mark("reflex", { name: r.name, phase: "end", note: text });
          this.opts.onFire?.({ name: r.name, note: text, at: Date.now(), trigger });
        } catch (e) {
          const msg = e instanceof GolemError ? `${e.kind}: ${e.message}` : String(e);
          this.log.warn(`reflex ${r.name} failed: ${msg}`);
          this.ctx.trace.mark("reflex", { name: r.name, phase: "error", error: msg });
        } finally {
          this.acting = null;
        }
      })();
      return;
    }
  }
}
