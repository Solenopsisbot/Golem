// Typed failures shared by primitives, reflexes, the MCP tools and Shem. The `kind` is the stable
// thing callers branch on; `message` is for humans and models.

export type ErrorKind =
  | "timeout"        // the world didn't agree in time
  | "unreachable"    // pathing gave up
  | "not_found"      // no such block/entity/item/place
  | "missing_item"   // inventory lacks what the action needs
  | "cant_place"     // placement rejected or didn't take
  | "cant_break"     // block won't break (bedrock, wrong tool, gave up)
  | "blocked"        // something occupies the target (a block, a screen, an entity)
  | "cancelled"      // caller cancelled (met, shem_cancel, turn cancel)
  | "preempted"      // a higher-priority run or reflex took over
  | "unsupported"    // the body lacks a command; see docs/CLEF-CHANGES.md
  | "policy"         // etiquette/chat policy refused it
  | "clef"           // the body returned an error code
  | "failed";        // generic

export class GolemError extends Error {
  readonly kind: ErrorKind;
  readonly code?: string;       // Clef error code when kind === "clef"
  readonly detail?: unknown;
  constructor(kind: ErrorKind, message: string, opts: { code?: string; detail?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GolemError";
    this.kind = kind;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
  static is(e: unknown, kind?: ErrorKind): e is GolemError {
    return e instanceof GolemError && (kind === undefined || e.kind === kind);
  }
  toJSON() {
    return { kind: this.kind, message: this.message, code: this.code };
  }
}

/** Cooperative cancellation. Every await point in a primitive checks its token. */
export class CancelToken {
  private _cancelled = false;
  private _reason = "";
  private readonly listeners = new Set<(reason: string) => void>();
  readonly parent?: CancelToken;

  constructor(parent?: CancelToken) {
    if (parent) {
      this.parent = parent;
      parent.onCancel((r) => this.cancel(r));
    }
  }
  get cancelled(): boolean { return this._cancelled; }
  get reason(): string { return this._reason; }
  cancel(reason = "cancelled"): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    for (const l of this.listeners) { try { l(reason); } catch { /* listener's problem */ } }
    this.listeners.clear();
  }
  onCancel(l: (reason: string) => void): () => void {
    if (this._cancelled) { l(this._reason); return () => {}; }
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  throwIfCancelled(): void {
    if (this._cancelled) throw new GolemError("cancelled", this._reason || "cancelled");
  }
  child(): CancelToken { return new CancelToken(this); }
  static none(): CancelToken { return new CancelToken(); }
}

export function sleep(ms: number, token?: CancelToken): Promise<void> {
  return new Promise((resolve, reject) => {
    if (token?.cancelled) return reject(new GolemError("cancelled", token.reason));
    const t = setTimeout(() => { off?.(); resolve(); }, ms);
    const off = token?.onCancel((r) => { clearTimeout(t); reject(new GolemError("cancelled", r)); });
  });
}

/** Rejects with a `timeout` GolemError if `p` doesn't settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new GolemError("timeout", `${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

export interface UntilOpts {
  intervalMs?: number;
  timeoutMs: number;
  token?: CancelToken;
  what: string;
  /** Called on timeout instead of throwing, if you'd rather resolve with a fallback. */
  onTimeout?: () => never | void;
}

/** Polls `pred` until it returns a truthy value. Resolves with that value. */
export async function until<T>(pred: () => T | Promise<T>, opts: UntilOpts): Promise<NonNullable<T>> {
  const start = Date.now();
  const interval = opts.intervalMs ?? 200;
  for (;;) {
    opts.token?.throwIfCancelled();
    const v = await pred();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start >= opts.timeoutMs) {
      if (opts.onTimeout) opts.onTimeout();
      throw new GolemError("timeout", `${opts.what} timed out after ${opts.timeoutMs} ms`);
    }
    await sleep(interval, opts.token);
  }
}

/** Translate a body-level ClefError-ish into a GolemError with a sensible kind. */
export function fromClef(e: unknown, what: string): GolemError {
  if (e instanceof GolemError) return e;
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? String(e);
  switch (code) {
    case "NOT_FOUND": return new GolemError("not_found", `${what}: ${msg}`, { code, cause: e });
    case "UNKNOWN_COMMAND": return new GolemError("unsupported", `${what}: the body lacks this command (${msg})`, { code, cause: e });
    case "NOT_IN_WORLD":
    case "NOT_CONNECTED": return new GolemError("blocked", `${what}: ${msg}`, { code, cause: e });
    case undefined: return new GolemError("failed", `${what}: ${msg}`, { cause: e });
    default: return new GolemError("clef", `${what}: [${code}] ${msg}`, { code, cause: e });
  }
}
