// The Shem interpreter: an async tree walker. Every primitive call and every loop iteration is an
// await point that checks the run's cancel token; timeouts, parallel/race/spawn and `on` handlers
// are built on child tokens so cancelling a run stops everything it started.
import type { Arg, Block, EventRef, Expr, File, Loc, ScriptDecl, Stmt } from "./ast.ts";
import { fmtLoc } from "./ast.ts";
import { BUILTIN_BY_NAME, EVENTS, GETTER_BY_NAME, type BuiltinSpec } from "./builtins.ts";
import { CancelToken, GolemError, sleep } from "../primitives/errors.ts";
import { Closure, Dur, Env, RunHandle, ShemMap, Vec3, callMethod, equals, errorRecord, getProp, show, toDur, toNum, truthy, typeName, type Value } from "./values.ts";

export interface HostCallCtx { token: CancelToken; run: RunCtx }
export type HostFn = (args: Value[], named: Map<string, Value>, ctx: HostCallCtx) => Promise<Value> | Value;
export interface Host {
  /** Primitive implementations by builtin name. Missing names fall back to `unsupported`. */
  calls: Map<string, HostFn>;
  /** Root values (here, health, inventory...). */
  getters: Map<string, (ctx: HostCallCtx) => Promise<Value> | Value>;
  /** Subscribe to a Shem event name; the handler receives the event's argument values. */
  onEvent(name: string, handler: (args: Value[]) => void): () => void;
}

export interface RunCtx {
  id: string;
  token: CancelToken;
  log(line: string): void;
  trace(what: string, detail: string, ms?: number): void;
  budget: { deadline: number; calls: number; maxCalls: number; loops: number; maxLoops: number; depth: number; maxDepth: number };
  /** Background tasks started by spawn; cancelled when the run ends. */
  tasks: Set<RunHandle>;
  /** Error raised from an `on` handler; ends the run. */
  handlerError: GolemError | null;
}

class BreakSignal { }
class ContinueSignal { }
class ReturnSignal { value: Value; constructor(v: Value) { this.value = v; } }

export class ShemRuntimeError extends GolemError {
  readonly loc: Loc | undefined;
  constructor(kind: GolemError["kind"], message: string, loc?: Loc, opts?: { cause?: unknown; code?: string }) {
    super(kind, loc ? `${fmtLoc(loc)}: ${message}` : message, opts);
    this.loc = loc;
  }
}

function at(e: unknown, loc: Loc): GolemError {
  if (e instanceof ShemRuntimeError) return e;
  if (e instanceof GolemError) return new ShemRuntimeError(e.kind, e.message, loc, { cause: e, code: e.code });
  if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) throw e;
  return new ShemRuntimeError("failed", (e as Error)?.message ?? String(e), loc, { cause: e });
}

export interface Program {
  /** All scripts visible to a run: the entry file's plus everything it `use`s. */
  scripts: Map<string, ScriptDecl>;
  consts: { name: string; value: Expr }[];
}

export class Interpreter {
  private readonly host: Host;
  constructor(host: Host) { this.host = host; }

  /** Run a script by name with JSON-ish params. */
  async run(program: Program, scriptName: string, params: Record<string, Value>, run: RunCtx): Promise<Value> {
    const script = program.scripts.get(scriptName);
    if (!script) throw new GolemError("not_found", `no script named ${scriptName}`);
    const root = new Env();
    for (const c of program.consts) root.declare(c.name, await this.evalExpr(c.value, root, run), false);
    const fnEnv = root.child();
    for (const s of program.scripts.values()) fnEnv.declare(s.name, this.scriptClosure(s, fnEnv), false);
    const args: Value[] = [];
    const named = new Map<string, Value>(Object.entries(params));
    try {
      return await this.callScript(script, args, named, fnEnv, run, script.loc);
    } finally {
      for (const t of run.tasks) t.cancel("run ended");
    }
  }

