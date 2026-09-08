// Built-in reflexes. Each is small, defensive, and honest about what the body can't yet tell us.
import type { Ctx } from "../primitives/context.ts";
import { sleep } from "../primitives/errors.ts";
import type { Entity } from "../primitives/perception.ts";
import type { Reflex } from "./engine.ts";
import { dist, fmtPos } from "../util/geom.ts";
import { GolemError } from "../primitives/errors.ts";
import { PEARL, solveAim } from "../primitives/actions.ts";

export const autoRespawn: Reflex<true> = {
  name: "auto_respawn",
  description: "Respawn a moment after dying.",
  priority: 100,
  interrupts: true,
  cooldownMs: 3000,
  check: (ctx) => ctx.mirror.dead || (ctx.mirror.inWorld && ctx.mirror.health <= 0) ? true : null,
  async act(p) {
    await sleep(1500, p.ctx.token);
    await p.respawn();
    return "respawned";
  },
};

interface Danger { kind: "hurt" | "burning" | "lava" | "drowning" | "hot_floor" | "in_fire" | "in_wall" | "prickly" | "breath"; hp: number; source?: string }

/**
 * Damage types that mean "where you are standing is hurting you", and so are worth acting on at any
 * health rather than waiting for the low-health trigger.
 *
 * `indirect_magic` is here because it is how a lingering cloud actually damages you - through the
 * Instant Damage effect it applies - and `dragon_breath` is only the direct attack. Without it the
 * cloud went unnoticed until health fell to 7, which is far too late: the pool ticks once a second
 * and walking clear takes a few seconds, so the escape started already losing the race. Tester died
 * at hp 2 with the escape running.
 */
const FLOOR_DANGER: Record<string, Danger["kind"]> = {
  hot_floor: "hot_floor", in_fire: "in_fire", in_wall: "in_wall", cactus: "prickly", sweet_berry_bush: "prickly",
  dragon_breath: "breath", indirect_magic: "breath",
};
const BAD_FOOTING = new Set(["minecraft:magma_block", "minecraft:lava", "minecraft:fire", "minecraft:soul_fire", "minecraft:cactus", "minecraft:sweet_berry_bush", "minecraft:campfire", "minecraft:soul_campfire", "minecraft:wither_rose", "minecraft:powder_snow"]);

/**
 * Walk to the nearest block that is safe to stand on: solid floor that is none of the hurting kinds,
 * with two air blocks above, searching outward ring by ring. Returns where it went, or null.
 *
 * `maxRing` is how far to look. Two blocks is right for stepping off magma or a cactus, where the
 * hazard is the block underfoot and further is just slower - a ring costs a blockAt for every cell
 * in it. It is nowhere near enough for something with an area, which is why the callers that are
 * running from a cloud ask for more.
 *
 * Every candidate is floor-checked and reached with goto, which is what makes this safe to widen:
 * in the End, "just sprint somewhere else" is how a bot walks off the island into the void.
 */
const RINGS = [1, 2, 3, 5, 7];
async function stepOff(p: import("../primitives/index.ts").Primitives, maxRing = 2): Promise<{ x: number; y: number; z: number } | null> {
  const here = p.ctx.mirror.blockPos;
  const ring = (r: number) => { const out: [number, number][] = []; for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push([dx, dz]); return out.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1]))); };
  for (const r of RINGS.filter((r) => r <= maxRing)) {
    for (const [dx, dz] of ring(r)) {
      for (const dy of [0, 1, -1]) {   // same level first, then a step up or down
        const spot = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
        const [floor, feet, head] = await Promise.all([p.blockAt({ ...spot, y: spot.y - 1 }), p.blockAt(spot), p.blockAt({ ...spot, y: spot.y + 1 })]);
        if (!floor.solid || BAD_FOOTING.has(floor.id) || !feet.air || !head.air || BAD_FOOTING.has(feet.id)) continue;
        try { await p.goto(spot, { reach: 0, timeoutMs: 6000 }); return spot; } catch { continue; }
      }
    }
  }
  return null;
}

