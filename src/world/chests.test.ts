import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chestsWith, loadAllChests, recordChest } from "./chests.ts";

test("two agents share one chest index with who-saw-it, private copies stay private", () => {
  const root = mkdtempSync(join(tmpdir(), "golem-chests-"));
  const shared = join(root, "shared", "world");
  const clay = { name: "Clay", workspaceDir: join(root, "Clay", "workspace"), sharedWorldDir: shared };
  const flint = { name: "Flint", workspaceDir: join(root, "Flint", "workspace"), sharedWorldDir: shared };
  const slots = (items: string[]) => [...items.map((it, i) => ({ slot: i, item: it, count: 4 })), ...Array.from({ length: 36 }, (_, i) => ({ slot: 27 + i, item: "minecraft:dirt", count: 1 }))];
  recordChest(clay, { x: 1, y: 64, z: 1 }, "minecraft:overworld", "h", slots(["minecraft:iron_ingot x4", "minecraft:coal"]), { kind: "chest", containerSize: 27 });
  recordChest(flint, { x: 9, y: 64, z: 9 }, "minecraft:overworld", "h", slots(["minecraft:bread"]), { kind: "barrel", containerSize: 27 });
  // Flint never opened Clay's chest privately, but sees it through the shared index.
  assert.equal(Object.keys(loadAllChests(flint)).length, 2);
  assert.equal(chestsWith(flint, "iron_ingot")[0]?.seenBy, "Clay");
  assert.equal(chestsWith(clay, "bread").length, 1);
  const md = readFileSync(join(shared, "chests.md"), "utf8");
  assert.match(md, /\(1, 64, 1\) chest: iron_ingot 4, coal 4  \(Clay,/);
  assert.match(md, /\(9, 64, 9\) barrel: bread 4  \(Flint,/);
  assert.ok(!md.includes("dirt"), "player inventory slots must not be indexed");
  assert.ok(existsSync(join(clay.workspaceDir, "world", "chests.json")));
  // Without a shared dir nothing leaks.
  const solo = { name: "Solo", workspaceDir: join(root, "Solo", "workspace") };
  recordChest(solo, { x: 2, y: 2, z: 2 }, "minecraft:overworld", "h", slots([]), { containerSize: 27 });
  assert.equal(Object.keys(loadAllChests(solo)).length, 1);
});
