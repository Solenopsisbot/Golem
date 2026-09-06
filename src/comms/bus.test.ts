import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBus, type BusMessage } from "./bus.ts";

function peer(name: string, box: BusMessage[]) { return { name, deliver: (m: BusMessage) => box.push(m), state: () => `${name} ok` }; }

test("bus delivers, caps pairs, tells both sides, and resets after the cooldown", () => {
  const bus = new AgentBus({ maxTurns: 3, cooldownMs: 50 });
  const a: BusMessage[] = [], b: BusMessage[] = [];
  bus.register(peer("Clay", a)); bus.register(peer("Flint", b));
  assert.equal(bus.send("Clay", "Flint", "hi").remaining, 2);
  assert.equal(bus.send("Flint", "Clay", "hi back").remaining, 1);
  assert.equal(bus.send("Clay", "Flint", "where are you").remaining, 0);
  assert.equal(b.filter((m) => m.from === "Clay").length, 2);
  assert.ok(a.some((m) => m.from === "golem" && /paused/.test(m.text)));
  assert.ok(b.some((m) => m.from === "golem" && /paused/.test(m.text)));
  assert.throws(() => bus.send("Flint", "Clay", "one more"), /paused/);
  assert.throws(() => bus.send("Clay", "Nobody", "x"), /no agent named Nobody/);
  assert.throws(() => bus.send("Clay", "Clay", "x"), /that's you/);
  assert.match(bus.roster("Clay"), /^Flint: Flint ok$/);
  return new Promise<void>((r) => setTimeout(() => { assert.equal(bus.send("Clay", "Flint", "again").remaining, 2); r(); }, 60));
});
