import { center, yawPitchTo, type Pos, type Vec } from "../util/geom.ts";
import type { LookAtResult } from "../body/results.ts";
import type { Ctx } from "./context.ts";
import { fromClef } from "./errors.ts";
import { entityById } from "./perception.ts";

export type LookTarget = Pos | Vec | { entityId: number } | { yaw: number; pitch: number };

/** Turn the head toward a block centre, a world point, an entity, or explicit angles. */
export async function lookAt(ctx: Ctx, target: LookTarget): Promise<{ yaw: number; pitch: number }> {
  let angles: { yaw: number; pitch: number };
  // Protocol 2: the body computes from its own eye height (sneaking, swimming, riding all differ).
  if (ctx.body.caps.has("lookAt") && !("yaw" in target)) {
    const args = "entityId" in target ? { entityId: target.entityId }
      : (Number.isInteger(target.x) && Number.isInteger(target.y) && Number.isInteger(target.z)) ? center(target as Pos) : (target as Vec);
    try {
      const r = (await ctx.body.call("lookAt", args as never)) as LookAtResult;
      ctx.mirror.yaw = r.yaw; ctx.mirror.pitch = r.pitch;
      return r;
    } catch (e) { throw fromClef(e, "lookAt"); }
  }
  if ("yaw" in target && "pitch" in target) angles = target;
  else {
    let point: Vec;
    if ("entityId" in target) {
      const e = await entityById(ctx, target.entityId);
      if (!e) throw fromClef({ code: "NOT_FOUND", message: `entity ${target.entityId} not nearby` }, "lookAt");
      const h = ctx.mc.entitiesByName[e.short]?.height ?? 1.8;
      point = { x: e.x, y: e.y + h * 0.85, z: e.z };
    } else {
      const isBlock = Number.isInteger(target.x) && Number.isInteger(target.y) && Number.isInteger(target.z);
      point = isBlock ? center(target as Pos) : (target as Vec);
    }
    angles = yawPitchTo(ctx.mirror.eye, point);
  }
  try {
    await ctx.body.call("look", angles);
    ctx.mirror.yaw = angles.yaw; ctx.mirror.pitch = angles.pitch;
  } catch (e) { throw fromClef(e, "look"); }
  return angles;
}
