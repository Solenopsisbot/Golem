// One running agent: config + body + mirror + trace + primitives + reflexes. The mind (ACP) and
// the MCP server attach here in M2.
import { mkdirSync } from "node:fs";
import { BodyClient } from "../body/client.ts";
import { Mirror } from "../body/mirror.ts";
import { TraceWriter } from "../body/trace.ts";
import type { AgentConfig } from "../config/schema.ts";
import { ensureTokens } from "../config/load.ts";
import { Activity, RateLimiter, mcData, withToken, type Ctx } from "../primitives/context.ts";
import { CancelToken, GolemError, until } from "../primitives/errors.ts";
import { makePrimitives, type Primitives } from "../primitives/index.ts";
import { ReflexEngine, type ReflexEvent } from "../reflexes/engine.ts";
import { BUILTIN_REFLEXES } from "../reflexes/builtin.ts";
import { makeLog, type Logger } from "../util/log.ts";
import type { Drive } from "../drive/drive.ts";
import type { ShemEngine } from "../shem/engine.ts";

export interface RuntimeEvents {
  reflex?: (ev: ReflexEvent) => void;
}

export class AgentRuntime {
  readonly agent: AgentConfig;
  readonly log: Logger;
  readonly body: BodyClient;
  readonly mirror: Mirror;
  readonly trace: TraceWriter;
  readonly ctx: Ctx;
  readonly reflexes: ReflexEngine;
  /** Set by AgentSession when a mind is attached; tools use it for the state header. */
  drive: Drive | undefined;
  /** The Shem engine, when scripts are enabled (AgentSession and the shell create it). */
  shem: ShemEngine | undefined;
  /** Foreground cancel token: shell commands and (later) Shem runs derive from it. Rotated on preempt. */
  private fg = new CancelToken();
  private stopping = false;
  private readonly hooks: RuntimeEvents;

  constructor(agent: AgentConfig, hooks: RuntimeEvents = {}) {
    this.agent = agent;
    this.hooks = hooks;
    this.log = makeLog(agent.name);
    mkdirSync(agent.dataDir, { recursive: true });
    const tokens = ensureTokens(agent);
    this.trace = new TraceWriter(agent.tracePath);
    this.body = new BodyClient({
      host: agent.body.host, port: agent.body.port, token: tokens.clef,
      trace: this.trace, log: this.log.child("body"), name: agent.name,
    });
    this.mirror = new Mirror(this.body, this.log.child("mirror"));
    this.ctx = {
      agent, body: this.body, mirror: this.mirror, trace: this.trace, log: this.log,
      mc: mcData(), activity: new Activity(), chatLimiter: new RateLimiter(agent.chat.rate), token: this.fg,
    };
    this.reflexes = new ReflexEngine({
      ctx: this.ctx, log: this.log.child("reflex"),
      preempt: (reason) => this.preempt(reason),
      onFire: (ev) => this.hooks.reflex?.(ev),
    });
    for (const r of BUILTIN_REFLEXES) this.reflexes.register(r);
    for (const name of agent.reflexes.on) {
      try { this.reflexes.enable(name); } catch { this.log.warn(`unknown reflex in config: ${name}`); }
    }
  }

  /** Primitives bound to the current foreground token. Grab a fresh one per command. */
  get p(): Primitives { return makePrimitives(withToken(this.ctx, this.fg)); }
  get foregroundToken(): CancelToken { return this.fg; }

  preempt(reason: string): void {
    const old = this.fg;
    this.fg = new CancelToken();
    old.cancel(reason);
    this.trace.mark("preempt", { reason });
  }