  private scriptClosure(s: ScriptDecl, env: Env): Closure {
    const c = new Closure(s.params.map((p) => p.name), s.body, env);
    (c as unknown as { script: ScriptDecl }).script = s;
    return c;
  }

  private async callScript(s: ScriptDecl, args: Value[], named: Map<string, Value>, env: Env, run: RunCtx, loc: Loc): Promise<Value> {
    if (++run.budget.depth > run.budget.maxDepth) { run.budget.depth--; throw new ShemRuntimeError("failed", `recursion deeper than ${run.budget.maxDepth}`, loc); }
    const local = env.child();
    try {
      for (let i = 0; i < s.params.length; i++) {
        const p = s.params[i]!;
        let v: Value | undefined = i < args.length ? args[i] : named.get(p.name);
        if (v === undefined) {
          if (p.def) v = await this.evalExpr(p.def, local, run);
          else throw new ShemRuntimeError("failed", `${s.name}: missing argument ${p.name}`, loc);
        }
        if (p.type) v = coerceParam(v, p.type.name, p.name, s.name, loc);
        local.declare(p.name, v);
      }
      for (const k of named.keys()) if (!s.params.some((p) => p.name === k)) throw new ShemRuntimeError("failed", `${s.name}: unknown argument ${k}`, loc);
      try {
        await this.execBlock(s.body, local, run);
        return null;
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      }
    } finally {
      run.budget.depth--;
    }
  }

  // ---- statements -----------------------------------------------------------------

  async execBlock(b: Block, env: Env, run: RunCtx): Promise<void> {
    const scope = env.child();
    const cleanups: (() => void)[] = [];
    (scope as unknown as { cleanups: (() => void)[] }).cleanups = cleanups;
    try {
      for (const s of b.stmts) {
        this.checkAlive(run, s.loc);
        await this.exec(s, scope, run, cleanups);
      }
    } finally {
      for (const c of cleanups) c();
    }
  }

  private checkAlive(run: RunCtx, loc: Loc): void {
    if (run.handlerError) throw run.handlerError;
    if (run.token.cancelled) throw new ShemRuntimeError("cancelled", run.token.reason || "cancelled", loc);
    if (Date.now() > run.budget.deadline) throw new ShemRuntimeError("timeout", "run exceeded its time budget", loc);
  }

