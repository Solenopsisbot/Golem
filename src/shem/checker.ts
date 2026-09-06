// Static checks for Shem files: syntax is the parser's job; this finds what would fail at run time
// or silently misbehave: unknown names, wrong arity, unknown named args, unknown block/item/entity
// ids, bare numbers where durations go, unknown events, reflexes in the wrong place, loops that
// can't yield, and scripts without a doc comment.
import type { Block, Expr, File, Loc, ScriptDecl, Stmt } from "./ast.ts";
import { BUILTIN_BY_NAME, EVENTS, GETTER_BY_NAME, type ShemType } from "./builtins.ts";

export interface Diagnostic { severity: "error" | "warning"; message: string; loc: Loc }

export interface Registry {
  has(kind: "block" | "item" | "entity", id: string): boolean;
  suggest(kind: "block" | "item" | "entity", id: string): string[];
}

export interface CheckOptions {
  registry?: Registry;
  /** Scripts visible from other files (`use`), by name with their param names. */
  imported?: Map<string, { params: { name: string; hasDefault: boolean; type: string | null }[] }>;
  /** True when the file lives under shem/reflexes/. */
  reflexFile?: boolean;
}

class Scope {
  private names = new Set<string>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null = null) { this.parent = parent; }
  declare(n: string) { this.names.add(n); }
  has(n: string): boolean { return this.names.has(n) || (this.parent?.has(n) ?? false); }
}