  /** Connect to the body (waiting through a cold boot if needed), then get it into the world. */
  async start(opts: { waitForBodyMs?: number } = {}): Promise<void> {
    this.mirror.attach();
    const attempts = Math.max(1, Math.ceil((opts.waitForBodyMs ?? 600_000) / 3000));
    this.log.info(`connecting to body at ${this.body.url}`);
    let lastNote = 0;
    await this.body.connectRetry({
      attempts, initialDelayMs: 1000, maxDelayMs: 3000,
      onAttempt: (n) => { if (Date.now() - lastNote > 15_000) { lastNote = Date.now(); this.log.info(`body not up yet (attempt ${n}); waiting`); } },
    });
    this.log.info(`body up: protocol ${this.body.protocol}, ${this.body.caps.commands.size} commands, findBlocks=${this.body.caps.has("findBlocks")} craft=${this.body.caps.has("craft")}`);
    await this.assertOwnBody();
    await this.body.subscribe();
    this.mirror.startPolling(1000);
    await this.mirror.refresh();
    this.body.on("disconnected", () => { if (!this.stopping) void this.rejoinLater(); });
    // A restarted body comes back on the title screen: get it into the world again.
    this.body.on("_reconnected", () => { if (!this.stopping) void this.ensureInWorld().catch((e) => this.log.error(`rejoin after reconnect failed: ${(e as Error).message}`)); });
    await this.ensureInWorld();
    this.reflexes.start();
  }

  /**
   * Make sure the thing on our control port is OUR body. Our bodies always have a token, and log in
   * with the agent's username; anything else is another project's bot that happens to hold the
   * port (it happened: an unauthenticated e2e client, and we walked it across its test world).
   */
  private async assertOwnBody(): Promise<void> {
    if (!this.agent.body.attach && !this.body.requiresAuth) {
      this.body.close();
      throw new GolemError("blocked", `the body on ${this.body.url} has no auth token, so it isn't ours; another process holds port ${this.agent.body.port}`);
    }
    const who = (await this.body.call("auth.status").catch(() => null)) as { username?: string } | null;
    if (who?.username && who.username !== this.agent.body.username) {
      this.body.close();
      throw new GolemError("blocked", `the body on ${this.body.url} is logged in as ${who.username}, not ${this.agent.body.username}; refusing to drive it`);
    }
  }

  /** If the bot is on a menu, ask it to connect to the configured server and wait for the world. */
  async ensureInWorld(timeoutMs = 90_000): Promise<void> {
    const s = await this.mirror.refresh();
    if (s.inWorld) return;
    const busy = /Connect|Downloading|Progress|Receiving/i.test(s.screen ?? "");
    if (!busy) {
      const { host, port } = this.agent.body.server;
      this.log.info(`not in a world (screen ${s.screen}); connecting to ${host}:${port}`);
      await this.body.call("connect", { host, port });
    }
    await until(() => this.mirror.inWorld, { timeoutMs, intervalMs: 500, what: "joining the world" });
    this.log.info(`in world: ${this.mirror.summary(this.agent.name)}`);
  }

  private async rejoinLater(): Promise<void> {
    this.log.warn("disconnected from the server; rejoining in 5 s");
    await new Promise((r) => setTimeout(r, 5000));
    if (this.stopping) return;
    try { await this.ensureInWorld(); } catch (e) { this.log.error(`rejoin failed: ${(e as Error).message}`); void this.rejoinLater(); }
  }

  /** The kill switch. Cancels everything and stops all motion. Never throws. */
  async met(): Promise<void> {
    this.trace.mark("met");
    this.preempt("met");
    this.shem?.runs.cancel(undefined, "met");
    this.reflexes.cancelActive("met");
    try { await this.p.stop(); } catch { /* still stopped as much as we could */ }
    this.log.warn("met: everything stopped");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.reflexes.stop();
    this.mirror.stopPolling();
    this.preempt("shutdown");
    this.body.close();
    this.trace.close();
  }

  /** Run a foreground unit of work with a fresh child token; turns preemption into a typed error. */
  async foreground<T>(label: string, fn: (p: Primitives) => Promise<T>): Promise<T> {
    const token = this.fg.child();
    const p = makePrimitives(withToken(this.ctx, token));
    try { return await fn(p); }
    catch (e) {
      if (GolemError.is(e, "cancelled") && token.cancelled && token.reason.startsWith("reflex")) {
        throw new GolemError("preempted", `${label} was preempted by ${token.reason}`, { cause: e });
      }
      throw e;
    }
  }
}
