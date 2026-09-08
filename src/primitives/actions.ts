// World-changing primitives. Every one of these resolves only when the effect is observable, or
// throws a typed GolemError.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CombatResult, ContainerResult, CraftResult, CraftableEntry, MineResult, PlaceResult, RecipeResult, ScreenshotResult } from "../body/results.ts";
import { FACES, FACE_VEC, OPPOSITE, add, center, dist, faceToward, fmtPos, offset, samePos, scale, type Face, type Pos, type Vec } from "../util/geom.ts";
import { fullId, shortId, type Ctx } from "./context.ts";
import { GolemError, fromClef, sleep, until } from "./errors.ts";
import { bestFood, bestTool, inventory, selectItem } from "./inventory.ts";
import { lookAt } from "./look.ts";
import { goto, move, jump, navStop } from "./nav.ts";
import { REPLACEABLE, blockAt, entityById, entities, findBlocks, type Entity } from "./perception.ts";
import { recordChest } from "../world/chests.ts";

const REACH = 4.5;

/** Clef's container slots render items as "minecraft:coal x7"; strip the count to compare ids. */
export function slotItemId(item: string): string { return item.replace(/\s+x\d+$/, ""); }

async function approach(ctx: Ctx, p: Pos, reach = 3, timeoutMs = 30_000): Promise<void> {
  if (dist(ctx.mirror.eye, center(p)) <= REACH) return;
  await goto(ctx, p, { reach, timeoutMs });
  if (dist(ctx.mirror.eye, center(p)) > REACH + 1) {
    throw new GolemError("unreachable", `${fmtPos(p)} is still ${dist(ctx.mirror.eye, center(p)).toFixed(1)} blocks away after pathing`);
  }
}

export interface DigDownOpts { maxDrop?: number; timeoutMs?: number }
export interface DigDownResult { dug: number; stopped: string; pos: Pos }

/**
 * Sink straight down `n` blocks, one swing per block, letting gravity do the moving.
 *
 * This is the fast way to depth: a staircase costs three mines and a path-find per block of descent,
 * where this costs one mine. It is also the classic way to die, so it looks before every swing and
 * stops (rather than throwing) when going further would be stupid: lava or water in the next two
 * blocks, or an open drop longer than `maxDrop`. The caller gets back how far it got and why it
 * stopped, so a script can scan and decide whether to keep going.
 */
export async function digDown(ctx: Ctx, n: number, opts: DigDownOpts = {}): Promise<DigDownResult> {
  const maxDrop = opts.maxDrop ?? 3;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const t0 = Date.now();
  return ctx.activity.run(`dig down ${n}`, async () => {
    const startY = ctx.mirror.blockPos.y;
    let dug = 0;
    const done = (stopped: string): DigDownResult => ({ dug, stopped, pos: ctx.mirror.blockPos });
    while (startY - ctx.mirror.blockPos.y < n) {
      ctx.token.throwIfCancelled();
      if (Date.now() - t0 > timeoutMs) return done("timeout");
      const from = ctx.mirror.blockPos;
      const [below, below2] = await Promise.all([
        blockAt(ctx, { x: from.x, y: from.y - 1, z: from.z }),
        blockAt(ctx, { x: from.x, y: from.y - 2, z: from.z }),
      ]);
      if (below.liquid) return done(`${below.short} directly below`);
      if (below2.liquid) return done(`${below2.short} two blocks below`);
      if (below.air) {
        // Already standing over a hole: measure it before dropping in.
        let depth = 1;
        while (depth <= maxDrop) {
          const b = await blockAt(ctx, { x: from.x, y: from.y - 1 - depth, z: from.z });
          if (!b.air) break;
          if (b.liquid) return done(`${b.short} ${depth + 1} blocks below`);
          depth++;
        }
        if (depth > maxDrop) return done(`a drop of more than ${maxDrop} blocks below`);
      } else {
        try { await mine(ctx, { x: from.x, y: from.y - 1, z: from.z }, { collect: false }); }
        catch (e) { return done(`could not break ${below.short}: ${(e as Error).message}`); }
        dug++;
      }
      // Wait for the fall into the space we just opened; if we are still up here, we are stuck on
      // something the mirror has not caught up with, so give up rather than swing at air forever.
      const fell = await until(() => ctx.mirror.blockPos.y < from.y, { timeoutMs: 4000, intervalMs: 80, what: "falling", token: ctx.token }).catch(() => false);
      if (!fell) return done(`stuck at ${fmtPos(from)}`);
    }
    return done("done");
  });
}

export interface MineOpts { timeoutMs?: number; tool?: "auto" | "none"; approach?: boolean; /** walk over the drop afterwards (default true) */ collect?: boolean }

/** Break one block. Resolves when it is air (and, by default, after walking over its drop). Picks the best tool from the inventory. */
export async function mine(ctx: Ctx, p: Pos, opts: MineOpts = {}): Promise<{ broken: boolean; block: string; ms: number }> {
  const t0 = Date.now();
  const r = await mineOnly(ctx, p, opts);
  if (r.broken && (opts.collect ?? true)) {
    await collectDrops(ctx, 4, 6000).catch(() => {});
    // The pickup packet trails the walk-over by a few ticks; give the inventory a moment to reflect it.
    await sleep(400, ctx.token);
    ctx.mirror.inventoryDirty = true;
  }
  return { ...r, ms: Date.now() - t0 };
}

