import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveAgent } from "./load.ts";
import { parseDuration, parseRate } from "./schema.ts";

test("loads defaults and per-agent overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "golem-"));
  writeFileSync(join(dir, "golem.toml"), `
[clef]
base_port = 9000
[[agents]]
name = "A"
[[agents]]
name = "B"
body.port = 9500
chat.speech = "auto"
reflexes.on = ["auto_eat"]
`);
  const loaded = loadConfig(join(dir, "golem.toml"));
  const a = resolveAgent(loaded, "A");
  const b = resolveAgent(loaded, "B");
  assert.equal(a.body.port, 9000);
  assert.equal(b.body.port, 9500);
  assert.equal(a.chat.speech, "explicit");
  assert.equal(b.chat.speech, "auto");
  assert.deepEqual(b.reflexes.on, ["auto_eat"]);
  assert.ok(a.reflexes.on.includes("self_preservation"));
  assert.equal(a.mind.budget.tokens_per_hour, 2_000_000);
  assert.equal(a.body.server.port, 25565);
  assert.throws(() => resolveAgent(loaded, "C"));
});

test("durations and rates", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("2m"), 120_000);
  assert.deepEqual(parseRate("1/3s"), { count: 1, perMs: 3000 });
});
