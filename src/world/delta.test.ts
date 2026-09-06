import { test } from "node:test";
import assert from "node:assert/strict";
import { countItems, inventoryDelta } from "./delta.ts";

test("inventory delta names gains and losses, largest first, capped", () => {
  const before = countItems([{ item: "minecraft:bone_meal", count: 3 }, { item: "minecraft:torch x14", count: 14 }, { item: "empty", count: 0 }]);
  const after = countItems([{ item: "minecraft:bone_meal", count: 2 }, { item: "minecraft:torch", count: 14 }, { item: "minecraft:melon_slice", count: 6 }, { item: "minecraft:melon_slice", count: 3 }]);
  assert.equal(inventoryDelta(before, after), "+9 melon_slice, -1 bone_meal");
  assert.equal(inventoryDelta(after, after), "");
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`item${i}`, i + 1]));
  assert.match(inventoryDelta({}, many), /, \+4 more$/);
});
