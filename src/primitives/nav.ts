// Movement: Baritone pathing with honest completion, plus the Baritone command set that gives us
// follow / mine / explore / surface for free. `goto` polls nav.status until the body ships nav.done
// and nav.failed events (CLEF-CHANGES #7), at which point the mirror short-circuits the loop.
import type { GotoResult, NavCheckResult, NavStatusResult } from "../body/results.ts";
import { awayFrom, center, dist, distXZ, fmtPos, type Pos, type Vec } from "../util/geom.ts";
import { fullId, shortId, type Ctx } from "./context.ts";
import { GolemError, fromClef, sleep, until } from "./errors.ts";
import { blockAt } from "./perception.ts";
import { inventory } from "./inventory.ts";

export interface GotoOpts {
  /** Stop when within this many blocks of the target (default 1 = stand on it). */
  reach?: number;
  /** Arrive only when standing in the target's column (for picking things up). */
  exact?: boolean;
  timeoutMs?: number;
  /** Re-issue the goal once if Baritone gives up early (default true). */
  retry?: boolean;
}
export interface GotoResultInfo { arrived: boolean; ms: number; pos: Vec; distance: number }

async function navStatus(ctx: Ctx): Promise<NavStatusResult> {
  try { return (await ctx.body.call("nav.status")) as NavStatusResult; }
  catch (e) { throw fromClef(e, "nav.status"); }
}

export async function navStop(ctx: Ctx): Promise<void> {
  await ctx.body.call("nav.stop").catch(() => {});
  ctx.mirror.navActive = false;
}

/** Run a raw Baritone command ("mine 8 oak_log", "follow player Viola"). Leading '#' is optional. */
export async function baritone(ctx: Ctx, command: string): Promise<void> {
  const cmd = command.trim().replace(/^#/, "");
  try { await ctx.body.call("baritone", { command: cmd }); }
  catch (e) { throw fromClef(e, `baritone ${cmd}`); }
}

/**
 * Waits for a Baritone process to finish. Completion = the nav went active, then inactive for a few
 * polls (Baritone flickers between path segments, so one inactive poll is not enough). If it never
 * goes active within `startGraceMs`, resolves { started: false } so the caller can decide.
 */
async function waitNav(ctx: Ctx, opts: { timeoutMs: number; startGraceMs?: number; arrived?: () => boolean; what: string }): Promise<{ started: boolean; arrived: boolean }> {
  const start = Date.now();
  const grace = opts.startGraceMs ?? 4000;
  let activeSeen = false;
  let inactivePolls = 0;
  ctx.mirror.navEvent = null;
  for (;;) {
    ctx.token.throwIfCancelled();
    if (opts.arrived?.()) return { started: true, arrived: true };
    const ev = ctx.mirror.getNavEvent();
    if (ev) {
      // NEXT_CALC_FAILED is Baritone failing to plan the *next* segment; it usually recalculates
      // and carries on (seen live: NEXT_CALC_FAILED then nav.done two seconds later). Only treat it
      // as the end if the bot has also stopped moving.
      if (ev.kind === "failed" && ev.reason === "NEXT_CALC_FAILED" && ctx.mirror.movedRecently(3000)) {
        ctx.mirror.navEvent = null;
        activeSeen = true;
      } else {
        return { started: true, arrived: ev.kind === "done" || !!opts.arrived?.() };
      }
    }
    const s = await navStatus(ctx);
    ctx.mirror.navActive = s.active;
    if (s.active) { activeSeen = true; inactivePolls = 0; }
    else inactivePolls++;
    if (!activeSeen && Date.now() - start > grace) return { started: false, arrived: false };
    // Baritone reports "not pathing" while it calculates the next segment of a long path, so
    // inactivity only counts once the bot has also stopped moving.
    if (activeSeen && inactivePolls >= 4 && !ctx.mirror.movedRecently(3000)) return { started: true, arrived: !!opts.arrived?.() };
    if (Date.now() - start > opts.timeoutMs) {
      await navStop(ctx);
      throw new GolemError("timeout", `${opts.what} timed out after ${opts.timeoutMs} ms`);
    }
    await sleep(250, ctx.token);
  }
}

/** Path to a block position (or an XZ column when y is omitted). Resolves on arrival. */
export async function goto(ctx: Ctx, target: Pos | { x: number; z: number }, opts: GotoOpts = {}): Promise<GotoResultInfo> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const hasY = "y" in target && typeof target.y === "number";
  let reach = opts.reach ?? 1;
  const t0 = Date.now();
  // A solid target can't be stood in; Baritone would try to dig it. Bump reach so we stop beside it.
  if (hasY && reach < 2) {
    const b = await blockAt(ctx, target as Pos).catch(() => undefined);
    if (b?.solid) { reach = 2; ctx.log.debug(`goto ${fmtPos(target as Pos)} is solid; using reach 2`); }
  }
  const goal: Vec = hasY ? center(target as Pos) : { x: target.x + 0.5, y: ctx.mirror.pos.y, z: target.z + 0.5 };
  const arrived = () => {
    const p = ctx.mirror.pos;
    const feet: Vec = { x: p.x, y: p.y + 0.5, z: p.z };
    if (opts.exact) return distXZ(p, goal) <= 0.6 && Math.abs(p.y - (goal.y - 0.5)) <= 1.5;
    return hasY ? dist(feet, goal) <= reach + 0.75 : distXZ(p, goal) <= reach + 0.75;
  };
  const send = async () => {
    const args: Record<string, number> = hasY ? { x: target.x, y: (target as Pos).y, z: target.z } : { x: target.x, z: target.z };
    if (ctx.body.caps.hasArg("goto", "reach") && reach > 1) args.reach = reach;
    try { return (await ctx.body.call("goto", args)) as GotoResult; }
    catch (e) { throw fromClef(e, `goto ${fmtPos(target as Vec)}`); }
  };
  const finish = async (): Promise<GotoResultInfo> => {
    await ctx.mirror.refresh().catch(() => {});
    if (ctx.mirror.navActive) await navStop(ctx);
    const p = ctx.mirror.pos;
    return { arrived: true, ms: Date.now() - t0, pos: p, distance: dist({ x: p.x, y: p.y + 0.5, z: p.z }, goal) };
  };

  return ctx.activity.run(`goto ${fmtPos(goal)}`, async () => {
    if (arrived()) return finish();
    await send();
    const retry = opts.retry ?? true;
    for (let attempt = 0; ; attempt++) {
      const r = await waitNav(ctx, { timeoutMs: timeoutMs - (Date.now() - t0), arrived, what: `goto ${fmtPos(goal)}` });
      if (r.arrived || arrived()) return finish();
      if (attempt === 0 && retry) {
        ctx.log.debug(`goto: baritone ${r.started ? "stopped short" : "never started"}; retrying once`);
        await sleep(500, ctx.token);
        await send();
        continue;
      }
      await navStop(ctx);
      const p = ctx.mirror.pos;
      throw new GolemError("unreachable", `could not reach ${fmtPos(goal)} (stopped ${dist(p, goal).toFixed(1)} blocks away, baritone ${r.started ? "gave up" : "did not start"})`);
    }
  });
}