/**
 * Get out of a lingering cloud - dragon breath, a lingering potion - which is an ENTITY, not a block.
 *
 * This is the one danger `stepOff` cannot handle, and it fails silently in the worst way. The floor
 * inside a cloud is perfectly good floor, so `stepOff` finds a "safe" spot one block away, walks
 * there, and reports success while the bot keeps taking damage. It only searches rings 1 and 2, and
 * dragon breath starts about three blocks across and grows, so two blocks never leaves it. Tester
 * died twice in three minutes in a breath pool that way: damage, step one block, damage, step one
 * block, with each planning turn cancelled by the damage interrupt before it could think its way out.
 *
 * Matching on the damage type does not work either - the lingering cloud deals `indirect_magic`,
 * while `dragon_breath` is only the direct attack - so look for the cloud itself and cover real
 * ground away from it.
 */
async function escapeCloud(p: import("../primitives/index.ts").Primitives): Promise<string | null> {
  // Radius 16, not 10: a dragon breath cloud measures about 6 from its centre and `entities` gives
  // the centre, so a cloud swallowing us whole can report as 10-plus blocks away.
  const clouds = await p.entities({ radius: 16, kinds: ["area_effect_cloud"] }).catch(() => [] as Entity[]);
  if (!clouds.length) return null;
  const here = p.ctx.mirror.blockPos;
  const cx = clouds.reduce((a: number, c: Entity) => a + c.pos.x, 0) / clouds.length;
  const cz = clouds.reduce((a: number, c: Entity) => a + c.pos.z, 0) / clouds.length;
  // Straight away from the cloud, and if that is blocked, fan out to either side. Falling back to a
  // plain "run away" vector is what must NOT happen here: on the End island, away from a cloud near
  // the fountain points at the rim, and Baritone answers a goal out over the void by walking to the
  // edge and timing out there. Every candidate below is floor-checked before it is walked to, so a
  // target hanging in the air is never chosen at all.
  let dx = here.x - cx, dz = here.z - cz;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const CLEAR = 9;             // cloud radius is about 6; this leaves daylight around the edge
  for (const dist of [10, 14]) {
    for (const turn of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
      const ux = dx * Math.cos(turn) - dz * Math.sin(turn);
      const uz = dx * Math.sin(turn) + dz * Math.cos(turn);
      const x = Math.round(here.x + ux * dist), z = Math.round(here.z + uz * dist);
      if (clouds.some((c: Entity) => Math.hypot(x - c.pos.x, z - c.pos.z) < CLEAR)) continue;
      // Try a few heights, not just our own. Standing in a dip - or on the respawn point, which on
      // the End island sits below the surface - every candidate at our exact y is solid rock, so the
      // whole search comes back empty and the caller quietly falls through to a one-block sidestep.
      // That is how Tester ended up "stepping off" to the same block once a second while a cloud sat
      // directly on its respawn point.
      for (const dy of [0, 1, 2, -1, 3]) {
        const spot = { x, y: here.y + dy, z };
        const [floor, feet, head] = await Promise.all([
          p.blockAt({ ...spot, y: spot.y - 1 }), p.blockAt(spot), p.blockAt({ ...spot, y: spot.y + 1 }),
        ]);
        if (!floor.solid || BAD_FOOTING.has(floor.id) || !feet.air || !head.air) continue;
        // Pearl out when the walk is the thing killing us.
        //
        // Walking clear takes seconds and every one of them is spent inside the cloud, which is why
        // moving twice - at 14 hp and again at 4 - still ended in a death. A pearl is instant. It
        // costs 5 on landing, so only throw one with enough health left to pay that, and only when
        // the distance makes it worth it.
        const hp = p.ctx.mirror.health;
        const far = Math.hypot(spot.x - here.x, spot.z - here.z);
        if (hp <= 14 && hp >= 8 && far >= 8) {
          const pearls = await p.inventory().then((i) => i.count("ender_pearl")).catch(() => 0);
          if (pearls > 0) {
            const aim = solveAim(p.ctx.mirror.eye, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, PEARL);
            if (aim) {
              try {
                await p.equip("ender_pearl");
                await p.lookAt({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
                await p.useItem();
                return `${clouds.length} lingering cloud(s): pearled to ${fmtPos(spot)} at ${hp.toFixed(0)} hp`;
              } catch { /* fall through to walking */ }
            }
          }
        }
        // Six seconds, not twelve: the reflex re-fires every four, and a long goal that cannot be
        // reached just stacks moves until the body starts answering RATE_LIMIT.
        try { await p.goto(spot, { reach: 1, timeoutMs: 6000 }); }
        catch { continue; }
        return `${clouds.length} lingering cloud(s): moved to ${fmtPos(spot)}`;
      }
    }
  }
  // A cloud is on us and there is nowhere vetted to go. Say so: the alternative is returning null and
  // letting the caller report a one-block sidestep as if it had worked.
  return `${clouds.length} lingering cloud(s) and no clear ground found - staying put and eating`;
}

export const selfPreservation: Reflex<Danger> = {
  name: "self_preservation",
  description: "Get away from whatever is hurting you: off magma, fire, cactus and dragon breath, out of a wall, out of lava and water, away from an attacker when health is low.",
  priority: 90,
  interrupts: true,
  cooldownMs: 4000,
  check: (ctx) => {
    const m = ctx.mirror;
    const s = m.status?.player;
    if (s?.inLava) return { kind: "lava", hp: m.health };
    // Standing in or on something that hurts: act at any health, every second on a magma block costs a heart.
    const src = m.damageSourceInLast(2500);
    if (src && FLOOR_DANGER[src] && m.damageInLast(2500) > 0) return { kind: FLOOR_DANGER[src]!, hp: m.health, source: src };
    if (s?.onFire && m.health <= 12) return { kind: "burning", hp: m.health };
    if (s?.air !== undefined && s.air <= 60) return { kind: "drowning", hp: m.health };
    if (m.health <= 7 && m.damageInLast(3000) > 0) return { kind: "hurt", hp: m.health, source: src ?? undefined };
    return null;
  },
  async act(p, d) {
    const ctx = p.ctx;
    if (d.kind === "in_wall") {
      // Suffocating inside a block (a bad teleport, sand falling on you): open the head and feet blocks.
      const here = ctx.mirror.blockPos;
      const opened: string[] = [];
      for (const dy of [1, 0]) {
        const b = await p.blockAt({ x: here.x, y: here.y + dy, z: here.z });
        if (b.solid) { try { await p.mine(b.pos, { collect: false }); opened.push(b.short); } catch { /* keep going */ } }
      }
      return `in a wall: broke ${opened.join(", ") || "nothing (not solid?)"}`;
    }
    // Before any floor check: a cloud outranks footing, and standing in one is how a fight is lost.
    const fled = await escapeCloud(p).catch(() => null);
    if (fled) return `hp ${d.hp.toFixed(0)}: ${fled}`;
    if (d.kind === "hot_floor" || d.kind === "in_fire" || d.kind === "prickly" || d.kind === "breath") {
      const spot = await stepOff(p);
      if (spot) return `${d.source}: stepped off to ${fmtPos(spot)}`;
      await p.move("forward", 700, { sprint: true, jump: true });
      return `${d.source}: no safe block beside me, moved blind`;
    }
    if (d.kind === "lava" || d.kind === "drowning") {
      // Back to the last place the body stood dry: Baritone swims and climbs; "step back and jump"
      // put a golem back into a flooded pocket five times in a row until it drowned at full health.
      const dry = ctx.mirror.lastDryPos;
      if (dry && dist(dry, ctx.mirror.blockPos) <= 24) {
        try {
          await p.goto(dry, { timeoutMs: 8000 });
          return `${d.kind}: back to dry ground at ${fmtPos(dry)}`;
        } catch { /* fall through to the blind move */ }
      }
      await p.move("backward", 600, { jump: true, sprint: true });
      await p.jump();
      return `${d.kind}: jumped back`;
    }
    const threats = await p.threats(10);
    if (threats.length) {
      const r = await p.flee(threats.map((t: Entity) => t.pos), 14, { timeoutMs: 12_000 });
      return `hp ${d.hp.toFixed(0)}: fled ${threats.length} threat(s) to ${r.pos.x.toFixed(0)},${r.pos.z.toFixed(0)}`;
    }
    if (d.kind === "burning") {
      await p.move("forward", 800, { sprint: true });
      return "on fire: moved";
    }
    // Hurt with nobody in sight: a fall needs nothing; anything else (ghast, blaze, arrow from the
    // dark, magic) is best answered by not standing still.
    if (d.source === "fall" || d.source === "fly_into_wall") return `hp ${d.hp.toFixed(0)}: fall damage, staying put`;
    // Look well past arm's reach. Whatever is hurting us cannot be seen, so we cannot know how big
    // it is; the one thing we do know is that standing here costs health. A single sidestep answered
    // dragon breath with a shuffle and Tester died in the pool three times over.
    const spot = await stepOff(p, 7).catch(() => null);
    if (!spot) await p.move("backward", 600, { sprint: true, jump: true });
    return `hp ${d.hp.toFixed(0)}: hurt by ${d.source ?? "something unseen"} with no threat in sight; moved${spot ? ` to ${fmtPos(spot)}` : ""}`;
  },
};

/**
 * The panic bunker: at night, hurt, with hostiles close, digging two blocks down and capping the
 * hole beats running. Works with an empty inventory because the dirt comes out of the hole.
 */
export const bunker: Reflex<{ hp: number; threats: number }> = {
  name: "bunker",
  description: "When hurt (or just respawned at night) with hostiles close, dig two blocks down and cap the hole with the dirt that came out. Beats running: under a canopy there's nowhere to run to.",
  priority: 92,
  interrupts: true,
  cooldownMs: 45_000,
  check: async (ctx) => {
    const m = ctx.mirror;
    if (m.status?.player?.inWater || m.status?.player?.inLava) return null;
    if (m.dimension.endsWith("the_end")) return null;   // digging down on the End island can be the void
    const night = m.phase === "night" || m.phase === "dusk";
    const justRespawned = night && Date.now() - m.lastRespawnAt < 20_000;
    const hurt = m.health <= 10 && m.damageInLast(5000) > 0;
    if (!hurt && !justRespawned) return null;
    const t = await ctx_threats(ctx, justRespawned ? 14 : 8);
    return t.length ? { hp: m.health, threats: t.length } : null;
  },
  async act(p, d) {
    const ctx = p.ctx;
    await p.stop();
    const here = ctx.mirror.blockPos;
    const below1 = { x: here.x, y: here.y - 1, z: here.z };
    const below2 = { x: here.x, y: here.y - 2, z: here.z };
    for (const b of [below1, below2]) {
      const blk = await p.blockAt(b);
      if (blk.liquid || blk.short === "bedrock" || blk.air) throw new GolemError("blocked", `can't bunker here: ${blk.short} at ${fmtPos(b)}`);
    }
    // The floor of the hole must be solid too: two blocks down over a lava lake is worse than the mobs.
    const floor = await p.blockAt({ x: here.x, y: here.y - 3, z: here.z });
    if (floor.liquid || floor.air) throw new GolemError("blocked", `can't bunker here: ${floor.short} under the hole`);
    await p.mine(below1, { approach: false, tool: "auto", collect: false });
    await p.mine(below2, { approach: false, tool: "auto", collect: false });
    await sleep(600, ctx.token);   // fall into the hole, pickups land
    const feet = ctx.mirror.blockPos;
    const cap = { x: feet.x, y: feet.y + 2, z: feet.z };
    const inv = await p.inventory();
    const filler = ["cobblestone", "dirt", "stone", "netherrack", "sand", "gravel", "oak_planks"].find((i) => inv.has(i)) ?? inv.items.find((i) => ctx.mc.blocksByName[i.item.replace("minecraft:", "")])?.item;
    if (!filler) return `bunkered ${fmtPos(feet)} but nothing to cap the hole with`;
    await p.place(filler, cap, { approach: false });
    return `bunkered at ${fmtPos(feet)} (hp ${d.hp.toFixed(0)}, ${d.threats} threats): two down, capped with ${filler.replace("minecraft:", "")}. Dig out when it's day.`;
  },
};

export const selfDefense: Reflex<Entity> = {
  name: "self_defense",
  description: "Hit back at a hostile mob that is within reach.",
  priority: 80,
  interrupts: true,
  cooldownMs: 1500,
  check: async (ctx) => {
    const a = ctx.mirror.lastAttacker;
    if (a && Date.now() - a.at < 3000) {
      const e = (await ctx_entities(ctx, 12)).find((x) => x.id === a.id);
      if (e && (e.hostile || (e.isPlayer && ctx.agent.etiquette.pvp !== "never"))) return e;
    }
    const near = await ctx_threats(ctx, 4);
    return near[0] ?? null;
  },
  async act(p, e) {
    const r = await p.attack(e.id, { timeoutMs: 10_000 });
    return `fought ${e.short}#${e.id}: ${r.killed ? "killed" : "stopped"} after ${r.hits} hits`;
  },
};

export const cowardice: Reflex<Entity[]> = {
  name: "cowardice",
  description: "Run from hostile mobs before they get close.",
  priority: 75,
  interrupts: true,
  cooldownMs: 4000,
  check: async (ctx) => { const t = await ctx_threats(ctx, 8); return t.length ? t : null; },
  async act(p, threats) {
    const r = await p.flee(threats.map((t) => t.pos), 16, { timeoutMs: 12_000 });
    return `ran from ${threats.map((t) => t.short).join(", ")} to ${r.pos.x.toFixed(0)},${r.pos.z.toFixed(0)}`;
  },
};

export const autoEat: Reflex<number> = {
  name: "auto_eat",
  description: "Eat when hungry and not in a fight.",
  priority: 70,
  cooldownMs: 10_000,
  check: async (ctx) => {
    const m = ctx.mirror;
    if (!(m.food <= 14 && m.damageInLast(3000) === 0 && !m.screen)) return null;
    const { bestFood } = await import("../primitives/inventory.ts");
    return (await bestFood(ctx)) ? m.food : null;   // hungry with nothing to eat is the mind's problem, not a reflex
  },
  async act(p, food) {
    const r = await p.eat();
    return r.ate ? `ate ${r.ate} (food ${food} -> ${r.food})` : "not hungry after all";
  },
};

export const unstuck: Reflex<number> = {
  name: "unstuck",
  description: "Nudge the bot when it has been pathing without moving for a while.",
  priority: 60,
  cooldownMs: 6000,
  check: (ctx) => {
    const m = ctx.mirror;
    const stuckMs = Date.now() - m.lastMoveAt;
    return m.navActive && stuckMs > 15_000 ? stuckMs : null;
  },
  async act(p, stuckMs) {
    await p.jump();
    await p.move("backward", 400, { jump: true });
    return `stuck for ${(stuckMs / 1000).toFixed(0)}s: nudged`;
  },
};

const chased = new Map<number, { n: number; at: number }>();
export const itemCollecting: Reflex<Entity> = {
  name: "item_collecting",
  description: "Pick up nearby dropped items when idle.",
  priority: 30,
  idleOnly: true,
  cooldownMs: 2500,
  check: async (ctx) => {
    if (ctx.mirror.navActive) return null;
    const now = Date.now();
    for (const [id, c] of chased) if (now - c.at > 120_000) chased.delete(id);
    const items = (await ctx_entities(ctx, 8)).filter((e) => e.isItem && (chased.get(e.id)?.n ?? 0) < 2);
    return items[0] ?? null;
  },
  async act(p, it) {
    const c = chased.get(it.id) ?? { n: 0, at: Date.now() };
    chased.set(it.id, { n: c.n + 1, at: Date.now() });
    await p.collectDrops(4, 8000).catch(() => {});
    return undefined;   // the pickup itself is visible in the inventory; no need to narrate it
  },
};

export const idleStaring: Reflex<Entity> = {
  name: "idle_staring",
  description: "Look at whoever is nearby when idle. Purely cosmetic.",
  priority: 10,
  idleOnly: true,
  cooldownMs: 3000,
  check: async (ctx) => {
    if (ctx.mirror.navActive) return null;
    const near = (await ctx_entities(ctx, 8)).filter((e) => !e.isItem);
    return near.find((e) => e.isPlayer) ?? near[0] ?? null;
  },
  async act(p, e) {
    await p.lookAt({ entityId: e.id });
  },
};

export const BUILTIN_REFLEXES: Reflex<any>[] = [
  autoRespawn, bunker, selfPreservation, selfDefense, cowardice, autoEat, unstuck, itemCollecting, idleStaring,
];

// Small local helpers so check() functions stay one-liners. They call the body, so the engine's
// 250 ms cadence means at most ~4 entity queries per second across all reflexes (results are
// shared through a 300 ms cache).
let entCache: { at: number; radius: number; list: Entity[] } | null = null;
async function ctx_entities(ctx: Ctx, radius: number): Promise<Entity[]> {
  const now = Date.now();
  if (entCache && now - entCache.at < 300 && entCache.radius >= radius) {
    const me = ctx.mirror.pos;
    return entCache.list.filter((e) => dist(e.pos, me) <= radius);
  }
  const { entities } = await import("../primitives/perception.ts");
  const list = await entities(ctx, { radius: Math.max(radius, 12) });
  entCache = { at: now, radius: Math.max(radius, 12), list };
  return list.filter((e) => e.distance <= radius);
}
async function ctx_threats(ctx: Ctx, radius: number): Promise<Entity[]> {
  return (await ctx_entities(ctx, radius)).filter((e) => e.hostile);
}