async function mineOnly(ctx: Ctx, p: Pos, opts: MineOpts): Promise<{ broken: boolean; block: string; ms: number }> {
  const t0 = Date.now();
  return ctx.activity.run(`mine ${fmtPos(p)}`, async () => {
    const b = await blockAt(ctx, p);
    if (b.air) return { broken: false, block: b.short, ms: 0 };
    if (b.short === "bedrock" || b.short === "barrier") throw new GolemError("cant_break", `${b.short} cannot be broken`);
    if (opts.approach ?? true) await approach(ctx, p);
    if ((opts.tool ?? "auto") === "auto") {
      const tool = await bestTool(ctx, b.id);
      if (tool) await selectItem(ctx, tool);
    }
    await lookAt(ctx, p);
    const face = faceToward(p, ctx.mirror.eye);
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (ctx.body.caps.hasArg("mine", "wait")) {
      // Protocol 2: the body blocks until the block breaks (or gives up) and says why.
      let r: MineResult;
      try { r = (await ctx.body.call("mine", { x: p.x, y: p.y, z: p.z, face, wait: true }, { timeoutMs: timeoutMs + 5000 })) as MineResult; }
      catch (e) { throw fromClef(e, `mine ${fmtPos(p)}`); }
      if (r.broken === false) throw new GolemError("cant_break", `${b.short} at ${fmtPos(p)}: ${r.reason ?? "did not break"}${r.detail ? ` (${r.detail})` : ""}`);
      if (r.broken === true || (await blockAt(ctx, p)).air) return { broken: true, block: b.short, ms: Date.now() - t0 };
    } else {
      try { await ctx.body.call("mine", { x: p.x, y: p.y, z: p.z, face }); }
      catch (e) { throw fromClef(e, `mine ${fmtPos(p)}`); }
    }
    try {
      await until(async () => (await blockAt(ctx, p)).air, { timeoutMs, intervalMs: 250, what: `mining ${b.short} at ${fmtPos(p)}`, token: ctx.token });
    } catch (e) {
      await ctx.body.call("stopMine").catch(() => {});
      if (GolemError.is(e, "timeout")) throw new GolemError("cant_break", `${b.short} at ${fmtPos(p)} did not break (wrong tool, out of reach, or too hard)`, { cause: e });
      throw e;
    }
    return { broken: true, block: b.short, ms: Date.now() - t0 };
  });
}

export interface PlaceOpts { timeoutMs?: number; approach?: boolean }

/**
 * Place `item` so that it occupies block `p`. Finds a solid neighbour to click against, gets the
 * item in hand, looks at the face, clicks, and verifies the block state changed.
 */
export async function place(ctx: Ctx, item: string, p: Pos, opts: PlaceOpts = {}): Promise<{ placed: boolean; ms: number }> {
  const t0 = Date.now();
  return ctx.activity.run(`place ${shortId(item)} ${fmtPos(p)}`, async () => {
    const target = await blockAt(ctx, p);
    if (!REPLACEABLE.has(target.id)) throw new GolemError("blocked", `${target.short} already at ${fmtPos(p)}`);
    if (opts.approach ?? true) await approach(ctx, p);
    // Standing in the target? Step back so the block has room.
    const feet = ctx.mirror.blockPos;
    if (samePos(feet, p) || samePos({ ...feet, y: feet.y + 1 }, p)) {
      await move(ctx, "backward", 350);
      if (samePos(ctx.mirror.blockPos, feet)) await jump(ctx);
    }
    await selectItem(ctx, item);
    // Prefer clicking the block below (face up), then sides, then the block above.
    const order: Face[] = ["down", "north", "south", "east", "west", "up"];
    let anchor: { n: Pos; face: Face } | undefined;
    for (const d of order) {
      const n = offset(p, d);
      const nb = await blockAt(ctx, n);
      if (nb.solid) { anchor = { n, face: OPPOSITE[d] }; break; }
    }
    if (!anchor) throw new GolemError("cant_place", `no solid block next to ${fmtPos(p)} to place against`);
    const hit: Vec = add(center(anchor.n), scale(FACE_VEC[anchor.face], 0.5));
    await lookAt(ctx, hit);
    const args: Record<string, unknown> = { x: anchor.n.x, y: anchor.n.y, z: anchor.n.z, face: anchor.face };
    if (ctx.body.caps.hasArg("place", "item")) { args.item = fullId(item); args.confirm = true; }   // protocol 2: atomic select + place + verify
    try {
      const r = (await ctx.body.call("place", args)) as PlaceResult;
      if (r && r.placed === false) throw new GolemError("cant_place", `${shortId(item)} was not placed at ${fmtPos(p)}`);
    }
    catch (e) { throw e instanceof GolemError ? e : fromClef(e, `place ${shortId(item)}`); }
    try {
      await until(async () => !(await blockAt(ctx, p)).air, { timeoutMs: opts.timeoutMs ?? 1500, intervalMs: 150, what: `placing ${shortId(item)}`, token: ctx.token });
    } catch (e) {
      if (GolemError.is(e, "timeout")) throw new GolemError("cant_place", `${shortId(item)} did not appear at ${fmtPos(p)} (blocked by an entity, out of reach, or the server refused)`, { cause: e });
      throw e;
    }
    return { placed: true, ms: Date.now() - t0 };
  });
}

/** Right-click a block face (open a door, use a lever, open a chest) without placing anything specific. */
/**
 * Refuse to use an item while a screen is covering the game, and say which screen it is.
 *
 * An open screen swallows item use entirely and reports nothing: `use`, `useHold`, `useRelease` and
 * `shootAt` all return OK and the item is never used. Movement, mining and pathing keep working, so
 * a body in this state looks healthy from every angle except the one that matters. Two dragon runs
 * were lost to a PauseScreen nobody could see.
 *
 * Container screens are the routine case and `closeScreen` genuinely closes those, so try that
 * first. Anything still up afterwards is a screen the body cannot dismiss - that is a real fault,
 * and it gets raised rather than swallowed.
 */
async function assertHandsFree(ctx: Ctx, what: string): Promise<void> {
  if (!ctx.mirror.screen) return;
  const was = ctx.mirror.screen;
  await ctx.body.call("closeScreen").catch(() => {});
  await until(() => !ctx.mirror.screen, { timeoutMs: 1200, intervalMs: 100, what: "closing screen", token: ctx.token })
    .catch(() => {
      throw new GolemError("blocked", `cannot ${what}: the screen "${was}" is open and will not close, which silently blocks all item use`);
    });
}

export async function useOnBlock(ctx: Ctx, p: Pos, face: Face = "up"): Promise<void> {
  await assertHandsFree(ctx, `use on ${fmtPos(p)}`);
  await approach(ctx, p);
  await lookAt(ctx, p);
  try { await ctx.body.call("place", { x: p.x, y: p.y, z: p.z, face }); }
  catch (e) { throw fromClef(e, `use on ${fmtPos(p)}`); }
}