export function check(file: File, opts: CheckOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (message: string, loc: Loc) => out.push({ severity: "error", message, loc });
  const warn = (message: string, loc: Loc) => out.push({ severity: "warning", message, loc });
  const scripts = new Map<string, { params: { name: string; hasDefault: boolean; type: string | null }[] }>(opts.imported ?? []);
  for (const s of file.scripts) scripts.set(s.name, { params: s.params.map((p) => ({ name: p.name, hasDefault: !!p.def, type: p.type?.name ?? null })) });
  const top = new Scope();
  for (const c of file.consts) top.declare(c.name);
  for (const s of file.scripts) top.declare(s.name);

  const idKinds = new Set(["block", "item", "entity"]);
  function checkIdLiteral(kind: ShemType | string, e: Expr, what: string): void {
    if (!opts.registry || !idKinds.has(kind)) return;
    const k = kind as "block" | "item" | "entity";
    const lits: string[] = [];
    if (e.kind === "string" && e.parts.every((p) => typeof p === "string")) lits.push(e.parts.join(""));
    if (e.kind === "list") for (const it of e.items) if (it.kind === "string" && it.parts.every((p) => typeof p === "string")) lits.push(it.parts.join(""));
    for (const lit of lits) {
      const short = lit.replace(/^minecraft:/, "");
      if (short.startsWith("#") || short.includes(":")) continue;
      if (!opts.registry.has(k, short)) {
        const sug = opts.registry.suggest(k, short);
        err(`unknown ${k} "${short}" for ${what}${sug.length ? ` (did you mean ${sug.slice(0, 3).join(", ")}?)` : ""}`, e.loc);
      }
    }
  }

  function checkCall(e: Extract<Expr, { kind: "call" }>, scope: Scope): void {
    for (const a of e.args) checkExpr(a.value, scope);
    if (e.callee.kind === "member") { checkExpr(e.callee.obj, scope); return; }
    if (e.callee.kind !== "ident") { checkExpr(e.callee, scope); return; }
    const name = e.callee.name;
    if (scope.has(name) && !scripts.has(name)) return; // a local closure
    const positional = e.args.filter((a) => !a.name).length;
    const named = e.args.filter((a) => a.name);
    const sc = scripts.get(name);
    if (sc) {
      if (positional > sc.params.length) err(`${name} takes ${sc.params.length} argument(s), got ${positional}`, e.loc);
      for (const a of named) if (!sc.params.some((p) => p.name === a.name)) err(`${name} has no parameter ${a.name}`, a.loc);
      sc.params.forEach((p, i) => {
        const given = i < positional || named.some((a) => a.name === p.name);
        if (!given && !p.hasDefault) err(`${name}: missing argument ${p.name}`, e.loc);
        const argExpr = i < positional ? e.args.filter((a) => !a.name)[i]!.value : named.find((a) => a.name === p.name)?.value;
        if (argExpr && p.type) { checkIdLiteral(p.type, argExpr, `${name}.${p.name}`); if (p.type === "dur" && (argExpr.kind === "int" || argExpr.kind === "float")) err(`${name}.${p.name} wants a duration like 30s, not a bare number`, argExpr.loc); }
      });
      return;
    }
    const b = BUILTIN_BY_NAME.get(name);
    if (!b) { err(`unknown function ${name}`, e.loc); return; }
    if (b.stub) warn(`${name} is not implemented yet; it will fail with 'unsupported'`, e.loc);
    if (positional > b.params.length) err(`${name} takes ${b.params.length} argument(s), got ${positional}`, e.loc);
    for (const a of named) if (!b.params.some((p) => p.name === a.name)) err(`${name} has no parameter ${a.name} (has: ${b.params.map((p) => p.name).join(", ")})`, a.loc);
    b.params.forEach((p, i) => {
      const argExpr = i < positional ? e.args.filter((a) => !a.name)[i]!.value : named.find((a) => a.name === p.name)?.value;
      if (!argExpr) { if (p.required) err(`${name}: missing argument ${p.name}`, e.loc); return; }
      checkIdLiteral(p.type, argExpr, `${name}.${p.name}`);
      if (p.type === "dur" && (argExpr.kind === "int" || argExpr.kind === "float")) err(`${name}.${p.name} wants a duration like 30s, not a bare number`, argExpr.loc);
      if ((p.type === "pos" || p.type === "vec") && (argExpr.kind === "string" || argExpr.kind === "int")) err(`${name}.${p.name} wants a position like (x, y, z)`, argExpr.loc);
      if (p.type === "string" && (argExpr.kind === "int" || argExpr.kind === "float")) err(`${name}.${p.name} wants a string`, argExpr.loc);
    });
  }

  function checkExpr(e: Expr, scope: Scope): void {
    switch (e.kind) {
      case "ident":
        if (scope.has(e.name) || GETTER_BY_NAME.has(e.name)) return;
        if (BUILTIN_BY_NAME.has(e.name)) { err(`${e.name} is a function; call it with ()`, e.loc); return; }
        err(`unknown name ${e.name}`, e.loc);
        return;
      case "string": for (const p of e.parts) if (typeof p !== "string") checkExpr(p, scope); return;
      case "tuple": for (const x of e.items) checkExpr(x, scope); return;
      case "list": for (const x of e.items) checkExpr(x, scope); return;
      case "map": for (const { value } of e.entries) checkExpr(value, scope); return;
      case "lambda": { const s = new Scope(scope); for (const p of e.params) s.declare(p); if ("stmts" in e.body) checkBlock(e.body, s, false); else checkExpr(e.body, s); return; }
      case "unary": checkExpr(e.operand, scope); return;
      case "binary": checkExpr(e.left, scope); checkExpr(e.right, scope); return;
      case "ternary": checkExpr(e.cond, scope); checkExpr(e.then, scope); checkExpr(e.else, scope); return;
      case "member": checkExpr(e.obj, scope); return;
      case "index": checkExpr(e.obj, scope); checkExpr(e.index, scope); return;
      case "call": checkCall(e, scope); return;
      default: return;
    }
  }

  /** True if executing this block would hit an await point (a blocking builtin, wait, or a script call). */
  function mayYield(b: Block | Stmt): boolean {
    const stmts = "stmts" in b ? b.stmts : [b];
    let found = false;
    const visitExpr = (e: Expr): void => {
      if (found) return;
      if (e.kind === "call") {
        if (e.callee.kind === "ident") { const bi = BUILTIN_BY_NAME.get(e.callee.name); if ((bi && bi.blocking) || scripts.has(e.callee.name)) { found = true; return; } }
        for (const a of e.args) visitExpr(a.value);
        if (e.callee.kind === "member") visitExpr(e.callee.obj);
      } else if (e.kind === "binary") { visitExpr(e.left); visitExpr(e.right); }
      else if (e.kind === "member") visitExpr(e.obj);
      else if (e.kind === "string") for (const p of e.parts) if (typeof p !== "string") visitExpr(p);
    };
    const visitStmt = (s: Stmt): void => {
      if (found) return;
      switch (s.kind) {
        case "wait": case "waitUntil": case "timeout": case "parallel": case "race": case "say": found = true; return;
        case "expr": visitExpr(s.expr); return;
        case "var": visitExpr(s.value); return;
        case "assign": visitExpr(s.value); return;
        case "if": visitExpr(s.cond); if (!found) visitBranch(s.then); if (!found && s.else) visitBranch(s.else); return;
        case "for": case "while": case "repeat": found = found || mayYield(s.body); return;
        case "try": found = found || mayYield(s.body); return;
        case "return": case "fail": found = true; return;
        default: return;
      }
    };
    const visitBranch = (b2: Block | Stmt) => { if ("stmts" in b2) b2.stmts.forEach(visitStmt); else visitStmt(b2); };
    stmts.forEach(visitStmt);
    return found;
  }

  function checkBlock(b: Block, parent: Scope, isTop: boolean): void {
    const scope = new Scope(parent);
    for (const s of b.stmts) checkStmt(s, scope, isTop);
  }

  function checkStmt(s: Stmt, scope: Scope, isTop: boolean): void {
    switch (s.kind) {
      case "var": checkExpr(s.value, scope); scope.declare(s.name); return;
      case "assign": checkExpr(s.target, scope); checkExpr(s.value, scope); return;
      case "if": checkExpr(s.cond, scope); checkBranch(s.then, scope); if (s.else) checkBranch(s.else, scope); return;
      case "for": { checkExpr(s.iter, scope); const inner = new Scope(scope); inner.declare(s.item); if (s.index) inner.declare(s.index); checkBlock(s.body, inner, false); return; }
      case "while": checkExpr(s.cond, scope); checkBlock(s.body, scope, false); if (!mayYield(s.body) && !(s.cond.kind === "bool" && !s.cond.value)) warn("this loop never waits on the world; if its condition depends on the world it will spin until the loop budget", s.loc); return;
      case "repeat": checkExpr(s.count, scope); checkBlock(s.body, scope, false); return;
      case "wait": checkExpr(s.duration, scope); if (s.duration.kind === "int" || s.duration.kind === "float") err("wait wants a duration like 5s, not a bare number", s.duration.loc); return;
      case "waitUntil": checkExpr(s.cond, scope); if (s.timeout) { checkExpr(s.timeout, scope); if (s.timeout.kind === "int") err("timeout wants a duration like 20s", s.timeout.loc); } if (s.else) checkBlock(s.else, scope, false); return;
      case "timeout": checkExpr(s.duration, scope); if (s.duration.kind === "int") err("timeout wants a duration like 20s", s.duration.loc); checkBlock(s.body, scope, false); if (s.else) checkBlock(s.else, scope, false); return;
      case "parallel": case "race": for (const b of s.blocks) checkBlock(b, scope, false); return;
      case "spawn": checkBlock(s.body, scope, false); if (s.name) scope.declare(s.name); return;
      case "try": checkBlock(s.body, scope, false); if (s.catchBody) { const cs = new Scope(scope); if (s.catchName) cs.declare(s.catchName); checkBlock(s.catchBody, cs, false); } if (s.finallyBody) checkBlock(s.finallyBody, scope, false); return;
      case "on": {
        const argNames = EVENTS[s.event.name];
        if (!argNames) { err(`unknown event ${s.event.name} (have: ${Object.keys(EVENTS).join(", ")})`, s.event.loc); return; }
        if (s.event.args.length > argNames.length) err(`event ${s.event.name} provides ${argNames.length} argument(s): ${argNames.join(", ")}`, s.event.loc);
        const hs = new Scope(scope); for (const a of s.event.args) hs.declare(a);
        if (s.when) checkExpr(s.when, hs);
        checkBlock(s.body, hs, false);
        return;
      }
      case "return": case "fail": if (s.value) checkExpr(s.value, scope); return;
      case "log": case "say": checkExpr(s.value, scope); return;
      case "expr": checkExpr(s.expr, scope); if (s.timeout) { checkExpr(s.timeout, scope); if (s.timeout.kind === "int") err("timeout wants a duration like 30s", s.timeout.loc); } return;
      default: return;
    }
  }
  function checkBranch(b: Block | Stmt, scope: Scope) { if ("stmts" in b) checkBlock(b, scope, false); else checkStmt(b, new Scope(scope), false); }

  for (const c of file.consts) checkExpr(c.value, top);
  const seen = new Set<string>();
  for (const s of file.scripts) {
    if (seen.has(s.name)) err(`duplicate script ${s.name}`, s.loc);
    seen.add(s.name);
    if (!s.doc) warn(`script ${s.name} has no /// doc comment; the library index will be blank for it`, s.loc);
    const scope = new Scope(top);
    for (const p of s.params) { if (p.def) checkExpr(p.def, scope); scope.declare(p.name); if (p.type && p.def) checkIdLiteral(p.type.name, p.def, `${s.name}.${p.name} default`); }
    checkBlock(s.body, scope, true);
  }
  for (const r of file.reflexes) {
    if (!opts.reflexFile) err(`reflex ${r.name} must live in shem/reflexes/ (see docs/SHEM.md)`, r.loc);
    const argNames = EVENTS[r.event.name];
    if (!argNames) { err(`unknown event ${r.event.name}`, r.event.loc); continue; }
    const scope = new Scope(top); for (const a of r.event.args) scope.declare(a);
    if (r.when) checkExpr(r.when, scope);
    checkBlock(r.body, scope, false);
  }
  return out;
}

export function formatDiagnostics(d: Diagnostic[], file = ""): string {
  if (!d.length) return "ok";
  return d.map((x) => `${file ? file + ":" : ""}${x.loc.line}:${x.loc.col} ${x.severity}: ${x.message}`).join("\n");
}
