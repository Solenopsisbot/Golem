// Inventory reading, item selection (getting an item into the hotbar and into hand), tool and
// food choice. The two slot numbering schemes matter here:
//
//   PlayerInventory (what `inventory` and `findItem` report):
//     0-8 hotbar, 9-35 main, 36-39 armor (boots, leggings, chestplate, helmet), 40 offhand
//   Screen handler slots (what `clickSlot` takes), with NO container open (PlayerScreenHandler):
//     0 craft result, 1-4 craft grid, 5-8 armor (helmet, chest, legs, boots), 9-35 main,
//     36-44 hotbar, 45 offhand
//   With a container of N slots open: 0..N-1 container, N..N+26 main (inv 9-35), N+27..N+35 hotbar (inv 0-8)
import type { InventoryItem, InventoryResult, FindItemResult, MoveToHotbarResult } from "../body/results.ts";
import { fullId, shortId, type Ctx } from "./context.ts";
import { GolemError, fromClef, until } from "./errors.ts";

export class Inventory {
  readonly items: InventoryItem[];
  readonly selectedSlot: number;
  constructor(raw: InventoryResult) {
    this.items = raw.items;
    this.selectedSlot = raw.selectedSlot;
  }
  count(item: string): number {
    const id = fullId(item);
    return this.items.filter((i) => i.item === id).reduce((a, i) => a + i.count, 0);
  }
  has(item: string, n = 1): boolean { return this.count(item) >= n; }
  slotsOf(item: string): InventoryItem[] { const id = fullId(item); return this.items.filter((i) => i.item === id); }
  hotbar(): (InventoryItem | undefined)[] {
    const row: (InventoryItem | undefined)[] = new Array(9).fill(undefined);
    for (const i of this.items) if (i.slot <= 8) row[i.slot] = i;
    return row;
  }
  get held(): InventoryItem | undefined { return this.items.find((i) => i.slot === this.selectedSlot); }
  get armor(): InventoryItem[] { return this.items.filter((i) => i.slot >= 36 && i.slot <= 39); }
  get offhand(): InventoryItem | undefined { return this.items.find((i) => i.slot === 40); }
  get freeSlots(): number { return 36 - this.items.filter((i) => i.slot <= 35).length; }
  /** Compact text for models and humans. */
  describe(): string {
    if (this.items.length === 0) return "inventory: empty";
    const main = this.items.filter((i) => i.slot <= 35).map((i) => `${shortId(i.item)} x${i.count}${i.slot <= 8 ? ` [${i.slot}]` : ""}`);
    const armor = this.armor.map((i) => shortId(i.item));
    const parts = [`inventory (${this.freeSlots} free): ${main.join(", ")}`];
    if (armor.length) parts.push(`armor: ${armor.join(", ")}`);
    if (this.offhand) parts.push(`offhand: ${shortId(this.offhand.item)}`);
    parts.push(`held: ${this.held ? shortId(this.held.item) : "nothing"} (slot ${this.selectedSlot})`);
    return parts.join("\n");
  }
}

export async function inventory(ctx: Ctx): Promise<Inventory> {
  try { return new Inventory((await ctx.body.call("inventory")) as InventoryResult); }
  catch (e) { throw fromClef(e, "inventory"); }
}

export function invToHandlerSlot(invSlot: number, containerSize?: number): number {
  if (containerSize !== undefined) {
    if (invSlot <= 8) return containerSize + 27 + invSlot;
    if (invSlot <= 35) return containerSize + (invSlot - 9);
    throw new GolemError("failed", `armor/offhand slot ${invSlot} is not reachable while a container is open`);
  }
  if (invSlot <= 8) return 36 + invSlot;
  if (invSlot <= 35) return invSlot;
  if (invSlot <= 39) return 8 - (invSlot - 36);   // boots(36)->8 ... helmet(39)->5
  if (invSlot === 40) return 45;
  throw new GolemError("failed", `bad inventory slot ${invSlot}`);
}

const TOOL_SUFFIXES = ["_pickaxe", "_axe", "_shovel", "_hoe", "_sword"];
const NON_BLOCK_HINTS = [..."_pickaxe _axe _shovel _hoe _sword _bow _crossbow _trident _shield _helmet _chestplate _leggings _boots".split(" ")];

/** Picks a hotbar slot to swap something into: empty first, then something that isn't a tool. */
function pickHotbarSlot(inv: Inventory, exclude: Set<number>): number {
  const row = inv.hotbar();
  for (let i = 0; i < 9; i++) if (!row[i] && !exclude.has(i)) return i;
  for (let i = 8; i >= 0; i--) {
    const it = row[i];
    if (!exclude.has(i) && it && !NON_BLOCK_HINTS.some((s) => it.item.endsWith(s))) return i;
  }
  for (let i = 8; i >= 0; i--) if (!exclude.has(i)) return i;
  return 8;
}

