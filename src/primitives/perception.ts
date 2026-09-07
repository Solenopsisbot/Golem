// Read-only questions about the world. Cheap ones come from the mirror; exact ones call the body.
import type { BlockAtResult, ChatHistoryEntry, EntityResult, FindBlocksHit, PlayerEntry, TargetResult } from "../body/results.ts";
import { center, dist, fmtPos, type Pos, type Vec } from "../util/geom.ts";
import { fullId, shortId, type Ctx } from "./context.ts";
import { GolemError, fromClef } from "./errors.ts";
import { inventory } from "./inventory.ts";

export interface Block { id: string; short: string; air: boolean; solid: boolean; liquid: boolean; pos: Pos }

const LIQUIDS = new Set(["minecraft:water", "minecraft:lava"]);
/**
 * Blocks you walk *through* rather than into. They are not air and not liquid, so the naive test
 * calls them solid — which makes `goto` bump its reach and stop the body politely beside the portal
 * instead of in it, and then the portal never fires. Standing in one is the whole point.
 */
const PASSABLE = new Set(["minecraft:nether_portal", "minecraft:end_portal", "minecraft:end_gateway"]);
/** Blocks a placement may overwrite (vanilla "replaceable" is longer; these are the common ones). */
export const REPLACEABLE = new Set([
  "minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:water", "minecraft:lava",
  "minecraft:short_grass", "minecraft:grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern",
  "minecraft:seagrass", "minecraft:tall_seagrass", "minecraft:snow", "minecraft:vine", "minecraft:dead_bush",
  "minecraft:fire", "minecraft:light", "minecraft:structure_void",
]);

export async function blockAt(ctx: Ctx, p: Pos): Promise<Block> {
  let r: BlockAtResult;
  try { r = (await ctx.body.call("blockAt", { x: p.x, y: p.y, z: p.z })) as BlockAtResult; }
  catch (e) { throw fromClef(e, `blockAt ${fmtPos(p)}`); }
  const liquid = LIQUIDS.has(r.block);
  return { id: r.block, short: shortId(r.block), air: r.air, liquid, solid: !r.air && !liquid && !REPLACEABLE.has(r.block) && !PASSABLE.has(r.block), pos: p };
}

export interface FindBlocksOpts { radius?: number; max?: number }

/**
 * Nearest blocks of the given kinds. Uses the body's `findBlocks` (CLEF-CHANGES #1) when present.
 * Without it there is no honest way to scan (blockAt is one round-trip per block), so this throws
 * `unsupported`; navigation-to-nearest still works through nav.gotoNearestBlock (Baritone scans).
 */
export async function findBlocks(ctx: Ctx, kinds: string | string[], opts: FindBlocksOpts = {}): Promise<(Pos & { block: string; dist: number })[]> {
  const ids = (Array.isArray(kinds) ? kinds : [kinds]).map(fullId);
  const radius = opts.radius ?? 32;
  const max = opts.max ?? 32;
  if (!ctx.body.caps.has("findBlocks")) {
    throw new GolemError("unsupported", "the body has no findBlocks command yet (docs/CLEF-CHANGES.md #1); use gotoNearestBlock / mineAll, which scan through Baritone");
  }
  let hits: FindBlocksHit[];
  try { hits = (await ctx.body.call("findBlocks", { ids, radius, max, sort: "nearest" })) as FindBlocksHit[]; }
  catch (e) { throw fromClef(e, `findBlocks ${ids.map(shortId).join(",")}`); }
  const eye = ctx.mirror.eye;
  return hits.map((h) => ({ ...h, dist: dist(eye, center(h)) })).sort((a, b) => a.dist - b.dist);
}

export interface Entity extends EntityResult { short: string; hostile: boolean; isItem: boolean; isPlayer: boolean; pos: Vec; vel: Vec }

export interface EntitiesOpts { radius?: number; kinds?: string[]; hostileOnly?: boolean }