export async function useItem(ctx: Ctx, hand: "main" | "off" = "main"): Promise<void> {
  await assertHandsFree(ctx, "use the held item");
  try { await ctx.body.call("use", { hand }); } catch (e) { throw fromClef(e, "use"); }
}

/** Hold right-click for `ticks` (20 = one second) and let go: bows, tridents, charging anything. */
export async function useHold(ctx: Ctx, ticks = 25): Promise<void> {
  await assertHandsFree(ctx, "hold the use key");
  try { await ctx.body.call("useHold", { ticks }); } catch (e) { throw fromClef(e, "useHold"); }
  await sleep(ticks * 50 + 60, ctx.token);
}
export async function useRelease(ctx: Ctx): Promise<void> {
  try { await ctx.body.call("useRelease"); } catch (e) { throw fromClef(e, "useRelease"); }
}

export interface ShootOpts { chargeTicks?: number; shots?: number; intervalMs?: number }
/**
 * Draw the bow at a target (an entity id or a position) and loose. Needs a bow and arrows in the
 * inventory. Aims at the entity's current position (no lead), which is fine for end crystals,
 * perched dragons and anything walking toward you; strafing mobs want several shots.
 */
export async function shoot(ctx: Ctx, target: number | Pos, opts: ShootOpts = {}): Promise<{ shots: number }> {
  const inv = await inventory(ctx);
  if (!inv.has("bow")) throw new GolemError("missing_item", "no bow in inventory");
  if (!inv.items.some((i) => /arrow$/.test(i.item))) throw new GolemError("missing_item", "no arrows in inventory");
  await selectItem(ctx, "bow");
  const shots = opts.shots ?? 1;
  return ctx.activity.run(`shoot ${typeof target === "number" ? `#${target}` : fmtPos(target)}`, async () => {
    let fired = 0;
    for (let i = 0; i < shots; i++) {
      ctx.token.throwIfCancelled();
      if (typeof target === "number") {
        const e = await entityById(ctx, target);
        if (!e) break;
        await lookAt(ctx, { entityId: target });
      } else await lookAt(ctx, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 });
      await useHold(ctx, opts.chargeTicks ?? 25);
      await useRelease(ctx);
      fired++;
      if (i < shots - 1) await sleep(opts.intervalMs ?? 400, ctx.token);
    }
    return { shots: fired };
  });
}

export async function interactEntity(ctx: Ctx, id: number, hand: "main" | "off" = "main"): Promise<void> {
  const e = await entityById(ctx, id);
  if (!e) throw new GolemError("not_found", `entity ${id} not nearby`);
  if (e.distance > REACH) await goto(ctx, { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) }, { reach: 2, timeoutMs: 30_000 });
  await lookAt(ctx, { entityId: id });
  try { await ctx.body.call("interactEntity", { entityId: id, hand }); } catch (err) { throw fromClef(err, `interact ${id}`); }
}

export interface AimSolution { yaw: number; pitch: number; ticks: number }

/**
 * Where to point a fully-drawn bow to hit a stationary point, by simulating the arrow.
 *
 * A Minecraft arrow is not a parabola. It leaves the bow at 3.0 blocks/tick at full charge and then,
 * every tick, is scaled by 0.99 for drag BEFORE 0.05 is taken off its vertical speed for gravity. The
 * drag is what breaks the textbook answer: `0.5*g*t^2` assumes constant horizontal speed, so it
 * under-reads the flight time, and the error grows with range. Fitting a constant to it works at
 * exactly the distance you measured and nowhere else - a factor of 2 calibrated at 35 blocks still
 * missed a crystal at 41.
 *
 * So simulate instead, and binary-search the launch angle. `null` means the shot is out of range at
 * any angle - worth knowing rather than firing anyway.
 */
/** Launch physics for a thrown thing: blocks per tick, gravity per tick, per-tick drag. */
export interface Ballistics { speed: number; gravity: number; drag: number }
/** A fully drawn bow. */
export const ARROW: Ballistics = { speed: 3.0, gravity: 0.05, drag: 0.99 };
/** An ender pearl: slower and floatier than an arrow, so it needs a much higher angle for the range. */
export const PEARL: Ballistics = { speed: 1.5, gravity: 0.03, drag: 0.99 };

export function solveAim(from: Vec, to: Vec, b: Ballistics = ARROW): AimSolution | null {
  const dx = to.x - from.x, dz = to.z - from.z;
  const dy = to.y - from.y;
  const flat = Math.hypot(dx, dz);
  const yaw = -Math.atan2(dx, dz) * 180 / Math.PI;
  if (flat < 0.01) return { yaw, pitch: dy > 0 ? -90 : 90, ticks: 0 };

  // Height the arrow has when it crosses `flat`, launched at `elev` degrees above horizontal.
  const heightAt = (elev: number): { y: number; ticks: number } => {
    const r = elev * Math.PI / 180;
    let vx = Math.cos(r) * b.speed, vy = Math.sin(r) * b.speed;
    let x = 0, y = 0;
    for (let t = 1; t <= 400; t++) {
      const px = x, py = y;
      x += vx; y += vy;
      vx *= b.drag; vy *= b.drag; vy -= b.gravity;
      if (x >= flat) {
        // Interpolate within the tick it crosses the target's distance.
        const f = (flat - px) / (x - px);
        return { y: py + (y - py) * f, ticks: t };
      }
      if (y < -256) break;
    }
    return { y: -Infinity, ticks: 400 };
  };

  // Scan rather than bisect. Height at the target's range does NOT rise monotonically with launch
  // angle: it climbs to a peak and then collapses, because past a certain angle the arrow simply
  // never travels far enough horizontally and there is no height to report at all. A bisection
  // assumes monotonicity and quietly rejects reachable shots - it called the exact angle I had
  // watched destroy a crystal "out of range".
  let best: AimSolution | null = null;
  let bestErr = Infinity;
  for (let elev = -89; elev <= 89; elev += 0.5) {
    const h = heightAt(elev);
    if (!Number.isFinite(h.y)) continue;
    const err = Math.abs(h.y - dy);
    if (err < bestErr) { bestErr = err; best = { yaw, pitch: -elev, ticks: h.ticks }; }
  }
  if (!best || bestErr > 1.0) return null;
  // Refine around the winner, since half a degree is about a block of miss at forty.
  const coarse = -best.pitch;
  for (let elev = coarse - 0.5; elev <= coarse + 0.5; elev += 0.02) {
    const h = heightAt(elev);
    if (!Number.isFinite(h.y)) continue;
    const err = Math.abs(h.y - dy);
    if (err < bestErr) { bestErr = err; best = { yaw, pitch: -elev, ticks: h.ticks }; }
  }
  return best;
}