export async function gotoXZ(ctx: Ctx, x: number, z: number, opts: GotoOpts = {}): Promise<GotoResultInfo> {
  return goto(ctx, { x: Math.floor(x), z: Math.floor(z) }, opts);
}

/**
 * Walk to the nearest block of a kind using Baritone's own chunk scan (`goto <block>`). This is the
 * findBlocks stand-in until the body can list positions. Resolves when Baritone stops.
 */
export async function gotoNearestBlock(ctx: Ctx, kind: string, opts: { timeoutMs?: number } = {}): Promise<{ pos: Vec; ms: number }> {
  const t0 = Date.now();
  const short = shortId(fullId(kind));
  return ctx.activity.run(`goto nearest ${short}`, async () => {
    await baritone(ctx, `goto ${short}`);
    const r = await waitNav(ctx, { timeoutMs: opts.timeoutMs ?? 90_000, what: `goto nearest ${short}` });
    if (!r.started) throw new GolemError("not_found", `baritone found no ${short} in loaded chunks`);
    await ctx.mirror.refresh().catch(() => {});
    return { pos: ctx.mirror.pos, ms: Date.now() - t0 };
  });
}

/** Follow a player (or entity type) until stop(). Returns immediately. */
export async function follow(ctx: Ctx, target: { player: string } | { entity: string }, distance?: number): Promise<void> {
  if (distance !== undefined) await baritone(ctx, `set followRadius ${Math.max(1, Math.round(distance))}`);
  if ("player" in target) await baritone(ctx, `follow player ${target.player}`);
  else await baritone(ctx, `follow entity ${shortId(target.entity)}`);
  ctx.mirror.navActive = true;
}

/** Stop everything that moves: Baritone, held inputs, mining, item use. */
export async function stop(ctx: Ctx): Promise<void> {
  await Promise.allSettled([
    ctx.body.call("nav.stop"),
    ctx.body.call("stopMove"),
    ctx.body.call("stopMine"),
    ctx.body.call("useRelease"),
  ]);
  ctx.mirror.navActive = false;
}

export type MoveDir = "forward" | "backward" | "left" | "right";
/** Raw movement input for `durationMs`. Resolves when the input ends. */
export async function move(ctx: Ctx, dir: MoveDir, durationMs = 500, flags: { sprint?: boolean; jump?: boolean; sneak?: boolean } = {}): Promise<void> {
  try { await ctx.body.call("move", { [dir]: true, sprint: !!flags.sprint, jump: !!flags.jump, sneak: !!flags.sneak, durationMs }); }
  catch (e) { throw fromClef(e, "move"); }
  await sleep(durationMs, ctx.token);
}
export async function jump(ctx: Ctx): Promise<void> {
  await ctx.body.call("move", { jump: true, durationMs: 200 }).catch((e) => { throw fromClef(e, "jump"); });
  await sleep(250, ctx.token);
}

