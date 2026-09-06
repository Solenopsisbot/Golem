import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parser.ts";
import { Interpreter, type Host, type Program, type RunCtx } from "./interpreter.ts";
import { CancelToken, GolemError, sleep } from "../primitives/errors.ts";
import { Dur, Vec3, ShemMap, type Value } from "./values.ts";

/** A fake world: enough host to exercise the language. */
function fakeHost() {
  const log: string[] = [];
  const said: string[] = [];
  const listeners = new Map<string, Set<(a: Value[]) => void>>();
  let health = 20;
  const inv = new Map<string, number>([["oak_log", 3]]);
  const invView = (): Value => ({
    count: ((item: Value) => inv.get(String(item)) ?? 0) as unknown as Value,
    has: ((item: Value, n: Value = 1) => (inv.get(String(item)) ?? 0) >= Number(n)) as unknown as Value,
    items: [...inv].map(([k, n]) => ({ item: k, count: n })) as Value,
  });
  const host: Host = {
    calls: new Map<string, (args: Value[], named: Map<string, Value>, ctx: { token: CancelToken }) => Promise<Value> | Value>([
      ["say", (a) => { said.push(String(a[0])); return null; }],
      ["goto", async (a, n, ctx) => { const slow = n.get("timeout") instanceof Dur && (n.get("timeout") as Dur).ms < 200; await sleep(slow ? 1000 : 10, ctx.token); return { arrived: true, pos: a[0] }; }],
      ["mine", async (a, _n, ctx) => { await sleep(10, ctx.token); inv.set("oak_log", (inv.get("oak_log") ?? 0) + 1); return { broken: true, block: "oak_log" }; }],
      ["find_blocks", (a) => { const k = Array.isArray(a[0]) ? String(a[0][0]) : String(a[0]); return [{ block: k, pos: new Vec3(1, 64, 1), dist: 3 }, { block: k, pos: new Vec3(5, 64, 5), dist: 7 }]; }],
      ["wait", async (a, _n, ctx) => { await sleep((a[0] as Dur).ms, ctx.token); return null; }],
      ["pos", (a) => new Vec3(Number(a[0]), Number(a[1]), Number(a[2]))],
      ["len", (a) => (Array.isArray(a[0]) ? a[0].length : String(a[0]).length)],
      ["str", (a) => String(a[0])],
      ["range", (a) => Array.from({ length: Number(a[0]) }, (_, i) => i)],
      ["slow", async (_a: Value[], _n: Map<string, Value>, ctx: { token: CancelToken }) => { await sleep(5000, ctx.token); return "done"; }],
    ]),
    getters: new Map([
      ["here", () => new Vec3(0, 64, 0)],
      ["health", () => health],
      ["inventory", () => invView()],
    ]),
    onEvent(name, handler) { let s = listeners.get(name); if (!s) { s = new Set(); listeners.set(name, s); } s.add(handler); return () => s!.delete(handler); },
  };
  const fire = (name: string, ...args: Value[]) => { for (const h of listeners.get(name) ?? []) h(args); };
  return { host, log, said, fire, setHealth: (h: number) => { health = h; } };
}

function makeRun(token = new CancelToken(), log: string[] = []): RunCtx {
  return { id: "t", token, log: (l) => log.push(l), trace: () => {}, budget: { deadline: Date.now() + 10_000, calls: 0, maxCalls: 1000, loops: 0, maxLoops: 10_000, depth: 0, maxDepth: 64 }, tasks: new Set(), handlerError: null };
}

function program(src: string): Program {
  const f = parse(src, "t");
  return { scripts: new Map(f.scripts.map((s) => [s.name, s])), consts: f.consts.map((c) => ({ name: c.name, value: c.value })) };
}

async function runScript(src: string, name = "main", params: Record<string, Value> = {}, fh = fakeHost()) {
  const it = new Interpreter(fh.host);
  const log: string[] = [];
  const result = await it.run(program(src), name, params, makeRun(new CancelToken(), log));
  return { result, log, said: fh.said };
}

test("expressions, control flow, collections, closures, string interpolation", async () => {
  const { result, log } = await runScript(`
    const TWO = 2
    script helper(n: int): int { return n * TWO }
    script main(): int {
      let xs = [3, 1, 2].sort_by((x) => x)
      let total = 0
      for (i, x of xs) { total += x * (i + 1) }
      let m = { a: 1 }
      m.set("b", 5)
      let s = "sum=\${total} b=\${m.get("b")} first=\${xs.first}"
      log s
      let n = 0
      while (n < 10) { n += 1; if (n == 4) break }
      repeat (3) { n += 10 }
      let p = (1, 2, 3) + (1, 1, 1)
      log "\${p} \${p.above(2).y} \${p.dist((2, 3, 4))}"
      let d = 2s + 500ms
      log "\${d.ms} \${d > 1s}"
      return helper(n) + (n > 30 ? 1 : 0)
    }`);
  assert.equal(log[0], "sum=14 b=5 first=1");
  assert.equal(log[1], "(2, 3, 4) 5 0");
  assert.equal(log[2], "2500 true");
  assert.equal(result, 69);
});