/**
 * Point-and-shoot at something that does not move, aiming by simulation rather than a fudge factor.
 *
 * Aims at `pos.y + 1`, not `pos.y`, because an entity's position is its FEET. On an end crystal that
 * is the block it stands on, level with the top of the pillar, so aiming there sends the arrow into
 * the pillar's lip a foot below the target - measured, arrows grouped at y 93.5 against a crystal
 * whose base is y 95. One block up is the middle of the hitbox and it clears.
 */
export async function shootStatic(ctx: Ctx, target: Pos, shots = 1): Promise<{ fired: number; pitch: number | null }> {
  const inv = await inventory(ctx);
  if (!inv.has("bow")) throw new GolemError("missing_item", "no bow in inventory");
  if (!inv.items.some((i) => /arrow$/.test(i.item))) throw new GolemError("missing_item", "no arrows in inventory");
  await selectItem(ctx, "bow");
  let fired = 0;
  let pitch: number | null = null;
  for (let i = 0; i < shots; i++) {
    ctx.token.throwIfCancelled();
    const aim = solveAim(ctx.mirror.eye, { x: target.x, y: target.y + 1, z: target.z });
    if (!aim) throw new GolemError("unreachable", `${fmtPos(target)} is out of bow range at any angle`);
    pitch = aim.pitch;
    await ctx.body.call("look", { yaw: aim.yaw, pitch: aim.pitch });
    await useHold(ctx, 25);
    // Re-aim after the draw: the arrow leaves along wherever the head is on the release tick.
    await ctx.body.call("look", { yaw: aim.yaw, pitch: aim.pitch });
    await sleep(150, ctx.token);
    await useRelease(ctx);
    fired++;
    if (i < shots - 1) await sleep(600, ctx.token);
  }
  return { fired, pitch };
}

/**
 * Throw an ender pearl at a position and land on it.
 *
 * Aiming a pearl by hand is guesswork: it leaves at half an arrow's speed with two-thirds the
 * gravity, so it needs a noticeably different angle for the same distance and no rule of thumb
 * carries over. This solves it the same way the bow does, by simulating the throw.
 *
 * Costs 5 damage on landing. That is usually the cheap option - walking out of a dragon breath pool
 * takes several seconds and every one of them is spent inside it - but it is not free, so check your
 * health first. It is also the fastest way off the arrival platform or across a gap you have not
 * bridged.
 */
export async function pearlTo(ctx: Ctx, target: Pos): Promise<{ pitch: number; yaw: number; ticks: number }> {
  const inv = await inventory(ctx);
  if (!inv.has("ender_pearl")) throw new GolemError("missing_item", "no ender pearls");
  const to = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 };
  const aim = solveAim(ctx.mirror.eye, to, PEARL);
  if (!aim) throw new GolemError("unreachable", `${fmtPos(target)} is out of pearl range at any angle`);
  await selectItem(ctx, "ender_pearl");
  await ctx.body.call("look", { yaw: aim.yaw, pitch: aim.pitch });
  await sleep(120, ctx.token);
  await useItem(ctx);
  return aim;
}

export interface ShootAtOpts { lead?: boolean; charge?: number; shots?: number; maxRange?: number }
export interface MeleeWhileOpts { maxMs?: number; reach?: number; stopBelowHealth?: number }

/** The body owns these loops; without them the caller must fall back to aiming over the wire. */
function needsCombatLoop(ctx: Ctx, cmd: string): void {
  if (!ctx.body.caps.has(cmd)) {
    throw new GolemError("unsupported", `the body has no ${cmd}; it needs a Clef build with the combat loops (CLEF-CHANGES #19)`);
  }
}

/**
 * Shoot at an entity with the bow, with the aiming loop running on the body at 20 Hz.
 *
 * This is the whole reason #19 exists. Aiming from here costs four round-trips — sample, draw,
 * re-sample, aim, loose — about 1.5 s, against a target that has moved twenty blocks by then. The
 * body can track the entity every tick, solve lead from its real velocity and drop from the arrow's
 * actual ballistics, and set rotation on the release tick.
 */
export async function shootAt(ctx: Ctx, target: number | Entity, opts: ShootAtOpts = {}): Promise<CombatResult> {
  needsCombatLoop(ctx, "shootAt");
  await assertHandsFree(ctx, "shoot");
  const entityId = typeof target === "number" ? target : target.id;
  const args: Record<string, unknown> = { entityId, wait: true };
  if (opts.lead !== undefined) args.lead = opts.lead;
  if (opts.charge !== undefined) args.charge = opts.charge;
  if (opts.shots !== undefined) args.shots = opts.shots;
  if (opts.maxRange !== undefined) args.maxRange = opts.maxRange;
  return ctx.activity.run(`shoot #${entityId}`, async () => {
    try { return (await ctx.body.call("shootAt", args, { timeoutMs: 120_000 })) as CombatResult; }
    catch (e) { throw fromClef(e, `shootAt #${entityId}`); }
  });
}