/** Move `n` blocks away from a point or the centroid of several. */
export async function flee(ctx: Ctx, from: Vec | Vec[], n = 16, opts: GotoOpts = {}): Promise<GotoResultInfo> {
  const pts = Array.isArray(from) ? from : [from];
  const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length, z: a.z + p.z / pts.length }), { x: 0, y: 0, z: 0 });
  const away = awayFrom(ctx.mirror.pos, c, n);
  return gotoXZ(ctx, away.x, away.z, { reach: 2, timeoutMs: 20_000, ...opts });
}

export async function surface(ctx: Ctx, opts: { timeoutMs?: number } = {}): Promise<{ y: number; rose: number }> {
  return ctx.activity.run("surface", async () => {
    const y0 = ctx.mirror.pos.y;
    await baritone(ctx, "surface");
    const r = await waitNav(ctx, { timeoutMs: opts.timeoutMs ?? 120_000, what: "surface" });
    await ctx.mirror.refresh().catch(() => {});
    const rose = ctx.mirror.pos.y - y0;
    const skyAbove = await blockAt(ctx, { ...ctx.mirror.blockPos, y: ctx.mirror.blockPos.y + 2 }).then((b) => b.air).catch(() => true);
    if (!r.started || (rose < 1 && !skyAbove)) throw new GolemError("unreachable", `no way up from y=${y0.toFixed(0)} (sealed in? dig or open a door first)`);
    return { y: ctx.mirror.pos.y, rose };
  });
}

/** Baritone explore. With `forMs`, blocks that long and then stops; otherwise returns at once (stop() ends it). */
export async function explore(ctx: Ctx, forMs?: number): Promise<void> {
  await baritone(ctx, "explore");
  ctx.mirror.navActive = true;
  if (forMs) {
    await ctx.activity.run("explore", async () => {
      try { await sleep(forMs, ctx.token); } finally { await navStop(ctx); }
    });
  }
}

/**
 * Baritone `mine`: scans, paths, and digs the block kind until `count` of its drop are in the
 * inventory (or nothing more is found). Long-running; default timeout 5 minutes.
 */
export async function mineAll(ctx: Ctx, kind: string, count = 1, opts: { timeoutMs?: number } = {}): Promise<{ got: number; item: string; ms: number }> {
  const short = shortId(fullId(kind));
  const block = ctx.mc.blocksByName[short];
  if (!block) throw new GolemError("not_found", `unknown block ${short}`);
  const dropId = block.drops?.[0];
  const dropName = typeof dropId === "number" ? (ctx.mc.items[dropId]?.name ?? short) : short;
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return ctx.activity.run(`mine ${count} ${short}`, async () => {
    const start = (await inventory(ctx)).count(dropName);
    await baritone(ctx, `mine ${count} ${short}`);
    let idleSince = 0;
    let started = false;
    for (;;) {
      ctx.token.throwIfCancelled();
      const got = (await inventory(ctx)).count(dropName) - start;
      if (got >= count) { await navStop(ctx); return { got, item: dropName, ms: Date.now() - t0 }; }
      const s = await navStatus(ctx);
      if (s.active) { started = true; idleSince = 0; }
      else if (started) { idleSince ||= Date.now(); if (Date.now() - idleSince > 8000) { await navStop(ctx); return { got, item: dropName, ms: Date.now() - t0 }; } }
      else if (Date.now() - t0 > 6000) { await navStop(ctx); throw new GolemError("not_found", `baritone found no ${short} to mine`); }
      if (Date.now() - t0 > timeoutMs) { await navStop(ctx); throw new GolemError("timeout", `mine ${count} ${short} timed out with ${got}`); }
      await sleep(1000, ctx.token);
    }
  });
}

/** Ask Baritone whether a goal is reachable without moving (protocol 2 `nav.check`). */
export async function navCheck(ctx: Ctx, p: Pos, reach = 1): Promise<NavCheckResult> {
  if (!ctx.body.caps.has("nav.check")) throw new GolemError("unsupported", "the body has no nav.check command yet (docs/CLEF-CHANGES.md #7)");
  try { return (await ctx.body.call("nav.check", { x: p.x, y: p.y, z: p.z, reach })) as NavCheckResult; }
  catch (e) { throw fromClef(e, `nav.check ${fmtPos(p)}`); }
}

/** True if Baritone thinks it's doing something. */
export async function isNavActive(ctx: Ctx): Promise<boolean> {
  return (await navStatus(ctx)).active;
}

export { until };
