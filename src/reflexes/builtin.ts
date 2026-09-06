// Built-in reflexes. Each is small, defensive, and honest about what the body can't yet tell us.
import type { Ctx } from "../primitives/context.ts";
import { sleep } from "../primitives/errors.ts";
import type { Entity } from "../primitives/perception.ts";
import type { Reflex } from "./engine.ts";
import { dist, fmtPos } from "../util/geom.ts";
import { GolemError } from "../primitives/errors.ts";

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

interface Danger { kind: "hurt" | "burning" | "lava" | "drowning"; hp: number }

export const selfPreservation: Reflex<Danger> = {
  name: "self_preservation",
  description: "Get away from whatever is hurting you when health is low; escape lava, fire and water when the body reports them.",
  priority: 90,
  interrupts: true,
  cooldownMs: 4000,
  check: (ctx) => {
    const m = ctx.mirror;
    const s = m.status?.player;
    if (s?.inLava) return { kind: "lava", hp: m.health };
    if (s?.onFire && m.health <= 12) return { kind: "burning", hp: m.health };
    if (s?.air !== undefined && s.air <= 60) return { kind: "drowning", hp: m.health };
    if (m.health <= 7 && m.damageInLast(3000) > 0) return { kind: "hurt", hp: m.health };
    return null;
  },
  async act(p, d) {
    const ctx = p.ctx;
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
    return `hp ${d.hp.toFixed(0)}: took damage with no visible threat (fall/environment?)`;
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
