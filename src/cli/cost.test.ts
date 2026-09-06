import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCost, summarise } from "./cost.ts";

test("cost summary aggregates turn records, tools and compactions inside the window", () => {
  const now = 10_000_000_000;
  const recs = [
    { t: now - 1000, role: "agent", text: "", tokens: 1_000_000, cached: 900_000, toolCalls: 4, ms: 60_000, model: "opus[1m]", planning: false },
    { t: now - 2000, role: "agent", text: "", tokens: 200_000, cached: 150_000, toolCalls: 1, ms: 20_000, model: "claude-fable-5-1", planning: true },
    { t: now - 3000, role: "tool", text: 'shem_eval({"code":"x"}) -> ok' },
    { t: now - 3000, role: "tool", text: 'inventory({}) -> ...' },
    { t: now - 3000, role: "event", text: "context compacted", compaction: true },
    { t: now - 10 * 3_600_000, role: "agent", text: "old", tokens: 5, cached: 0, toolCalls: 9, ms: 1, model: "x", planning: false },
  ];
  const s = summarise("Clay", recs, 1, now);
  assert.equal(s.turns, 2); assert.equal(s.planningTurns, 1); assert.equal(s.tokens, 1_200_000); assert.equal(s.cached, 1_050_000);
  assert.equal(s.toolCalls, 5); assert.equal(s.compactions, 1); assert.deepEqual(s.tools, { shem_eval: 1, inventory: 1 });
  const text = renderCost([s]);
  assert.match(text, /Clay\s+2\s+1\s+1\.2M\s+1\.1M\s+150k/);
  assert.match(text, /opus\[1m\]: 1 turns, 1\.0M/);
});