  private async exec(s: Stmt, env: Env, run: RunCtx, cleanups: (() => void)[]): Promise<void> {
    switch (s.kind) {
      case "var": env.declare(s.name, await this.evalExpr(s.value, env, run), s.mutable); return;
      case "assign": {
        let v = await this.evalExpr(s.value, env, run);
        if (s.op !== "=") { const cur = await this.evalExpr(s.target, env, run); v = binary(s.op === "+=" ? "+" : "-", cur, v, s.loc); }
        if (s.target.kind === "ident") { if (!env.assign(s.target.name, v)) throw new ShemRuntimeError("failed", `unknown variable ${s.target.name}`, s.loc); return; }
        if (s.target.kind === "member") { const obj = await this.evalExpr(s.target.obj, env, run); if (obj instanceof ShemMap) { obj.set(s.target.name, v); return; } if (obj && typeof obj === "object" && !Array.isArray(obj)) { (obj as Record<string, Value>)[s.target.name] = v; return; } throw new ShemRuntimeError("failed", `cannot set .${s.target.name} on ${typeName(obj)}`, s.loc); }
        if (s.target.kind === "index") { const obj = await this.evalExpr(s.target.obj, env, run); const idx = await this.evalExpr(s.target.index, env, run); if (Array.isArray(obj)) { obj[toNum(idx)] = v; return; } if (obj instanceof ShemMap) { obj.set(String(show(idx)), v); return; } throw new ShemRuntimeError("failed", `cannot index-assign ${typeName(obj)}`, s.loc); }
        return;
      }
      case "if": {
        if (truthy(await this.evalExpr(s.cond, env, run))) await this.execBranch(s.then, env, run);
        else if (s.else) await this.execBranch(s.else, env, run);
        return;
      }
      case "for": {
        const it = await this.evalExpr(s.iter, env, run);
        const list = Array.isArray(it) ? it : it instanceof ShemMap ? [...it.keys()] : typeof it === "string" ? [...it] : null;
        if (!list) throw new ShemRuntimeError("failed", `cannot iterate ${typeName(it)}`, s.loc);
        for (let i = 0; i < list.length; i++) {
          this.loopTick(run, s.loc);
          const scope = env.child();
          scope.declare(s.item, list[i]!);
          if (s.index) scope.declare(s.index, i);
          try { await this.execBlock(s.body, scope, run); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case "while": {
        while (truthy(await this.evalExpr(s.cond, env, run))) {
          this.loopTick(run, s.loc);
          try { await this.execBlock(s.body, env, run); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case "repeat": {
        const n = toNum(await this.evalExpr(s.count, env, run));
        for (let i = 0; i < n; i++) {
          this.loopTick(run, s.loc);
          try { await this.execBlock(s.body, env, run); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case "wait": { const ms = toDur(await this.evalExpr(s.duration, env, run)); await sleep(ms, run.token); return; }
      case "waitUntil": {
        const timeoutMs = s.timeout ? toDur(await this.evalExpr(s.timeout, env, run)) : Infinity;
        const start = Date.now();
        for (;;) {
          this.checkAlive(run, s.loc);
          if (truthy(await this.evalExpr(s.cond, env, run))) return;
          if (Date.now() - start >= timeoutMs) {
            if (s.else) { await this.execBlock(s.else, env, run); return; }
            throw new ShemRuntimeError("timeout", `wait until timed out after ${timeoutMs} ms`, s.loc);
          }
          await sleep(200, run.token);
        }
      }
      case "timeout": {
        const ms = toDur(await this.evalExpr(s.duration, env, run));
        const ok = await this.withTimeout(run, ms, (child) => this.execBlock(s.body, env, child), s.loc, !!s.else);
        if (!ok && s.else) await this.execBlock(s.else, env, run);
        return;
      }
      case "parallel": {
        const children = s.blocks.map(() => this.childRun(run));
        try {
          await Promise.all(s.blocks.map((b, i) => this.execBlock(b, env, children[i]!).catch((e) => { for (const c of children) c.token.cancel("sibling failed"); throw e; })));
        } finally { for (const c of children) c.token.cancel("parallel ended"); }
        return;
      }
      case "race": {
        const children = s.blocks.map(() => this.childRun(run));
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            for (let i = 0; i < s.blocks.length; i++) {
              this.execBlock(s.blocks[i]!, env, children[i]!).then(() => { if (!settled) { settled = true; resolve(); } }, (e) => { if (!settled) { settled = true; reject(e); } });
            }
          });
        } finally { for (const c of children) c.token.cancel("race ended"); }
        return;
      }
      case "spawn": {
        const child = this.childRun(run);
        const handle = new RunHandle(this.execBlock(s.body, env, child).then(() => null as Value), (reason) => child.token.cancel(reason));
        run.tasks.add(handle);
        handle.promise.catch(() => {}).finally(() => run.tasks.delete(handle));
        if (s.name) env.declare(s.name, handle);
        return;
      }
      case "try": {
        try {
          await this.execBlock(s.body, env, run);
        } catch (e) {
          if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) throw e;
          const err = e instanceof GolemError ? e : new ShemRuntimeError("failed", String((e as Error)?.message ?? e), s.loc);
          // cancelled / preempted may run cleanup but cannot be swallowed
          const fatal = err.kind === "cancelled" || err.kind === "preempted";
          if (s.catchBody && !fatal) {
            const scope = env.child();
            if (s.catchName) scope.declare(s.catchName, errorRecord(err));
            await this.execBlock(s.catchBody, scope, run);
          } else if (!s.catchBody || fatal) { if (s.finallyBody) await this.execBlock(s.finallyBody, env, run); throw err; }
        }
        if (s.finallyBody) await this.execBlock(s.finallyBody, env, run);
        return;
      }
      case "on": {
        const off = this.installHandler(s.event, s.when, s.body, env, run);
        cleanups.push(off);
        return;
      }
      case "break": throw new BreakSignal();
      case "continue": throw new ContinueSignal();
      case "return": throw new ReturnSignal(s.value ? await this.evalExpr(s.value, env, run) : null);
      case "fail": { const v = s.value ? await this.evalExpr(s.value, env, run) : "failed"; throw new ShemRuntimeError("failed", show(v), s.loc); }
      case "log": { run.log(show(await this.evalExpr(s.value, env, run))); return; }
      case "say": { await this.callBuiltin("say", [await this.evalExpr(s.value, env, run)], new Map(), run, s.loc); return; }
      case "expr": {
        if (s.timeout) {
          const ms = toDur(await this.evalExpr(s.timeout, env, run));
          await this.withTimeout(run, ms, (child) => this.evalExpr(s.expr, env, child), s.loc, false);
        } else await this.evalExpr(s.expr, env, run);
        return;
      }
    }
  }

  private async execBranch(b: Block | Stmt, env: Env, run: RunCtx): Promise<void> {
    if ("stmts" in b) await this.execBlock(b, env, run);
    else { const cleanups: (() => void)[] = []; try { await this.exec(b, env, run, cleanups); } finally { for (const c of cleanups) c(); } }
  }

  private loopTick(run: RunCtx, loc: Loc): void {
    this.checkAlive(run, loc);
    if (++run.budget.loops > run.budget.maxLoops) throw new ShemRuntimeError("failed", `loop budget of ${run.budget.maxLoops} iterations exceeded`, loc);
  }

  private childRun(run: RunCtx): RunCtx {
    return { ...run, token: run.token.child(), tasks: run.tasks };
  }

  /** Runs `fn` with a child token cancelled at the deadline. Returns false on timeout when `soft`. */
  private async withTimeout<T>(run: RunCtx, ms: number, fn: (child: RunCtx) => Promise<T>, loc: Loc, soft: boolean): Promise<boolean> {
    const child = this.childRun(run);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.token.cancel("timeout"); }, ms);
    try {
      await fn(child);
      return true;
    } catch (e) {
      if (timedOut) { if (soft) return false; throw new ShemRuntimeError("timeout", `timed out after ${ms} ms`, loc); }
      throw e;
    } finally { clearTimeout(timer); }
  }

  private installHandler(ev: EventRef, when: Expr | null, body: Block, env: Env, run: RunCtx): () => void {
    const argNames = EVENTS[ev.name];
    if (!argNames) throw new ShemRuntimeError("failed", `unknown event ${ev.name}`, ev.loc);
    return this.host.onEvent(ev.name, (values) => {
      if (run.token.cancelled || run.handlerError) return;
      const scope = env.child();
      ev.args.forEach((name, i) => scope.declare(name, values[i] ?? null));
      void (async () => {
        try {
          if (when && !truthy(await this.evalExpr(when, scope, run))) return;
          run.trace("event", `${ev.name}(${values.map(show).join(", ")})`);
          await this.execBlock(body, scope, this.childRun(run));
        } catch (e) {
          if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) return;
          const err = e instanceof GolemError ? e : new ShemRuntimeError("failed", String((e as Error)?.message ?? e), ev.loc);
          if (err.kind === "cancelled") return;
          run.handlerError = err;
          run.token.cancel(`handler ${ev.name} failed: ${err.message}`);
        }
      })();
    });
  }

  // ---- expressions ---------------------------------------------------------------------

  async evalExpr(e: Expr, env: Env, run: RunCtx): Promise<Value> {
    switch (e.kind) {
      case "int": case "float": return e.value;
      case "bool": return e.value;
      case "none": return null;
      case "dur": return new Dur(e.ms);
      case "string": { let out = ""; for (const p of e.parts) out += typeof p === "string" ? p : show(await this.evalExpr(p, env, run)); return out; }
      case "ident": return this.readIdent(e.name, env, run, e.loc);
      case "tuple": { const [a, b, c] = await Promise.all(e.items.map((x) => this.evalExpr(x, env, run))); return new Vec3(toNum(a), toNum(b), toNum(c)); }
      case "list": { const out: Value[] = []; for (const x of e.items) out.push(await this.evalExpr(x, env, run)); return out; }
      case "map": { const m = new ShemMap(); for (const { key, value } of e.entries) m.set(key, await this.evalExpr(value, env, run)); return m; }
      case "lambda": return new Closure(e.params, e.body, env);
      case "unary": {
        const v = await this.evalExpr(e.operand, env, run);
        if (e.op === "not") return !truthy(v);
        if (typeof v === "number") return -v;
        if (v instanceof Vec3) return new Vec3(-v.x, -v.y, -v.z, v.isPos);
        throw new ShemRuntimeError("failed", `cannot negate ${typeName(v)}`, e.loc);
      }
      case "binary": {
        if (e.op === "and") { const l = await this.evalExpr(e.left, env, run); return truthy(l) ? await this.evalExpr(e.right, env, run) : l; }
        if (e.op === "or") { const l = await this.evalExpr(e.left, env, run); return truthy(l) ? l : await this.evalExpr(e.right, env, run); }
        const l = await this.evalExpr(e.left, env, run);
        const r = await this.evalExpr(e.right, env, run);
        return binary(e.op, l, r, e.loc);
      }
      case "ternary": return truthy(await this.evalExpr(e.cond, env, run)) ? this.evalExpr(e.then, env, run) : this.evalExpr(e.else, env, run);
      case "member": {
        const obj = await this.evalExpr(e.obj, env, run);
        const v = getProp(obj, e.name);
        if (v === undefined) {
          if (obj === null) throw new ShemRuntimeError("failed", `.${e.name} on none`, e.loc);
          throw new ShemRuntimeError("failed", `${typeName(obj)} has no .${e.name}`, e.loc);
        }
        return v;
      }
      case "index": {
        const obj = await this.evalExpr(e.obj, env, run);
        const idx = await this.evalExpr(e.index, env, run);
        if (Array.isArray(obj)) { const i = toNum(idx); return obj[i < 0 ? obj.length + i : i] ?? null; }
        if (obj instanceof ShemMap) return obj.get(String(show(idx))) ?? null;
        if (typeof obj === "string") return obj[toNum(idx)] ?? null;
        if (obj && typeof obj === "object") return (obj as Record<string, Value>)[String(show(idx))] ?? null;
        throw new ShemRuntimeError("failed", `cannot index ${typeName(obj)}`, e.loc);
      }
      case "call": return this.evalCall(e, env, run);
    }
  }

  private async readIdent(name: string, env: Env, run: RunCtx, loc: Loc): Promise<Value> {
    const v = env.lookup(name);
    if (v) return v.value;
    const g = this.host.getters.get(name);
    if (g) { if (!GETTER_BY_NAME.has(name)) { /* host-only getter */ } return g({ token: run.token, run }); }
    if (GETTER_BY_NAME.has(name)) throw new ShemRuntimeError("unsupported", `${name} is not provided by this host`, loc);
    if (BUILTIN_BY_NAME.has(name)) throw new ShemRuntimeError("failed", `${name} is a function; call it with ()`, loc);
    throw new ShemRuntimeError("failed", `unknown name ${name}`, loc);
  }

  private async evalArgs(args: Arg[], env: Env, run: RunCtx): Promise<{ pos: Value[]; named: Map<string, Value> }> {
    const pos: Value[] = [];
    const named = new Map<string, Value>();
    for (const a of args) {
      const v = await this.evalExpr(a.value, env, run);
      if (a.name) named.set(a.name, v); else pos.push(v);
    }
    return { pos, named };
  }

  private async evalCall(e: Extract<Expr, { kind: "call" }>, env: Env, run: RunCtx): Promise<Value> {
    const { callee } = e;
    if (callee.kind === "member") {
      const obj = await this.evalExpr(callee.obj, env, run);
      const { pos, named } = await this.evalArgs(e.args, env, run);
      const caller = (fn: Value, a: Value[]) => this.callValue(fn, a, new Map(), run, e.loc);
      try {
        const r = await callMethod(obj, callee.name, pos, caller);
        if (r !== undefined) return r;
      } catch (err) { throw at(err, e.loc); }
      if (named.size && obj && typeof obj === "object" && !Array.isArray(obj)) {
        const m = (obj as Record<string, Value>)[callee.name];
        if (m instanceof Closure) return this.callValue(m, pos, named, run, e.loc);
      }
      throw new ShemRuntimeError("failed", `${typeName(obj)} has no method .${callee.name}()`, e.loc);
    }
    if (callee.kind === "ident") {
      const local = env.lookup(callee.name);
      const { pos, named } = await this.evalArgs(e.args, env, run);
      if (local) return this.callValue(local.value, pos, named, run, e.loc);
      return this.callBuiltin(callee.name, pos, named, run, e.loc);
    }
    const fn = await this.evalExpr(callee, env, run);
    const { pos, named } = await this.evalArgs(e.args, env, run);
    return this.callValue(fn, pos, named, run, e.loc);
  }

  private async callValue(fn: Value, args: Value[], named: Map<string, Value>, run: RunCtx, loc: Loc): Promise<Value> {
    if (fn instanceof Closure) {
      const script = (fn as unknown as { script?: ScriptDecl }).script;
      if (script) return this.callScript(script, args, named, fn.env, run, loc);
      const scope = fn.env.child();
      fn.params.forEach((p, i) => scope.declare(p, args[i] ?? null));
      if ("stmts" in fn.body) {
        try { await this.execBlock(fn.body, scope, run); return null; }
        catch (e) { if (e instanceof ReturnSignal) return e.value; throw e; }
      }
      return this.evalExpr(fn.body, scope, run);
    }
    throw new ShemRuntimeError("failed", `${typeName(fn)} is not callable`, loc);
  }

  async callBuiltin(name: string, args: Value[], named: Map<string, Value>, run: RunCtx, loc: Loc): Promise<Value> {
    const spec: BuiltinSpec | undefined = BUILTIN_BY_NAME.get(name);
    const impl = this.host.calls.get(name);
    if (!spec && !impl) throw new ShemRuntimeError("failed", `unknown function ${name}`, loc);
    if (!impl) throw new ShemRuntimeError("unsupported", `${name} is not implemented by this host yet`, loc);
    if (spec) {
      for (const k of named.keys()) if (!spec.params.some((p) => p.name === k)) throw new ShemRuntimeError("failed", `${name}: unknown argument ${k}`, loc);
      if (args.length > spec.params.length) throw new ShemRuntimeError("failed", `${name}: too many arguments (${args.length} > ${spec.params.length})`, loc);
    }
    const blocking = spec ? spec.blocking : true;
    this.checkAlive(run, loc);
    if (blocking && ++run.budget.calls > run.budget.maxCalls) throw new ShemRuntimeError("failed", `primitive call budget of ${run.budget.maxCalls} exceeded`, loc);
    const t0 = Date.now();
    const argText = [...args.map(show), ...[...named].map(([k, v]) => `${k}: ${show(v)}`)].join(", ");
    try {
      const r = await impl(args, named, { token: run.token, run });
      if (blocking) run.trace(name, `${argText} -> ${show(r ?? null)}`, Date.now() - t0);
      return r ?? null;
    } catch (err) {
      const ge = at(err, loc);
      if (blocking) run.trace(name, `${argText} !! ${ge.kind}: ${ge.message}`, Date.now() - t0);
      throw ge;
    }
  }
}

function coerceParam(v: Value, type: string, pname: string, sname: string, loc: Loc): Value {
  const fail = () => new ShemRuntimeError("failed", `${sname}: argument ${pname} should be ${type}, got ${typeName(v)}`, loc);
  switch (type) {
    case "int": if (typeof v === "number" && Number.isInteger(v)) return v; if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v); throw fail();
    case "float": case "number": if (typeof v === "number") return v; if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v); throw fail();
    case "bool": if (typeof v === "boolean") return v; if (v === "true" || v === "false") return v === "true"; throw fail();
    case "string": case "block": case "item": case "entity": case "player": if (typeof v === "string") return v; if (type === "entity" && v && typeof v === "object") return v; throw fail();
    case "dur": if (v instanceof Dur) return v; if (typeof v === "string" && /^\d+(ms|s|m|h|t)$/.test(v)) { const n = Number(v.replace(/[a-z]+$/, "")); const u = v.replace(/^\d+/, ""); return new Dur(n * ({ ms: 1, s: 1000, m: 60000, h: 3600000, t: 50 } as Record<string, number>)[u]!); } throw fail();
    case "pos": case "vec": if (v instanceof Vec3) return v; if (Array.isArray(v) && v.length === 3) return new Vec3(toNum(v[0]!), toNum(v[1]!), toNum(v[2]!)); if (v && typeof v === "object" && "x" in v) { const r = v as Record<string, Value>; return new Vec3(toNum(r.x!), toNum(r.y!), toNum(r.z!)); } throw fail();
    case "list": if (Array.isArray(v)) return v; throw fail();
    case "map": if (v instanceof ShemMap) return v; if (v && typeof v === "object" && !Array.isArray(v)) return new ShemMap(Object.entries(v as Record<string, Value>)); throw fail();
    default: return v;
  }
}

