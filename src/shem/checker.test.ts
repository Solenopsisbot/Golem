import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parser.ts";
import { check, type Registry } from "./checker.ts";

const registry: Registry = {
  has: (kind, id) => ({ block: ["oak_log", "stone"], item: ["oak_log", "stick"], entity: ["zombie"] } as Record<string, string[]>)[kind]!.includes(id),
  suggest: (_k, id) => (id === "oak_lgo" ? ["oak_log"] : []),
};

function diags(src: string, reflexFile = false) {
  return check(parse(src, "t"), { registry, reflexFile }).map((d) => `${d.severity}:${d.message}`);
}

test("checker catches the classic mistakes", () => {
  const d = diags(`
    /// ok
    script main() {
      let a = 1
      goto(a, reachh: 3)
      mine("oak_log")
      wait 5
      find_blocks("oak_lgo")
      unknown_fn()
      b = 2
      log here
      on damgae(x) { }
      on damage(a, b, c, d) { }
      while (a < 10) { a += 1 }
      trade(none, 0)
    }
    script nodoc() { }
    reflex r on tick { }
  `);
  assert.ok(d.some((x) => x.includes("goto has no parameter reachh")));
  assert.ok(d.some((x) => x.includes("mine.pos wants a position")));
  assert.ok(d.some((x) => x.includes("wait wants a duration")));
  assert.ok(d.some((x) => x.includes('unknown block "oak_lgo"') && x.includes("oak_log")));
  assert.ok(d.some((x) => x.includes("unknown function unknown_fn")));
  assert.ok(d.some((x) => x.includes("unknown name b")));
  assert.ok(d.some((x) => x.includes("unknown event damgae")));
  assert.ok(d.some((x) => x.includes("event damage provides 3")));
  assert.ok(d.some((x) => x.includes("never waits on the world")));
  assert.ok(d.some((x) => x.includes("trade is not implemented")));
  assert.ok(d.some((x) => x.includes("nodoc has no /// doc")));
  assert.ok(d.some((x) => x.includes("reflex r must live in shem/reflexes/")));
  assert.ok(!d.some((x) => x.includes("unknown name here")));
});

test("checker accepts a correct script", () => {
  const d = diags(`
    /// Collect logs.
    script collect(kind: block = "oak_log", want: int = 4): int {
      let start = inventory.count(kind)
      for (b of find_blocks(kind, radius: 32)) {
        goto(b.pos, reach: 3) timeout 30s
        mine(b.pos)
        if (inventory.count(kind) - start >= want) break
      }
      on damage(amount) when health < 6 { fail "ow" }
      wait until inventory.count(kind) >= want timeout 5s else { log "short" }
      let t = spawn { wait 1s }
      return inventory.count(kind) - start
    }
    /// uses collect
    script main() { let n = collect(want: 2); say "got \${n}" }
  `);
  assert.deepEqual(d, []);
});
