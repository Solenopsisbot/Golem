import { test } from "node:test";
import assert from "node:assert/strict";
import { lex } from "./lexer.ts";
import { parse, parseExpr } from "./parser.ts";

test("lexer: durations, numbers, strings with interpolation, doc comments", () => {
  const toks = lex('/// doc here\nlet x = 30s + 500ms - 2.5 * 10t "a ${b} c"');
  const types = toks.map((t) => t.type + (t.type === "punct" ? t.value : ""));
  assert.deepEqual(types.slice(0, 4), ["doc", "ident", "ident", "punct="]);
  const dur = toks.find((t) => t.type === "dur")!;
  assert.equal(dur.num, 30_000);
  assert.equal(toks.filter((t) => t.type === "dur").map((t) => t.num).join(","), "30000,500,500");
  const str = toks.find((t) => t.type === "string")!;
  assert.equal(str.parts!.length, 3);
});

test("parser: a full script with the usual statements", () => {
  const f = parse(`
use "lib/trees"
const HOME: pos = (120, 64, -30)

/// Collect logs.
script collect_wood(kind: block = "oak_log", want: int = 16, radius: int = 48): int {
  let start = inventory.count(kind)
  let logs = find_blocks(kind, radius: radius, max: 64)
  if (logs.length == 0) fail "no \${kind} within \${radius} blocks"
  for (pos of logs) {
    goto(pos, reach: 4) timeout 30s
    mine(pos)
    if (inventory.count(kind) - start >= want) break
  }
  collect_drops(radius: 6)
  on damage(amount) when health < 6 { fail "ow" }
  wait until inventory.count(kind) >= want timeout 20s else { log "gave up" }
  parallel { wait 1s } { say "hi" }
  let bg = spawn { follow(nearest_player(20), 3) }
  try { eat_something() } catch (e) { log e.kind } finally { stop() }
  return inventory.count(kind) - start
}

reflex low_health priority 90 on health(hp, food) when hp <= 6 {
  flee(threats(radius: 12), 16)
}
`, "collect_wood");
  assert.equal(f.uses[0]!.path, "lib/trees");
  assert.equal(f.consts[0]!.name, "HOME");
  const s = f.scripts[0]!;
  assert.equal(s.name, "collect_wood");
  assert.equal(s.doc, "Collect logs.");
  assert.equal(s.params.length, 3);
  assert.equal(s.params[0]!.type!.name, "block");
  assert.equal(s.returnType!.name, "int");
  const kinds = s.body.stmts.map((x) => x.kind);
  assert.deepEqual(kinds, ["var", "var", "if", "for", "expr", "on", "waitUntil", "parallel", "spawn", "try", "return"]);
  const r = f.reflexes[0]!;
  assert.equal(r.priority, 90);
  assert.deepEqual(r.event.args, ["hp", "food"]);
  assert.ok(r.when);
});

test("parser: expressions, precedence, named args, lambdas, tuples, maps", () => {
  const e = parseExpr("a + b * 2 >= 10 and not c or d ? 1 : 2");
  assert.equal(e.kind, "ternary");
  const call = parseExpr("goto((1, 2, 3), reach: 3)");
  assert.equal(call.kind, "call");
  if (call.kind === "call") { assert.equal(call.args[0]!.value.kind, "tuple"); assert.equal(call.args[1]!.name, "reach"); }
  const lam = parseExpr("logs.filter((p) => p.y > 60).sort_by((p) => p.dist(here))");
  assert.equal(lam.kind, "call");
  const m = parseExpr('{ a: 1, "b c": [1, 2] }');
  assert.equal(m.kind, "map");
  const s = parseExpr('"got ${inventory.count(kind)} logs"');
  assert.equal(s.kind, "string");
  if (s.kind === "string") assert.equal(s.parts.length, 3);
});

test("parser: error messages carry positions", () => {
  assert.throws(() => parse("script x( {"), /1:11: expected a name/);
  assert.throws(() => parse("script x() { let = 3 }"), /expected a name/);
  assert.throws(() => parse("script x() { parallel { } }"), /at least two blocks/);
});