export function binary(op: string, l: Value, r: Value, loc: Loc): Value {
  switch (op) {
    case "==": return equals(l, r);
    case "!=": return !equals(l, r);
    case "+":
      if (typeof l === "number" && typeof r === "number") return l + r;
      if (typeof l === "string" || typeof r === "string") return show(l) + show(r);
      if (l instanceof Vec3 && r instanceof Vec3) return new Vec3(l.x + r.x, l.y + r.y, l.z + r.z, l.isPos && r.isPos);
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      if (l instanceof Dur && r instanceof Dur) return new Dur(l.ms + r.ms);
      break;
    case "-":
      if (typeof l === "number" && typeof r === "number") return l - r;
      if (l instanceof Vec3 && r instanceof Vec3) return new Vec3(l.x - r.x, l.y - r.y, l.z - r.z, l.isPos && r.isPos);
      if (l instanceof Dur && r instanceof Dur) return new Dur(l.ms - r.ms);
      break;
    case "*":
      if (typeof l === "number" && typeof r === "number") return l * r;
      if (l instanceof Vec3 && typeof r === "number") return new Vec3(l.x * r, l.y * r, l.z * r, false);
      if (l instanceof Dur && typeof r === "number") return new Dur(l.ms * r);
      break;
    case "/": if (typeof l === "number" && typeof r === "number") { if (r === 0) throw new ShemRuntimeError("failed", "division by zero", loc); return l / r; } break;
    case "%": if (typeof l === "number" && typeof r === "number") return l % r; break;
    case "<": case "<=": case ">": case ">=": {
      const a = l instanceof Dur ? l.ms : l, b = r instanceof Dur ? r.ms : r;
      if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) {
        switch (op) { case "<": return a < b; case "<=": return a <= b; case ">": return a > b; default: return a >= b; }
      }
      break;
    }
  }
  throw new ShemRuntimeError("failed", `cannot apply ${op} to ${typeName(l)} and ${typeName(r)}`, loc);
}
