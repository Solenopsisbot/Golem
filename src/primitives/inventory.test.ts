import { test } from "node:test";
import assert from "node:assert/strict";
import { Inventory, invToHandlerSlot } from "./inventory.ts";

test("inventory -> handler slot mapping with no container open", () => {
  assert.equal(invToHandlerSlot(0), 36);   // hotbar 0
  assert.equal(invToHandlerSlot(8), 44);
  assert.equal(invToHandlerSlot(9), 9);    // main
  assert.equal(invToHandlerSlot(35), 35);
  assert.equal(invToHandlerSlot(36), 8);   // boots
  assert.equal(invToHandlerSlot(39), 5);   // helmet
  assert.equal(invToHandlerSlot(40), 45);  // offhand
});

test("inventory -> handler slot mapping with a 27-slot chest open", () => {
  assert.equal(invToHandlerSlot(9, 27), 27);
  assert.equal(invToHandlerSlot(35, 27), 53);
  assert.equal(invToHandlerSlot(0, 27), 54);
  assert.equal(invToHandlerSlot(8, 27), 62);
});

test("Inventory helpers", () => {
  const inv = new Inventory({ selectedSlot: 2, items: [
    { slot: 2, item: "minecraft:oak_log", name: "Oak Log", count: 12 },
    { slot: 10, item: "minecraft:oak_log", name: "Oak Log", count: 3 },
    { slot: 36, item: "minecraft:iron_boots", name: "Iron Boots", count: 1 },
  ] });
  assert.equal(inv.count("oak_log"), 15);
  assert.ok(inv.has("minecraft:oak_log", 15));
  assert.equal(inv.held?.item, "minecraft:oak_log");
  assert.equal(inv.armor.length, 1);
  assert.equal(inv.freeSlots, 34);
});
