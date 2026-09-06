// Typed WebSocket client for a MezzoSopranoClef body.
//
// Owns: the handshake, `hello` auth, request-id correlation, per-call timeouts, event dispatch,
// reconnect with backoff, capability probing (which commands/args/events this body actually has),
// and a trace hook. Everything above this layer talks in terms of ClefCommands/ClefEvents from the
// generated schema and never touches the socket.
//
// Uses the global WebSocket (Node >= 22, Bun, browsers). No dependencies.
import type { ClefCommands, ClefCommandName, ClefEvents, ClefEventName, ClefErrorCode } from "./schema.gen.ts";
import type { SchemaResult } from "./results.ts";
import { makeLog, type Logger } from "../util/log.ts";
import type { TraceWriter } from "./trace.ts";

export class ClefError extends Error {
  readonly code: ClefErrorCode | string;
  readonly detail: string;
  readonly cmd: string | undefined;
  constructor(code: ClefErrorCode | string, detail: string, cmd?: string) {
    super(`${cmd ? cmd + ": " : ""}[${code}] ${detail}`);
    this.name = "ClefError";
    this.code = code;
    this.detail = detail;
    this.cmd = cmd;
  }
}

export interface BodyClientOptions {
  host?: string;
  port?: number;
  url?: string;
  token?: string;
  timeoutMs?: number;
  trace?: TraceWriter;
  log?: Logger;
  /** Reconnect automatically after an unexpected close (default true). */
  autoReconnect?: boolean;
  name?: string;
}

type Handler = (data: any, event: string) => void;
interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; cmd: string }

/** Internal lifecycle events emitted alongside Clef's own. */
export type BodyLifecycleEvent = "_open" | "_close" | "_reconnected";

/** What the body told us it can do. Primitives consult this to choose real command vs fallback. */
export class Capabilities {
  readonly commands = new Map<string, Set<string>>(); // cmd -> arg names
  readonly events = new Set<string>();
  protocol = 0;
  has(cmd: string): boolean { return this.commands.has(cmd); }
  hasArg(cmd: string, arg: string): boolean { return this.commands.get(cmd)?.has(arg) ?? false; }
  hasEvent(ev: string): boolean { return this.events.has(ev); }
  load(schema: SchemaResult): void {
    this.commands.clear();
    this.events.clear();
    this.protocol = schema.protocol;
    for (const c of schema.commands) this.commands.set(c.name, new Set((c.args ?? []).map((a) => a.name)));
    for (const e of schema.events) this.events.add(e.name);
  }
}

export class BodyClient {
  readonly url: string;
  readonly name: string;
  readonly caps = new Capabilities();
  protocol?: number;
  requiresAuth = false;

  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly trace?: TraceWriter;
  private readonly log: Logger;
  private readonly autoReconnect: boolean;
  private ws?: WebSocket;
  private id = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();
  private subscriptions: string[] | "all" | null = null;
  private closedByUs = false;
  private reconnecting = false;