/** Swing at an entity while it stays in reach, on the body's attack-cooldown cadence. */
export async function meleeWhile(ctx: Ctx, target: number | Entity, opts: MeleeWhileOpts = {}): Promise<CombatResult> {
  needsCombatLoop(ctx, "meleeWhile");
  const entityId = typeof target === "number" ? target : target.id;
  const args: Record<string, unknown> = { entityId, wait: true };
  if (opts.maxMs !== undefined) args.maxMs = opts.maxMs;
  if (opts.reach !== undefined) args.reach = opts.reach;
  if (opts.stopBelowHealth !== undefined) args.stopBelowHealth = opts.stopBelowHealth;
  return ctx.activity.run(`melee #${entityId}`, async () => {
    try { return (await ctx.body.call("meleeWhile", args, { timeoutMs: 120_000 })) as CombatResult; }
    catch (e) { throw fromClef(e, `meleeWhile #${entityId}`); }
  });
}

/** Cut a running combat loop short (a reflex taking the body back). */
export async function combatStop(ctx: Ctx): Promise<{ stopped: boolean; kind?: string }> {
  if (!ctx.body.caps.has("combat.stop")) return { stopped: false };
  try { return (await ctx.body.call("combat.stop")) as { stopped: boolean; kind?: string }; }
  catch (e) { throw fromClef(e, "combat.stop"); }
}

export interface AttackOpts { timeoutMs?: number; weapon?: "auto" | "none" }

/** Chase and hit an entity until it is gone (dead or despawned) or the timeout passes. */
export async function attack(ctx: Ctx, target: number | Entity, opts: AttackOpts = {}): Promise<{ killed: boolean; hits: number; ms: number }> {
  const id = typeof target === "number" ? target : target.id;
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return ctx.activity.run(`attack #${id}`, async () => {
    if ((opts.weapon ?? "auto") === "auto") {
      const inv = await inventory(ctx);
      const weapon = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "golden_sword", "wooden_sword", "netherite_axe", "diamond_axe", "iron_axe", "stone_axe"]
        .find((w) => inv.has(w));
      if (weapon) await selectItem(ctx, weapon);
    }
    let hits = 0;
    for (;;) {
      ctx.token.throwIfCancelled();
      const e = await entityById(ctx, id);
      if (!e) return { killed: hits > 0, hits, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) throw new GolemError("timeout", `attack #${id} (${e.short}) timed out after ${hits} hits`);
      if (e.distance > 3) {
        await goto(ctx, { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) }, { reach: 2, timeoutMs: 8000, retry: false }).catch(() => {});
        continue;
      }
      await lookAt(ctx, { entityId: id });
      try { await ctx.body.call("attack", { entityId: id }); hits++; }
      catch (err) { if ((err as { code?: string }).code === "NOT_FOUND") return { killed: hits > 0, hits, ms: Date.now() - t0 }; throw fromClef(err, "attack"); }
      await sleep(620, ctx.token);
    }
  });
}

const WEARABLE = /_(helmet|chestplate|leggings|boots)$|^minecraft:(elytra|shield|carved_pumpkin|turtle_helmet)$/;

/**
 * Hold an item. Armour goes through the body's equip (it lands in the armour slots); anything else
 * goes through selectItem, which puts it in the hotbar AND selects that slot, then we wait for the
 * server to confirm what's in hand. The body's own equip only guarantees "in the hotbar", which had
 * a mind re-equipping a hoe eleven times while the state header kept saying "held empty".
 */
export async function equip(ctx: Ctx, item: string): Promise<{ slot: number | null; held: string }> {
  const id = fullId(item);
  if (WEARABLE.test(id)) {
    // Already wearing it? Then stop. The body's equip is a shift-click from the player inventory, and
    // the armour slots are part of that inventory, so shift-clicking a worn piece takes it OFF. A mind
    // that defensively re-equips its armour each turn would strip itself, then fight a dragon in a shirt.
    const worn = ctx.mirror.status?.player?.armor ?? [];
    if (worn.some((w) => w && w !== "empty" && fullId(w) === id)) return { slot: null, held: ctx.mirror.heldItem };
    try { await ctx.body.call("equip", { item: id }); } catch (e) { throw fromClef(e, `equip ${item}`); }
    return { slot: null, held: ctx.mirror.heldItem };
  }
  const slot = await selectItem(ctx, id);
  await until(() => ctx.mirror.heldItem.replace(/\s+x\d+$/, "") === id, { timeoutMs: 1500, intervalMs: 100, what: `holding ${item}`, token: ctx.token })
    .catch(() => { /* the status poll may lag a second; the slot is selected either way */ });
  return { slot, held: ctx.mirror.heldItem };
}

/** Eat a named item, or the best food available. Resolves when hunger went up. */
export async function eat(ctx: Ctx, item?: string): Promise<{ ate: string | null; food: number }> {
  return ctx.activity.run("eat", async () => {
    if (ctx.mirror.food >= 20) return { ate: null, food: ctx.mirror.food };
    const choice = item ?? (await bestFood(ctx));
    if (!choice) throw new GolemError("missing_item", "no food in inventory");
    await selectItem(ctx, choice);
    // Movement interrupts item use, so pause Baritone while chewing and resume after.
    const wasPathing = ctx.mirror.navActive;
    if (wasPathing) await ctx.body.call("baritone", { command: "pause" }).catch(() => {});
    await ctx.body.call("stopMove").catch(() => {});
    await ctx.mirror.refresh().catch(() => {});
    const before = ctx.mirror.food;
    try {
      try { await ctx.body.call("eat", { ticks: 40 }); } catch (e) { throw fromClef(e, "eat"); }
      await until(async () => { if (ctx.mirror.food > before) return true; await ctx.mirror.refresh().catch(() => {}); return ctx.mirror.food > before; },
        { timeoutMs: 6000, intervalMs: 400, what: `eating ${choice}`, token: ctx.token })
        .catch(() => { throw new GolemError("failed", `ate ${choice} but hunger did not change (was it interrupted by movement or combat?)`); });
    } finally {
      if (wasPathing) await ctx.body.call("baritone", { command: "resume" }).catch(() => {});
    }
    return { ate: choice, food: ctx.mirror.food };
  });
}

