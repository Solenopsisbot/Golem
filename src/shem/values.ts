// Shem runtime values and the methods built into them. Numbers, strings, booleans and lists are
// plain JS values; positions, durations, maps and closures are tagged objects so the interpreter
// and the checker can tell them apart.
import { center, dist, distXZ, floorPos, type Face, offset as offsetPos } from "../util/geom.ts";
import { GolemError } from "../primitives/errors.ts";
import type { Block, Expr } from "./ast.ts";

export class Dur { readonly ms: number; constructor(ms: number) { this.ms = ms; } toString() { return fmtDur(this.ms); } }
export class Vec3 {
  readonly x: number; readonly y: number; readonly z: number; readonly isPos: boolean;
  constructor(x: number, y: number, z: number, isPos?: boolean) {
    this.x = x; this.y = y; this.z = z;
    this.isPos = isPos ?? (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z));
  }
  toString() { return this.isPos ? `(${this.x}, ${this.y}, ${this.z})` : `(${this.x.toFixed(2)}, ${this.y.toFixed(2)}, ${this.z.toFixed(2)})`; }
  get plain() { return { x: this.x, y: this.y, z: this.z }; }
}
export class Closure {
  readonly params: string[]; readonly body: Expr | Block; readonly env: Env;
  constructor(params: string[], body: Expr | Block, env: Env) { this.params = params; this.body = body; this.env = env; }
  toString() { return `(${this.params.join(", ")}) => ...`; }
}
export class ShemMap extends Map<string, Value> { toString() { return `{${[...this.entries()].map(([k, v]) => `${k}: ${show(v)}`).join(", ")}}`; } }
/** Handle to a background task started with `spawn`. */
export class RunHandle {
  readonly promise: Promise<Value>;
  readonly cancel: (reason?: string) => void;
  done = false; result: Value = null; error: GolemError | null = null;
  constructor(promise: Promise<Value>, cancel: (reason?: string) => void) {
    this.promise = promise; this.cancel = cancel;
    promise.then((v) => { this.done = true; this.result = v; }, (e) => { this.done = true; this.error = e instanceof GolemError ? e : new GolemError("failed", String(e)); });
  }
  toString() { return `<task ${this.done ? "done" : "running"}>`; }
}
/** Records (entities, blocks, inventory views, errors) are plain objects with string keys. */
export type Record_ = { [k: string]: Value };
export type Value = null | boolean | number | string | Dur | Vec3 | Value[] | ShemMap | Closure | RunHandle | Record_;

export class Env {
  private readonly vars = new Map<string, { value: Value; mutable: boolean }>();
  readonly parent: Env | null;
  constructor(parent: Env | null = null) { this.parent = parent; }
  declare(name: string, value: Value, mutable = true): void { this.vars.set(name, { value, mutable }); }
  has(name: string): boolean { return this.vars.has(name) || (this.parent?.has(name) ?? false); }
  lookup(name: string): { value: Value; mutable: boolean } | undefined { return this.vars.get(name) ?? this.parent?.lookup(name); }
  assign(name: string, value: Value): boolean {
    const v = this.vars.get(name);
    if (v) { if (!v.mutable) throw new GolemError("failed", `${name} is const`); v.value = value; return true; }
    return this.parent?.assign(name, value) ?? false;
  }
  child(): Env { return new Env(this); }
}

export function fmtDur(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function typeName(v: Value): string {
  if (v === null) return "none";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "string";
  if (v instanceof Dur) return "dur";
  if (v instanceof Vec3) return v.isPos ? "pos" : "vec";
  if (Array.isArray(v)) return "list";
  if (v instanceof ShemMap) return "map";
  if (v instanceof Closure) return "function";
  if (v instanceof RunHandle) return "task";
  return "record";
}

export function show(v: Value): string {
  if (v === null) return "none";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return v.length > 40 ? `[${v.slice(0, 40).map(show).join(", ")}, +${v.length - 40} more]` : `[${v.map(show).join(", ")}]`;
  if (v instanceof ShemMap) { const es = [...v.entries()]; return `{${es.slice(0, 30).map(([k, x]) => `${show(k)}: ${show(x)}`).join(", ")}${es.length > 30 ? `, +${es.length - 30} more` : ""}}`; }
  if (typeof v === "object" && !(v instanceof Dur) && !(v instanceof Vec3) && !(v instanceof ShemMap) && !(v instanceof Closure) && !(v instanceof RunHandle)) {
    const r = v as Record_;
    if (typeof r.type === "string" && typeof r.id === "number") return `${String(r.type).replace("minecraft:", "")}#${r.id}`;
    if (typeof r.block === "string" && r.pos instanceof Vec3) return `${String(r.block).replace("minecraft:", "")}@${r.pos}`;
    return `{${Object.entries(r).slice(0, 6).map(([k, x]) => `${k}: ${show(x)}`).join(", ")}}`;
  }
  return String(v);
}

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a instanceof Vec3 && b instanceof Vec3) return a.x === b.x && a.y === b.y && a.z === b.z;
  if (a instanceof Dur && b instanceof Dur) return a.ms === b.ms;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]!));
  return false;
}