test("named args, defaults, coercion and argument errors", async () => {
  const { result } = await runScript(`
    script f(a: int, b: string = "x", c: dur = 3s): string { return "\${a}\${b}\${c.ms}" }
    script main(): string { return f(1) + f(2, "y") + f(b: "z", a: 3, c: 1s) }`);
  assert.equal(result, "1x30002y30003z1000");
  await assert.rejects(runScript(`script f(a: int) { } script main() { f() }`), /missing argument a/);
  await assert.rejects(runScript(`script f(a: int) { } script main() { f("no") }`), /should be int/);
  await assert.rejects(runScript(`script main() { goto((1,2,3), reachh: 2) }`), /unknown argument reachh/);
  await assert.rejects(runScript(`script main() { wait 5 }`), /expected a duration/);
  const r = await runScript(`script main(x: int, d: dur) { return "\${x + 1} \${d.ms}" }`, "main", { x: "41", d: "2s" });
  assert.equal(r.result, "42 2000");
});

test("primitives through the host, inventory getter, script results", async () => {
  const { result, said } = await runScript(`
    /// mine some
    script main(kind: block = "oak_log", want: int = 2): int {
      let start = inventory.count(kind)
      let logs = find_blocks(kind, radius: 32)
      for (b of logs) { mine(b.pos); if (inventory.count(kind) - start >= want) break }
      say "got \${inventory.count(kind) - start} \${kind}"
      return inventory.count(kind) - start
    }`);
  assert.equal(result, 2);
  assert.deepEqual(said, ["got 2 oak_log"]);
});

test("timeouts: statement suffix throws, block form with else is soft", async () => {
  await assert.rejects(runScript(`script main() { goto((1,2,3), timeout: 100ms) timeout 100ms }`), (e: GolemError) => e.kind === "timeout");
  const { log } = await runScript(`script main() { timeout 50ms { slow() } else { log "too slow" } log "after" }`);
  assert.deepEqual(log, ["too slow", "after"]);
  await assert.rejects(runScript(`script main() { timeout 50ms { slow() } }`), (e: GolemError) => e.kind === "timeout");
});

test("parallel, race, spawn and wait until", async () => {
  const { log } = await runScript(`
    script main() {
      let a = 0
      parallel { wait 20ms; a += 1 } { wait 10ms; a += 10 }
      log "a=\${a}"
      race { wait 10ms; log "fast" } { slow(); log "never" }
      let t = spawn { wait 30ms; a += 100 }
      wait until a >= 100 timeout 1s
      wait until t.done timeout 1s
      log "a=\${a} done=\${t.done}"
      let t2 = spawn { slow() }
      t2.cancel()
      wait until t2.done timeout 500ms else { log "still running" }
      log "end"
    }`);
  assert.deepEqual(log, ["a=11", "fast", "a=111 done=true", "end"]);
});

test("on handlers fire concurrently and can end the run", async () => {
  const fh = fakeHost();
  const it = new Interpreter(fh.host);
  const run = makeRun();
  const p = it.run(program(`
    script main() {
      on damage(amount) when amount > 5 { fail "ow \${amount}" }
      on damage(amount) { log "hit \${amount}" }
      wait 30ms
      fh_never()
    }
    script fh_never() { wait 5s }`), "main", {}, run);
  await sleep(10);
  fh.fire("damage", 2, 18, null);
  await sleep(5);
  fh.fire("damage", 7, 11, null);
  await assert.rejects(p, /ow 7/);
});

test("try/catch/finally; cancelled cannot be swallowed", async () => {
  const { log } = await runScript(`
    script main() {
      try { fail "boom" } catch (e) { log "caught \${e.kind}: \${e.message}" } finally { log "fin" }
      try { goto((1,2,3), timeout: 100ms) timeout 50ms } catch (e) { log e.kind }
    }`);
  assert.equal(log[0]!.startsWith("caught failed:"), true);
  assert.deepEqual(log.slice(1), ["fin", "timeout"]);
  const fh = fakeHost();
  const token = new CancelToken();
  const run = makeRun(token);
  const p = new Interpreter(fh.host).run(program(`script main() { try { slow() } catch (e) { log "swallowed" } }`), "main", {}, run);
  await sleep(10);
  token.cancel("met");
  await assert.rejects(p, (e: GolemError) => e.kind === "cancelled");
});

test("budgets: loops", async () => {
  const fh = fakeHost();
  const run = makeRun();
  run.budget.maxLoops = 50;
  await assert.rejects(new Interpreter(fh.host).run(program(`script main() { while (true) { } }`), "main", {}, run), /loop budget/);
});

test("consts, list methods, map literals, negative index, ternary", async () => {
  const { result } = await runScript(`
    const KINDS = ["oak_log", "birch_log"]
    script main(): string {
      let xs = range(5).filter((x) => x % 2 == 0).map((x) => x * x)
      let last = xs[-1]
      let m = { oak_log: 1, birch_log: 2 }
      return "\${xs} \${last} \${KINDS.includes("birch_log") ? m.birch_log : 0} \${len(KINDS)}"
    }`);
  assert.equal(result, "[0, 4, 16] 16 2 2");
});