export async function entities(ctx: Ctx, opts: EntitiesOpts = {}): Promise<Entity[]> {
  const radius = opts.radius ?? 16;
  const kinds = opts.kinds?.map(fullId);
  let raw: EntityResult[];
  try {
    const args: Record<string, unknown> = { radius };
    if (kinds && ctx.body.caps.hasArg("entities", "kinds")) args.kinds = kinds;   // protocol 2 filters body-side
    raw = (await ctx.body.call("entities", args)) as EntityResult[];
  } catch (e) { throw fromClef(e, "entities"); }
  const out: Entity[] = [];
  for (const e of raw) {
    const short = shortId(e.type);
    const info = ctx.mc.entitiesByName[short];
    const hostile = e.hostile ?? (info?.type === "hostile");
    // Motion comes flat (vx/vy/vz) or as an array; older bodies send neither, so it defaults to still.
    const vel: Vec = { x: e.vx ?? e.velocity?.x ?? 0, y: e.vy ?? e.velocity?.y ?? 0, z: e.vz ?? e.velocity?.z ?? 0 };
    const ent: Entity = { ...e, short, hostile, isItem: short === "item", isPlayer: short === "player", pos: { x: e.x, y: e.y, z: e.z }, vel };
    if (kinds && !kinds.includes(e.type)) continue;
    if (opts.hostileOnly && !hostile) continue;
    out.push(ent);
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export async function threats(ctx: Ctx, radius = 12): Promise<Entity[]> {
  return entities(ctx, { radius, hostileOnly: true });
}

export async function nearestEntity(ctx: Ctx, opts: EntitiesOpts = {}): Promise<Entity | undefined> {
  return (await entities(ctx, opts))[0];
}

export async function entityById(ctx: Ctx, id: number, radius = 48): Promise<Entity | undefined> {
  return (await entities(ctx, { radius })).find((e) => e.id === id);
}

export async function players(ctx: Ctx): Promise<PlayerEntry[]> {
  try { return (await ctx.body.call("players")) as PlayerEntry[]; }
  catch (e) { throw fromClef(e, "players"); }
}

/** The structured-perception summary. Grows as the body grows (findBlocks, richer status). */
export async function lookAround(ctx: Ctx, radius = 16): Promise<string> {
  const m = ctx.mirror;
  const lines: string[] = [];
  lines.push(m.summary(ctx.agent.name));
  const ents = await entities(ctx, { radius });
  const hostile = ents.filter((e) => e.hostile);
  const playersNear = ents.filter((e) => e.isPlayer);
  const items = ents.filter((e) => e.isItem);
  const others = ents.filter((e) => !e.hostile && !e.isPlayer && !e.isItem);
  const fmtE = (e: Entity) => `${e.isPlayer ? e.name : e.short}#${e.id} ${e.distance.toFixed(1)}m ${fmtPos(e.pos)}`;
  if (hostile.length) lines.push(`threats (${hostile.length}): ${hostile.slice(0, 6).map(fmtE).join("; ")}`);
  if (playersNear.length) lines.push(`players: ${playersNear.map(fmtE).join("; ")}`);
  if (others.length) {
    const counts = new Map<string, number>();
    for (const e of others) counts.set(e.short, (counts.get(e.short) ?? 0) + 1);
    lines.push(`mobs: ${[...counts].map(([k, n]) => `${k} x${n}`).join(", ")}; nearest ${fmtE(others[0]!)}`);
  }
  if (items.length) lines.push(`dropped items: ${items.length}, nearest ${items[0]!.distance.toFixed(1)}m`);
  const below = await blockAt(ctx, { ...m.blockPos, y: m.blockPos.y - 1 });
  lines.push(`standing on ${below.short}`);
  if (ctx.body.caps.has("findBlocks")) {
    const interesting = ["oak_log", "birch_log", "spruce_log", "crafting_table", "furnace", "chest", "water", "coal_ore", "iron_ore"];
    try {
      const hits = await findBlocks(ctx, interesting, { radius, max: 64 });
      const nearestByKind = new Map<string, typeof hits[number]>();
      for (const h of hits) if (!nearestByKind.has(h.block)) nearestByKind.set(h.block, h);
      if (nearestByKind.size) lines.push(`nearby blocks: ${[...nearestByKind.values()].map((h) => `${shortId(h.block)} ${h.dist.toFixed(0)}m ${fmtPos(h)}`).join("; ")}`);
    } catch { /* fine */ }
  } else {
    lines.push("(no block scan: body lacks findBlocks)");
  }
  const inv = await inventory(ctx);
  lines.push(inv.describe().split("\n")[0]!);
  return lines.join("\n");
}

/** What the crosshair is on (protocol 2 `target`). */
export async function target(ctx: Ctx, maxDistance = 4.5): Promise<TargetResult> {
  if (!ctx.body.caps.has("target")) throw new GolemError("unsupported", "the body has no target command yet (docs/CLEF-CHANGES.md #6)");
  try { return (await ctx.body.call("target", { maxDistance })) as TargetResult; }
  catch (e) { throw fromClef(e, "target"); }
}

/** Recent chat lines the body saw (protocol 2 `chatHistory`). */
export async function chatHistory(ctx: Ctx, limit = 50): Promise<ChatHistoryEntry[]> {
  if (!ctx.body.caps.has("chatHistory")) throw new GolemError("unsupported", "the body has no chatHistory command yet (docs/CLEF-CHANGES.md #14)");
  let r: unknown;
  try { r = await ctx.body.call("chatHistory", { limit }); }
  catch (e) { throw fromClef(e, "chatHistory"); }
  if (Array.isArray(r)) return r as ChatHistoryEntry[];
  const o = (r ?? {}) as Record<string, unknown>;
  const list = o.lines ?? o.entries ?? o.messages ?? o.history ?? [];
  return (Array.isArray(list) ? list : []) as ChatHistoryEntry[];
}