/**
 * Get `item` into the hotbar and select it. Moves it from the main inventory with a SWAP click if
 * needed. Closes any open screen first because the handler slot numbers change under a container.
 * Returns the hotbar slot now selected.
 */
export async function selectItem(ctx: Ctx, item: string): Promise<number> {
  const id = fullId(item);
  const found = (await ctx.body.call("findItem", { item: id }).catch((e) => { throw fromClef(e, `findItem ${item}`); })) as FindItemResult;
  if (!found.total) throw new GolemError("missing_item", `no ${shortId(id)} in inventory`);
  const inHotbar = found.slots.find((s) => s.slot <= 8);
  if (inHotbar) {
    if (ctx.mirror.selectedSlot !== inHotbar.slot) await ctx.body.call("setSlot", { slot: inHotbar.slot });
    ctx.mirror.selectedSlot = inHotbar.slot;
    return inHotbar.slot;
  }
  if (ctx.body.caps.has("moveToHotbar")) {
    // Protocol 2: the body does the swap on the main thread and tells us the slot.
    let r: MoveToHotbarResult;
    try { r = (await ctx.body.call("moveToHotbar", { item: id })) as MoveToHotbarResult; }
    catch (e) { throw fromClef(e, `moveToHotbar ${shortId(id)}`); }
    await ctx.body.call("setSlot", { slot: r.slot });
    ctx.mirror.selectedSlot = r.slot;
    return r.slot;
  }
  if (ctx.mirror.screen) {
    await ctx.body.call("closeScreen");
    await until(() => !ctx.mirror.screen, { timeoutMs: 1500, what: "closing screen", token: ctx.token, intervalMs: 100 }).catch(() => {});
  }
  const inv = await inventory(ctx);
  const target = pickHotbarSlot(inv, new Set());
  const source = found.slots[0]!.slot;
  await ctx.body.call("clickSlot", { slot: invToHandlerSlot(source), button: target, mode: "swap" });
  await ctx.body.call("setSlot", { slot: target });
  ctx.mirror.selectedSlot = target;
  // Verify: the server confirms the swap asynchronously.
  await until(async () => (await inventory(ctx)).hotbar()[target]?.item === id,
    { timeoutMs: 1500, intervalMs: 150, what: `moving ${shortId(id)} to hotbar`, token: ctx.token })
    .catch(() => { throw new GolemError("failed", `could not move ${shortId(id)} into the hotbar`); });
  return target;
}

const TIERS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];

/** What tool class a block wants ("pickaxe" | "axe" | "shovel" | "hoe" | null) and which tool ids can harvest it. */
export function toolNeeds(ctx: Ctx, blockId: string): { cls: string | null; harvest: Set<string> | null } {
  const b = ctx.mc.blocksByName[shortId(blockId)];
  if (!b) return { cls: null, harvest: null };
  const harvest = b.harvestTools ? new Set(Object.keys(b.harvestTools).map((id) => ctx.mc.items[Number(id)]?.name).filter((n): n is string => !!n)) : null;
  let cls: string | null = null;
  if (b.material?.startsWith("mineable/")) cls = b.material.slice("mineable/".length);
  else if (harvest && harvest.size) {
    const first = [...harvest][0]!;
    cls = TOOL_SUFFIXES.map((s) => s.slice(1)).find((c) => first.endsWith("_" + c)) ?? null;
  }
  return { cls, harvest };
}

/** Best tool in inventory for a block, or null if none helps. Throws if the block needs a tool we lack. */
export async function bestTool(ctx: Ctx, blockId: string): Promise<string | null> {
  const { cls, harvest } = toolNeeds(ctx, blockId);
  if (!cls) return null;
  const inv = await inventory(ctx);
  const candidates = inv.items.filter((i) => i.item.endsWith("_" + cls)).map((i) => shortId(i.item));
  const ranked = candidates.sort((a, b) => TIERS.findIndex((t) => a.startsWith(t)) - TIERS.findIndex((t) => b.startsWith(t)));
  const usable = harvest ? ranked.filter((t) => harvest.has(t)) : ranked;
  if (harvest && harvest.size && usable.length === 0) {
    throw new GolemError("cant_break", `${shortId(blockId)} needs one of: ${[...harvest].join(", ")}`);
  }
  return usable[0] ?? null;
}

const FOOD_AVOID = new Set(["rotten_flesh", "spider_eye", "pufferfish", "poisonous_potato", "chorus_fruit", "suspicious_stew", "chicken", "golden_apple", "enchanted_golden_apple"]);

/** Best food in inventory by food points (skipping the ones that hurt or are too precious). */
export async function bestFood(ctx: Ctx): Promise<string | null> {
  const inv = await inventory(ctx);
  let best: { name: string; pts: number } | null = null;
  for (const i of inv.items) {
    const name = shortId(i.item);
    const f = ctx.mc.foodsByName[name];
    if (!f || FOOD_AVOID.has(name)) continue;
    if (!best || f.foodPoints > best.pts) best = { name, pts: f.foodPoints };
  }
  return best?.name ?? null;
}