export function toVec(v: Value, what = "position"): Vec3 {
  if (v instanceof Vec3) return v;
  if (v && typeof v === "object" && !Array.isArray(v) && "x" in v && "y" in v && "z" in v) {
    const r = v as Record_; return new Vec3(Number(r.x), Number(r.y), Number(r.z));
  }
  if (v && typeof v === "object" && "pos" in (v as Record_)) return toVec((v as Record_).pos, what);
  throw new GolemError("failed", `expected a ${what}, got ${typeName(v)}`);
}
export function toPos(v: Value, what = "block position"): Vec3 {
  const p = toVec(v, what);
  return p.isPos ? p : new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), true);
}
export function toNum(v: Value, what = "number"): number {
  if (typeof v === "number") return v;
  throw new GolemError("failed", `expected a ${what}, got ${typeName(v)}`);
}
export function toStr(v: Value, what = "string"): string {
  if (typeof v === "string") return v;
  throw new GolemError("failed", `expected a ${what}, got ${typeName(v)}`);
}
export function toDur(v: Value, what = "duration"): number {
  if (v instanceof Dur) return v.ms;
  if (typeof v === "number") throw new GolemError("failed", `expected a ${what} like 5s or 500ms, got a bare number (${v})`);
  throw new GolemError("failed", `expected a ${what}, got ${typeName(v)}`);
}
export function toList(v: Value, what = "list"): Value[] {
  if (Array.isArray(v)) return v;
  throw new GolemError("failed", `expected a ${what}, got ${typeName(v)}`);
}

/** Calls a Shem closure or a host function with positional args. Installed by the interpreter. */
export type Caller = (fn: Value, args: Value[]) => Promise<Value>;

const FACES: Face[] = ["up", "down", "north", "south", "east", "west"];

/** Property access on built-in value types. Returns undefined when the name isn't a property. */
export function getProp(v: Value, name: string): Value | undefined {
  if (v instanceof Vec3) {
    switch (name) { case "x": return v.x; case "y": return v.y; case "z": return v.z; case "is_pos": return v.isPos; }
    return undefined;
  }
  if (Array.isArray(v)) {
    switch (name) { case "length": return v.length; case "empty": return v.length === 0; case "first": return v[0] ?? null; case "last": return v[v.length - 1] ?? null; }
    return undefined;
  }
  if (typeof v === "string") {
    switch (name) { case "length": return v.length; case "empty": return v.length === 0; case "upper": return v.toUpperCase(); case "lower": return v.toLowerCase(); case "trim": return v.trim(); }
    return undefined;
  }
  if (v instanceof ShemMap) {
    switch (name) { case "keys": return [...v.keys()]; case "values": return [...v.values()]; case "size": return v.size; }
    return v.has(name) ? v.get(name)! : undefined;
  }
  if (v instanceof Dur) { if (name === "ms") return v.ms; if (name === "seconds") return v.ms / 1000; return undefined; }
  if (v instanceof RunHandle) { switch (name) { case "done": return v.done; case "result": return v.result; case "error": return v.error ? errorRecord(v.error) : null; } return undefined; }
  if (typeof v === "number") { switch (name) { case "floor": return Math.floor(v); case "round": return Math.round(v); case "abs": return Math.abs(v); case "ceil": return Math.ceil(v); } return undefined; }
  if (v && typeof v === "object" && !(v instanceof Closure)) {
    const r = v as Record_;
    if (name in r) return r[name]!;
    return undefined;
  }
  return undefined;
}