/** Drop `n` of an item (all matching stacks when n is omitted). */
export async function drop(ctx: Ctx, item: string, n?: number): Promise<{ dropped: number }> {
  const id = fullId(item);
  if (n === undefined) {
    try { const r = (await ctx.body.call("dropStack", { item: id })) as { dropped: number }; return { dropped: r.dropped }; }
    catch (e) { throw fromClef(e, `drop ${item}`); }
  }
  await selectItem(ctx, id);
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    ctx.token.throwIfCancelled();
    try { const r = (await ctx.body.call("dropItem", { all: false })) as { dropped: boolean }; if (!r.dropped) break; dropped++; }
    catch (e) { throw fromClef(e, `drop ${item}`); }
    await sleep(60, ctx.token);
  }
  return { dropped };
}

export async function respawn(ctx: Ctx): Promise<void> {
  try { await ctx.body.call("respawn"); } catch (e) { throw fromClef(e, "respawn"); }
  await until(() => !ctx.mirror.dead && ctx.mirror.health > 0, { timeoutMs: 10_000, intervalMs: 250, what: "respawn", token: ctx.token }).catch(() => {});
}

const NO_STORAGE = new Set(["crafting_table", "enchanting_table", "anvil", "chipped_anvil", "damaged_anvil", "grindstone", "stonecutter", "loom", "cartography_table", "smithing_table", "lectern", "beacon"]);

/** Open a container block and return its contents. */
export async function openContainer(ctx: Ctx, p: Pos): Promise<ContainerResult> {
  return ctx.activity.run(`open ${fmtPos(p)}`, async () => {
    if (ctx.mirror.screen) await closeScreen(ctx);
    await useOnBlock(ctx, p);
    await until(() => !!ctx.mirror.screen, { timeoutMs: 2000, intervalMs: 100, what: `opening ${fmtPos(p)}`, token: ctx.token })
      .catch(() => { throw new GolemError("failed", `nothing opened at ${fmtPos(p)}`); });
    await sleep(150, ctx.token); // let the server send the slots
    let c: ContainerResult;
    try { c = (await ctx.body.call("container")) as ContainerResult; }
    catch (e) { throw fromClef(e, "container"); }
    const kind = await blockAt(ctx, p).then((b) => b.short).catch(() => undefined);
    lastOpened = { pos: p, handler: c.handler, kind };
    // Work stations open a screen too, but they hold nothing worth indexing.
    if (!kind || !NO_STORAGE.has(kind)) { try { recordChest(ctx.agent, p, ctx.mirror.dimension, c.handler, c.slots, { kind }); } catch { /* index is best-effort */ } }
    return c;
  });
}

/** The container most recently opened via openContainer, for re-indexing after transfers. */
let lastOpened: { pos: Pos; handler: string; kind?: string } | null = null;
async function reindexOpen(ctx: Ctx): Promise<void> {
  if (!lastOpened || !ctx.mirror.screen) return;
  try {
    if (lastOpened.kind && NO_STORAGE.has(lastOpened.kind)) return;
    const c = (await ctx.body.call("container")) as ContainerResult;
    recordChest(ctx.agent, lastOpened.pos, ctx.mirror.dimension, c.handler, c.slots, { kind: lastOpened.kind });
  } catch { /* best-effort */ }
}

export async function container(ctx: Ctx): Promise<ContainerResult> {
  try { return (await ctx.body.call("container")) as ContainerResult; }
  catch (e) { throw fromClef(e, "container"); }
}

export async function closeScreen(ctx: Ctx): Promise<void> {
  await ctx.body.call("closeScreen").catch(() => {});
  await until(() => !ctx.mirror.screen, { timeoutMs: 1500, intervalMs: 100, what: "close screen", token: ctx.token }).catch(() => { ctx.mirror.screen = null; });
}

/** Shift-click all matching items INTO the open container (loops in case the body moves one stack per call). */
export async function deposit(ctx: Ctx, item: string): Promise<{ moved: number }> {
  if (!ctx.mirror.screen) throw new GolemError("blocked", "no container open");
  let moved = 0;
  try {
    for (let i = 0; i < 12; i++) {
      const r = (await ctx.body.call("deposit", { item: fullId(item) })) as { deposited: number };
      if (!r.deposited) break;
      moved += r.deposited;
      await sleep(120, ctx.token);
    }
    await reindexOpen(ctx);
    return { moved };
  } catch (e) { throw fromClef(e, `deposit ${item}`); }
}
/** Shift-click all matching items OUT of the open container (the body moves one stack per call; this loops). */
export async function withdraw(ctx: Ctx, item: string): Promise<{ moved: number }> {
  if (!ctx.mirror.screen) throw new GolemError("blocked", "no container open");
  let moved = 0;
  try {
    for (let i = 0; i < 12; i++) {
      const r = (await ctx.body.call("withdraw", { item: fullId(item) })) as { withdrew: number };
      if (!r.withdrew) break;
      moved += r.withdrew;
      await sleep(120, ctx.token);
    }
    await reindexOpen(ctx);
    return { moved };
  } catch (e) { throw fromClef(e, `withdraw ${item}`); }
}

/**
 * Craft via the body's recipe-book command. If the recipe needs a 3x3 grid and no crafting screen
 * is open, finds a crafting table within 8 blocks (or places one from the inventory), opens it,
 * crafts, and closes it again.
 */
export async function craft(ctx: Ctx, item: string, count = 1): Promise<CraftResult> {
  if (!ctx.body.caps.has("craft")) {
    throw new GolemError("unsupported", "the body has no craft command yet (docs/CLEF-CHANGES.md #2)");
  }
  const id = fullId(item);
  const doCraft = async () => { try { return (await ctx.body.call("craft", { item: id, count })) as CraftResult; } catch (e) { throw fromClef(e, `craft ${item}`); } };
  if (ctx.mirror.screen) return doCraft();
  let needsTable = false;
  if (ctx.body.caps.has("recipes")) {
    try {
      const rs = (await ctx.body.call("recipes", { item: id })) as RecipeResult[];
      needsTable = rs.length > 0 && rs.every((r) => r.needsTable);
    } catch { /* fall through and just try */ }
  }
  if (!needsTable) {
    try { return await doCraft(); }
    catch (e) { if (!(e instanceof GolemError) || !/2x2|table/i.test(e.message)) throw e; }
  }
  return ctx.activity.run(`craft ${shortId(id)} at a table`, async () => {
    let table: Pos | undefined;
    if (ctx.body.caps.has("findBlocks")) {
      const near = await findBlocks(ctx, ["crafting_table"], { radius: 8, max: 1 }).catch(() => []);
      if (near[0]) table = { x: near[0].x, y: near[0].y, z: near[0].z };
    }
    if (!table) {
      const inv = await inventory(ctx);
      if (!inv.has("crafting_table")) throw new GolemError("missing_item", `${shortId(id)} needs a crafting table and there is none within 8 blocks or in the inventory`);
      table = await placeNearby(ctx, "crafting_table");
    }
    await openContainer(ctx, table);
    try { return await doCraft(); }
    finally { await closeScreen(ctx); }
  });
}

