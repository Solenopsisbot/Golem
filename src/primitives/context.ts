// Everything a primitive needs, bundled. One Ctx per agent; `withToken` derives a child for a
// cancellable unit of work (a shell command, a reflex action, later a Shem run).
import minecraftData from "minecraft-data";
import type { BodyClient } from "../body/client.ts";
import type { Mirror } from "../body/mirror.ts";
import type { TraceWriter } from "../body/trace.ts";
import type { AgentConfig } from "../config/schema.ts";
import { parseRate } from "../config/schema.ts";
import type { Logger } from "../util/log.ts";
import { CancelToken, GolemError, sleep } from "./errors.ts";

export const MC_VERSION = "1.21.8";
export type McData = ReturnType<typeof minecraftData>;

let cachedData: McData | undefined;
export function mcData(): McData {
  if (!cachedData) cachedData = minecraftData(MC_VERSION);
  return cachedData;
}

/** Counts foreground work so idle-only reflexes know when to stay out of the way. */
export class Activity {
  private n = 0;
  current: string | null = null;
  get busy(): boolean { return this.n > 0; }
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.n++;
    const prev = this.current;
    this.current = label;
    try { return await fn(); }
    finally { this.n--; this.current = this.n > 0 ? prev : null; }
  }
}

/** Token bucket used for chat. `acquire` waits (up to maxWaitMs) rather than dropping. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private readonly count: number;
  private readonly perMs: number;
  constructor(rate: string) {
    const r = parseRate(rate);
    this.count = r.count;
    this.perMs = r.perMs;
    this.tokens = r.count;
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.count, this.tokens + ((now - this.last) / this.perMs) * this.count);
    this.last = now;
  }
  async acquire(token?: CancelToken, maxWaitMs = 10_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      if (Date.now() - start > maxWaitMs) throw new GolemError("policy", "chat rate limit: waited too long for a slot");
      await sleep(Math.min(250, this.perMs / this.count), token);
    }
  }
}

export interface Ctx {
  readonly agent: AgentConfig;
  readonly body: BodyClient;
  readonly mirror: Mirror;
  readonly trace: TraceWriter;
  readonly log: Logger;
  readonly mc: McData;
  readonly activity: Activity;
  readonly chatLimiter: RateLimiter;
  readonly token: CancelToken;
}

export function withToken(ctx: Ctx, token: CancelToken): Ctx {
  return { ...ctx, token };
}

/** "oak_log" -> "minecraft:oak_log"; leaves other namespaces alone. */
export function fullId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}
/** "minecraft:oak_log" -> "oak_log". */
export function shortId(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}