  constructor(opts: BodyClientOptions = {}) {
    this.url = opts.url ?? `ws://${opts.host ?? "127.0.0.1"}:${opts.port ?? 8731}`;
    this.name = opts.name ?? this.url;
    if (opts.token) this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (opts.trace) this.trace = opts.trace;
    this.log = opts.log ?? makeLog(`body:${this.name}`);
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  // ---- lifecycle ------------------------------------------------------------------

  /** Open the socket, read `welcome`, authenticate, probe capabilities. */
  connect(): Promise<void> {
    if (!this.reconnecting) this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      let opened = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new ClefError("COMMAND_FAILED", `connect timeout after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };

      ws.onmessage = (ev: MessageEvent) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (typeof msg.event === "string") {
          if (msg.event === "welcome") {
            this.protocol = msg.data?.protocol;
            this.requiresAuth = !!msg.data?.requiresAuth;
            this.dispatch("welcome", msg.data ?? {});
            this.afterWelcome().then(() => done(), done);
            return;
          }
          this.trace?.record({ kind: "ev", ev: msg.event, data: msg.data });
          this.dispatch(msg.event, msg.data ?? {});
          return;
        }
        const p = msg.id != null ? this.pending.get(String(msg.id)) : undefined;
        if (!p) return;
        this.pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) {
          this.trace?.record({ kind: "res", id: msg.id, cmd: p.cmd, result: summarise(msg.result) });
          p.resolve(msg.result);
        } else {
          this.trace?.record({ kind: "err", id: msg.id, cmd: p.cmd, code: msg.code, error: msg.error });
          p.reject(new ClefError(msg.code ?? "COMMAND_FAILED", msg.error ?? "", p.cmd));
        }
      };
      ws.onerror = () => done(new Error(`failed to connect to ${this.url}`));
      ws.onclose = () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new ClefError("NOT_CONNECTED", "connection closed", p.cmd));
        }
        this.pending.clear();
        done(new ClefError("NOT_CONNECTED", "connection closed before welcome"));
        if (!opened) return; // never connected: connectRetry owns the retry
        this.dispatch("_close", {});
        if (!this.closedByUs && this.autoReconnect) void this.reconnectLoop();
      };
      ws.onopen = () => { opened = true; this.dispatch("_open", {}); };
    });
  }

  private async afterWelcome(): Promise<void> {
    if (this.requiresAuth) {
      if (!this.token) throw new ClefError("UNAUTHORIZED", "body requires a token and none was configured");
      await this.call("hello", { token: this.token } as never);
    }
    try {
      const schema = await this.call("schema") as SchemaResult;
      this.caps.load(schema);
    } catch (e) {
      this.log.warn(`schema probe failed (${(e as Error).message}); capabilities unknown`);
    }
    if (this.subscriptions) await this.resubscribe();
  }

  async connectRetry(opts: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number; onAttempt?: (n: number, e: unknown) => void } = {}): Promise<void> {
    const attempts = Math.max(1, opts.attempts ?? 30);
    let delay = opts.initialDelayMs ?? 500;
    const maxDelay = opts.maxDelayMs ?? 5000;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      if (this.closedByUs) throw new ClefError("NOT_CONNECTED", "closed while reconnecting");
      try { await this.connect(); return; }
      catch (e) {
        last = e;
        opts.onAttempt?.(i + 1, e);
        this.ws?.close();
        if (this.closedByUs) throw new ClefError("NOT_CONNECTED", "closed while reconnecting");
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(maxDelay, delay * 2);
      }
    }
    throw last instanceof Error ? last : new Error(`failed to connect after ${attempts} attempts`);
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.log.warn("connection lost; reconnecting");
    try {
      await this.connectRetry({ attempts: 1_000_000, initialDelayMs: 1000, maxDelayMs: 10_000 });
      this.log.info("reconnected");
      this.dispatch("_reconnected", {});
    } finally {
      this.reconnecting = false;
    }
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }
  /** connect() clears closedByUs; connectRetry honours it so close() can abort a reconnect loop. */

  // ---- calls ----------------------------------------------------------------------

  /** Send a typed command. Rejects with ClefError on `ok:false`, timeout, or disconnect. */
  call<K extends ClefCommandName>(cmd: K, args?: ClefCommands[K], opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Untyped escape hatch for commands newer than the generated schema. */
  call(cmd: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
  call(cmd: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ClefError("NOT_CONNECTED", "not connected", cmd));
    }
    const mid = String(++this.id);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    this.trace?.record({ kind: "cmd", id: mid, cmd, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(mid);
        reject(new ClefError("COMMAND_FAILED", `timeout after ${timeoutMs} ms`, cmd));
      }, timeoutMs);
      this.pending.set(mid, { resolve, reject, timer, cmd });
      ws.send(JSON.stringify({ id: mid, cmd, args }));
    });
  }

  /** Like call(), but resolves undefined instead of rejecting when the body lacks the command. */
  async tryCall(cmd: string, args: Record<string, unknown> = {}, opts?: { timeoutMs?: number }): Promise<unknown | undefined> {
    if (this.caps.commands.size > 0 && !this.caps.has(cmd)) return undefined;
    try { return await this.call(cmd, args, opts); }
    catch (e) { if (e instanceof ClefError && e.code === "UNKNOWN_COMMAND") return undefined; throw e; }
  }

  // ---- events ---------------------------------------------------------------------

  on<E extends ClefEventName>(event: E, handler: (data: ClefEvents[E], event: string) => void): () => void;
  on(event: BodyLifecycleEvent | string, handler: Handler): () => void;
  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }
  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }
  private dispatch(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach((h) => { try { h(data, event); } catch (e) { this.log.error(`handler for ${event} threw`, e); } });
    this.anyHandlers.forEach((h) => { try { h(data, event); } catch (e) { this.log.error(`any-handler threw on ${event}`, e); } });
  }

  /** Subscribe to events (none = everything). Remembered across reconnects. */
  async subscribe(...events: string[]): Promise<void> {
    this.subscriptions = events.length ? events : "all";
    await this.resubscribe();
  }
  private async resubscribe(): Promise<void> {
    if (!this.subscriptions) return;
    if (this.subscriptions === "all") await this.call("subscribe", {});
    else await this.call("subscribe", { events: this.subscriptions });
  }
}

/** Keep traces readable: elide base64 blobs and giant arrays. */
function summarise(result: unknown): unknown {
  if (result && typeof result === "object") {
    if (Array.isArray(result)) return result.length > 50 ? { array: result.length } : result;
    const r = result as Record<string, unknown>;
    if (typeof r.base64 === "string") return { ...r, base64: `<${r.base64.length} chars>` };
  }
  return result;
}