/** Recipe tree for an item (protocol 2 `recipes`). */
export async function recipes(ctx: Ctx, item: string): Promise<RecipeResult[]> {
  if (!ctx.body.caps.has("recipes")) throw new GolemError("unsupported", "the body has no recipes command yet (docs/CLEF-CHANGES.md #2)");
  try { return (await ctx.body.call("recipes", { item: fullId(item) })) as RecipeResult[]; }
  catch (e) { throw fromClef(e, `recipes ${item}`); }
}

/** What the inventory can craft right now (protocol 2 `craftable`). */
export async function craftable(ctx: Ctx): Promise<CraftableEntry[]> {
  if (!ctx.body.caps.has("craftable")) throw new GolemError("unsupported", "the body has no craftable command yet (docs/CLEF-CHANGES.md #2)");
  try { return (await ctx.body.call("craftable", {})) as CraftableEntry[]; }
  catch (e) { throw fromClef(e, "craftable"); }
}

/** Top-down map render centred on the bot (protocol 2 screenshot mode "topdown"). */
export async function map(ctx: Ctx, radius = 48, size = 512): Promise<{ png: Buffer; path: string | undefined }> {
  if (!ctx.body.caps.hasArg("screenshot", "mode")) throw new GolemError("unsupported", "the body has no top-down screenshot mode yet (docs/CLEF-CHANGES.md #12)");
  const m = ctx.mirror.pos;
  let r: ScreenshotResult;
  try { r = (await ctx.body.call("screenshot", { mode: "topdown", centerX: m.x, centerZ: m.z, radius, width: size, height: size }, { timeoutMs: 90_000 })) as ScreenshotResult; }
  catch (e) { throw fromClef(e, "map"); }
  const png = Buffer.from(r.base64, "base64");
  mkdirSync(ctx.agent.shotsDir, { recursive: true });
  const path = resolve(ctx.agent.shotsDir, `map-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  writeFileSync(path, png);
  return { png, path };
}

export interface ScreenshotOpts { x?: number; y?: number; z?: number; yaw?: number; pitch?: number; width?: number; height?: number; fov?: number; save?: boolean }

/** Render a PNG from the bot's eyes (or a given camera). Saved under data/<agent>/shots/. */
export async function screenshot(ctx: Ctx, opts: ScreenshotOpts = {}): Promise<{ png: Buffer; path: string | undefined; width: number; height: number; backend: string; ms: number }> {
  const { save, ...args } = opts;
  let r: ScreenshotResult;
  try { r = (await ctx.body.call("screenshot", args, { timeoutMs: 90_000 })) as ScreenshotResult; }
  catch (e) { throw fromClef(e, "screenshot"); }
  const png = Buffer.from(r.base64, "base64");
  let path: string | undefined;
  if (save ?? true) {
    mkdirSync(ctx.agent.shotsDir, { recursive: true });
    path = resolve(ctx.agent.shotsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(path, png);
  }
  return { png, path, width: r.width ?? args.width ?? 0, height: r.height ?? args.height ?? 0, backend: r.backend, ms: r.durationMs ?? 0 };
}

/** What a furnace turns an item into. Crafting recipes come from minecraft-data; smelting doesn't, so this is the common table. */
export const SMELT_OUTPUT: Record<string, string> = {
  raw_iron: "iron_ingot", iron_ore: "iron_ingot", deepslate_iron_ore: "iron_ingot",
  raw_gold: "gold_ingot", gold_ore: "gold_ingot", deepslate_gold_ore: "gold_ingot", nether_gold_ore: "gold_ingot",
  raw_copper: "copper_ingot", copper_ore: "copper_ingot", deepslate_copper_ore: "copper_ingot",
  ancient_debris: "netherite_scrap", sand: "glass", red_sand: "glass", cobblestone: "stone", stone: "smooth_stone",
  clay_ball: "brick", clay: "terracotta", netherrack: "nether_brick", cactus: "green_dye", kelp: "dried_kelp",
  wet_sponge: "sponge", beef: "cooked_beef", porkchop: "cooked_porkchop", chicken: "cooked_chicken", mutton: "cooked_mutton",
  rabbit: "cooked_rabbit", cod: "cooked_cod", salmon: "cooked_salmon", potato: "baked_potato",
  oak_log: "charcoal", birch_log: "charcoal", spruce_log: "charcoal", jungle_log: "charcoal", acacia_log: "charcoal", dark_oak_log: "charcoal", mangrove_log: "charcoal", cherry_log: "charcoal",
};
const FUELS = ["coal", "charcoal", "coal_block", "blaze_rod", "oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "oak_log", "birch_log", "spruce_log", "jungle_log", "stick"];

export interface SmeltOpts { fuel?: string; furnace?: Pos; timeoutMs?: number }

/**
 * Smelt `n` of an item in a furnace: uses one within 8 blocks, else places one from the inventory.
 * Shift-clicks fuel and input in (vanilla routes them to the right slots), waits for the output,
 * pulls it out. Resolves with how many came out.
 */
export async function smelt(ctx: Ctx, item: string, n = 1, opts: SmeltOpts = {}): Promise<{ smelted: number; output: string }> {
  const input = shortId(fullId(item));
  const output = SMELT_OUTPUT[input];
  if (!output) throw new GolemError("failed", `don't know what ${input} smelts into`);
  return ctx.activity.run(`smelt ${n} ${input}`, async () => {
    const inv = await inventory(ctx);
    if (!inv.has(input, 1)) throw new GolemError("missing_item", `no ${input} to smelt`);
    const fuel = opts.fuel ?? FUELS.find((f) => inv.has(f, 1));
    if (!fuel) throw new GolemError("missing_item", "no fuel (coal, charcoal, planks, logs or sticks)");
    let furnace = opts.furnace;
    if (!furnace && ctx.body.caps.has("findBlocks")) {
      const near = await findBlocks(ctx, ["furnace", "blast_furnace"], { radius: 8, max: 1 }).catch(() => []);
      if (near[0]) furnace = { x: near[0].x, y: near[0].y, z: near[0].z };
    }
    if (!furnace) {
      if (!inv.has("furnace")) throw new GolemError("missing_item", "no furnace nearby and none in inventory (craft one from 8 cobblestone)");
      furnace = await placeNearby(ctx, "furnace");
    }
    const before = (await inventory(ctx)).count(output);
    await openContainer(ctx, furnace);
    try {
      await deposit(ctx, fuel);
      await deposit(ctx, input);
      const timeoutMs = opts.timeoutMs ?? n * 10_000 + 30_000;
      const t0 = Date.now();
      let got = 0;
      for (;;) {
        ctx.token.throwIfCancelled();
        const c = await container(ctx);
        const out = c.slots.find((sl) => sl.slot === 2);
        got = out && slotItemId(out.item) === fullId(output) ? out.count : 0;
        if (got >= n) break;
        const inSlot = c.slots.find((sl) => sl.slot === 0);
        const inEmpty = !inSlot || inSlot.item === "empty" || inSlot.item === "minecraft:air";
        if (inEmpty && got > 0) break;   // ran out of input
        if (inEmpty && got === 0 && Date.now() - t0 > 4000) {
          // Nothing cooking and nothing done: the deposit didn't land (wrong slot, full furnace).
          throw new GolemError("failed", `furnace has no ${input} in its input slot after depositing; is it full or did the fuel go in the wrong slot?`);
        }
        if (Date.now() - t0 > timeoutMs) break;
        await sleep(2000, ctx.token);
      }
      if (got > 0) await withdraw(ctx, output);
      // leftover fuel/input stay in the furnace for next time
    } finally {
      await closeScreen(ctx);
    }
    const after = (await inventory(ctx)).count(output);
    return { smelted: after - before, output };
  });
}

/** Place a block on a free spot next to the bot and return where it went. */
export async function placeNearby(ctx: Ctx, item: string): Promise<Pos> {
  const here = ctx.mirror.blockPos;
  for (const f of ["north", "east", "south", "west"] as Face[]) {
    const spot = offset(here, f);
    const b = await blockAt(ctx, spot);
    if (!REPLACEABLE.has(b.id)) continue;
    const below = await blockAt(ctx, offset(spot, "down"));
    if (!below.solid) continue;
    await place(ctx, item, spot);
    return spot;
  }
  throw new GolemError("cant_place", `no free spot next to ${fmtPos(here)} for a ${shortId(item)}`);
}

const BED_KINDS = ["white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed", "lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed", "purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed"];

/** Find a bed within `radius`, use it, and wait for the server's verdict. */
export async function sleepInBed(ctx: Ctx, radius = 24): Promise<{ ok: boolean; reason?: string; bed?: Pos }> {
  return ctx.activity.run("sleep", async () => {
    let bed: Pos | undefined;
    if (ctx.body.caps.has("findBlocks")) {
      const near = await findBlocks(ctx, BED_KINDS, { radius, max: 1 }).catch(() => []);
      if (near[0]) bed = { x: near[0].x, y: near[0].y, z: near[0].z };
    }
    if (!bed) {
      const inv = await inventory(ctx);
      const carried = BED_KINDS.find((b) => inv.has(b));
      if (!carried) throw new GolemError("not_found", `no bed within ${radius} blocks and none in inventory`);
      bed = await placeNearby(ctx, carried);
    }
    ctx.mirror.lastSleep = null;
    await useOnBlock(ctx, bed);
    await until(() => ctx.mirror.lastSleep, { timeoutMs: 5000, intervalMs: 200, what: "sleep verdict", token: ctx.token })
      .catch(() => { throw new GolemError("failed", "the server didn't answer the sleep request (too far, monsters nearby, or not night?)"); });
    const v = ctx.mirror.lastSleep!;
    if (!v.ok) return { ok: false, reason: v.reason, bed };
    // Night skips when everyone sleeps; on a shared server that may never happen.
    await until(() => ctx.mirror.phase === "day" || ctx.mirror.phase === "dawn", { timeoutMs: 60_000, intervalMs: 1000, what: "morning", token: ctx.token }).catch(() => {});
    return { ok: true, bed };
  });
}

/** Walk over nearby dropped items. */
export async function collectDrops(ctx: Ctx, radius = 6, timeoutMs = 20_000): Promise<{ visited: number }> {
  const t0 = Date.now();
  return ctx.activity.run("collect drops", async () => {
    let visited = 0;
    for (;;) {
      ctx.token.throwIfCancelled();
      const items = (await entities(ctx, { radius })).filter((e) => e.isItem);
      if (!items.length || Date.now() - t0 > timeoutMs) return { visited };
      const it = items[0]!;
      await goto(ctx, { x: Math.floor(it.x), y: Math.floor(it.y), z: Math.floor(it.z) }, { reach: 1, exact: true, timeoutMs: 8000, retry: false }).catch(() => {});
      // Pickup radius is about a block; stopping on the edge misses. Step onto the item's exact spot.
      if (dist(ctx.mirror.pos, { x: it.x, y: it.y, z: it.z }) > 0.8) {
        await lookAt(ctx, { x: it.x, y: it.y, z: it.z }).catch(() => {});
        await move(ctx, "forward", 250).catch(() => {});
      }
      visited++;
      await sleep(400, ctx.token);
    }
  });
}

export { navStop, FACES };