/** Method calls on built-in value types. Returns undefined when the name isn't a method. */
export async function callMethod(v: Value, name: string, args: Value[], call: Caller): Promise<Value | undefined> {
  if (v instanceof Vec3) {
    switch (name) {
      case "above": return new Vec3(v.x, v.y + toNum(args[0] ?? 1), v.z, v.isPos);
      case "below": return new Vec3(v.x, v.y - toNum(args[0] ?? 1), v.z, v.isPos);
      case "offset": {
        if (typeof args[0] === "string") { const f = args[0] as Face; if (!FACES.includes(f)) throw new GolemError("failed", `bad face ${args[0]}`); const o = offsetPos(v.plain, f, toNum(args[1] ?? 1)); return new Vec3(o.x, o.y, o.z, v.isPos); }
        return new Vec3(v.x + toNum(args[0] ?? 0), v.y + toNum(args[1] ?? 0), v.z + toNum(args[2] ?? 0), v.isPos);
      }
      case "dist": return dist(v.plain, toVec(args[0] ?? null).plain);
      case "dist_xz": return distXZ(v.plain, toVec(args[0] ?? null).plain);
      case "toward": { const t = toVec(args[0] ?? null); const n = toNum(args[1] ?? 1); const d = dist(v.plain, t.plain) || 1; return new Vec3(v.x + (t.x - v.x) / d * n, v.y + (t.y - v.y) / d * n, v.z + (t.z - v.z) / d * n, false); }
      case "floor": { const f = floorPos(v.plain); return new Vec3(f.x, f.y, f.z, true); }
      case "center": { const c = center(toPos(v).plain); return new Vec3(c.x, c.y, c.z, false); }
    }
    return undefined;
  }
  if (Array.isArray(v)) {
    switch (name) {
      case "includes": return v.some((x) => equals(x, args[0] ?? null));
      case "count": return v.filter((x) => equals(x, args[0] ?? null)).length;
      case "filter": { const out: Value[] = []; for (const x of v) if (truthy(await call(args[0] ?? null, [x]))) out.push(x); return out; }
      case "map": { const out: Value[] = []; for (const x of v) out.push(await call(args[0] ?? null, [x])); return out; }
      case "find": { for (const x of v) if (truthy(await call(args[0] ?? null, [x]))) return x; return null; }
      case "any": { for (const x of v) if (truthy(await call(args[0] ?? null, [x]))) return true; return false; }
      case "all": { for (const x of v) if (!truthy(await call(args[0] ?? null, [x]))) return false; return true; }
      case "sort_by": { const keyed: [Value, Value][] = []; for (const x of v) keyed.push([await call(args[0] ?? null, [x]), x]); keyed.sort((a, b) => cmp(a[0], b[0])); return keyed.map((k) => k[1]); }
      case "nearest": { const from = toVec(args[0] ?? null); let best: Value = null, bd = Infinity; for (const x of v) { const d = dist(toVec(x).plain, from.plain); if (d < bd) { bd = d; best = x; } } return best; }
      case "take": return v.slice(0, toNum(args[0] ?? 1));
      case "skip": return v.slice(toNum(args[0] ?? 1));
      case "reverse": return [...v].reverse();
      case "join": return v.map(show).join(typeof args[0] === "string" ? args[0] : ", ");
      case "push": v.push(args[0] ?? null); return v;
      case "sum": return v.reduce<number>((a, x) => a + toNum(x), 0);
    }
    return undefined;
  }
  if (typeof v === "string") {
    switch (name) {
      case "includes": return v.includes(toStr(args[0] ?? ""));
      case "starts_with": return v.startsWith(toStr(args[0] ?? ""));
      case "ends_with": return v.endsWith(toStr(args[0] ?? ""));
      case "split": return v.split(toStr(args[0] ?? " "));
      case "replace": return v.split(toStr(args[0] ?? "")).join(toStr(args[1] ?? ""));
    }
    return undefined;
  }
  if (v instanceof ShemMap) {
    switch (name) {
      case "get": return v.has(toStr(args[0] ?? "")) ? v.get(toStr(args[0] ?? ""))! : (args[1] ?? null);
      case "set": v.set(toStr(args[0] ?? ""), args[1] ?? null); return v;
      case "has": return v.has(toStr(args[0] ?? ""));
      case "delete": return v.delete(toStr(args[0] ?? ""));
    }
    return undefined;
  }
  if (v instanceof RunHandle) {
    switch (name) {
      case "cancel": v.cancel(typeof args[0] === "string" ? args[0] : "cancelled"); return null;
      case "wait": { try { return await v.promise; } catch (e) { throw e; } }
    }
    return undefined;
  }
  if (v && typeof v === "object" && !(v instanceof Closure) && !(v instanceof Dur)) {
    const r = v as Record_;
    const m = r[name];
    if (m instanceof Closure) return call(m, args);
    if (typeof m === "function") return (m as unknown as (...a: Value[]) => Value | Promise<Value>)(...args);
  }
  return undefined;
}

function cmp(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(show(a)).localeCompare(String(show(b)));
}

export function errorRecord(e: GolemError): Record_ {
  return { kind: e.kind, message: e.message, code: e.code ?? null };
}
