// The Golem tool registry: what the mind can do to the world. One definition drives both the MCP
// server (schemas + handlers) and the workspace orientation doc (names + descriptions). Every
// action tool maps to a primitive of the same name; results are compact text, images where a
// picture is the point.
import { z } from "zod";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Drive } from "../drive/drive.ts";
import { GolemError } from "../primitives/errors.ts";
import type { Primitives } from "../primitives/index.ts";
import { fmtPos, type Pos } from "../util/geom.ts";
import { readGoal, writeGoal } from "../workspace/generate.ts";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ShemEngine } from "../shem/engine.ts";
import { describeRun } from "../shem/runs.ts";
export interface ToolCtx { rt: AgentRuntime; drive: Drive; p: Primitives; shem?: ShemEngine }
export interface ToolResult { text: string; image?: { data: Buffer; mimeType: string } }
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  run(args: z.infer<z.ZodObject<S>>, tc: ToolCtx): Promise<ToolResult>;
}

const posShape = { x: z.number().int(), y: z.number().int(), z: z.number().int() };
const toPos = (a: { x: number; y: number; z: number }): Pos => ({ x: a.x, y: a.y, z: a.z });
const ok = (text: string): ToolResult => ({ text });

function def<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<z.ZodRawShape> { return d as unknown as ToolDef<z.ZodRawShape>; }

export const TOOLS: ToolDef[] = [
  // ---- perception ----------------------------------------------------------------
  def({ name: "status", description: "Where you are, health, food, time, held item, current activity, reflex states.", input: {},
    async run(_a, { rt }) { await rt.mirror.refresh(); return ok(rt.drive?.stateHeader() ?? rt.mirror.summary(rt.agent.name)); } }),
  def({ name: "look_around", description: "Structured summary of your surroundings: threats, players, mobs, drops, nearby useful blocks, what you stand on, inventory line.", input: { radius: z.number().int().min(4).max(64).default(16) },
    async run(a, { p }) { return ok(await p.lookAround(a.radius)); } }),
  def({ name: "see", description: "Take a picture from your eyes (or a given camera position/angle). Returns a PNG. Use when layout or looks matter; look_around is cheaper and exact.", input: { x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), yaw: z.number().optional(), pitch: z.number().optional(), width: z.number().int().max(1920).default(960), height: z.number().int().max(1080).default(540) },
    async run(a, { p }) { const r = await p.screenshot(a); return { text: `screenshot ${r.width}x${r.height} (${r.backend}) saved to ${r.path}`, image: { data: r.png, mimeType: "image/png" } }; } }),
  def({ name: "map", description: "Top-down map of the area around you as a PNG.", input: { radius: z.number().int().min(8).max(128).default(48) },
    async run(a, { p }) { const r = await p.map(a.radius); return { text: `top-down map radius ${a.radius} saved to ${r.path}`, image: { data: r.png, mimeType: "image/png" } }; } }),
  def({ name: "find_blocks", description: "Nearest blocks of the given kinds (e.g. [\"oak_log\",\"iron_ore\"]), nearest first, with coordinates.", input: { kinds: z.array(z.string()).min(1), radius: z.number().int().min(4).max(96).default(32), max: z.number().int().min(1).max(64).default(16) },
    async run(a, { p }) { const hits = await p.findBlocks(a.kinds, { radius: a.radius, max: a.max }); return ok(hits.length ? hits.map((h) => `${h.block.replace("minecraft:", "")} ${fmtPos(h)} ${h.dist.toFixed(1)}m`).join("\n") : `no ${a.kinds.join("/")} within ${a.radius} blocks`); } }),
  def({ name: "find_entities", description: "Nearby entities with ids, positions, distances and whether they're hostile. Filter by kinds (\"zombie\", \"item\", \"player\").", input: { kinds: z.array(z.string()).optional(), radius: z.number().min(2).max(64).default(16), hostile_only: z.boolean().default(false) },
    async run(a, { p }) { const es = await p.entities({ radius: a.radius, kinds: a.kinds, hostileOnly: a.hostile_only }); return ok(es.length ? es.map((e) => `#${e.id} ${e.isPlayer ? e.name : e.short}${e.hostile ? " (hostile)" : ""}${e.health != null ? ` hp ${e.health}` : ""} ${e.distance.toFixed(1)}m ${fmtPos(e.pos)}`).join("\n") : "no entities nearby"); } }),
  def({ name: "block_at", description: "What block is at a position.", input: posShape,
    async run(a, { p }) { const b = await p.blockAt(toPos(a)); return ok(`${b.short} at ${fmtPos(b.pos)}${b.air ? " (air)" : b.liquid ? " (liquid)" : ""}`); } }),
  def({ name: "inventory", description: "Your inventory, armor, held item.", input: {},
    async run(_a, { p }) { return ok((await p.inventory()).describe()); } }),
  def({ name: "container", description: "Contents of the container you have open (or villager trades).", input: {},
    async run(_a, { p }) { const c = await p.container(); const items = c.slots.filter((s) => s.item && s.item !== "empty" && s.item !== "minecraft:air"); return ok(`${c.handler}: ${items.map((s) => `[${s.slot}] ${s.item.replace("minecraft:", "")} x${s.count}`).join(", ") || "empty"}${c.trades?.length ? `\ntrades: ${JSON.stringify(c.trades)}` : ""}`); } }),
  def({ name: "craftable", description: "What you can craft right now with what you carry.", input: {},
    async run(_a, { p }) { const c = await p.craftable(); return ok(c.length ? c.map((x) => `${x.item.replace("minecraft:", "")} x${x.count}`).join(", ") : "nothing craftable with the current inventory"); } }),
  def({ name: "recipe", description: "Recipes that produce an item: ingredients, counts, whether a crafting table is needed.", input: { item: z.string() },
    async run(a, { p }) { return ok(JSON.stringify(await p.recipes(a.item))); } }),
  def({ name: "players", description: "Who is online.", input: {},
    async run(_a, { p }) { return ok((await p.players()).map((x) => x.name).join(", ") || "nobody"); } }),
  def({ name: "chat_history", description: "Recent chat lines you've seen.", input: { limit: z.number().int().min(1).max(100).default(20) },
    async run(a, { p }) { const h = await p.chatHistory(a.limit); return ok(h.map((l) => `${l.sender ? l.sender + ": " : ""}${l.text}`).join("\n") || "no chat yet"); } }),
  def({ name: "target", description: "What your crosshair is on.", input: {},
    async run(_a, { p }) { return ok(JSON.stringify(await p.target())); } }),

  // ---- movement -------------------------------------------------------------------
  def({ name: "goto", description: "Walk to a block position (Baritone pathing). Blocks until you arrive within `reach` blocks or fail. Use reach 2-3 for solid targets.", input: { ...posShape, reach: z.number().int().min(1).max(8).default(1), timeout_s: z.number().min(5).max(600).default(60) },
    async run(a, { p }) { const r = await p.goto(toPos(a), { reach: a.reach, timeoutMs: a.timeout_s * 1000 }); return ok(`arrived ${fmtPos(r.pos)} (${r.distance.toFixed(1)} from goal) in ${(r.ms / 1000).toFixed(1)}s`); } }),
  def({ name: "goto_nearest", description: "Walk to the nearest block of a kind (Baritone scans loaded chunks).", input: { kind: z.string(), timeout_s: z.number().min(5).max(600).default(90) },
    async run(a, { p }) { const r = await p.gotoNearestBlock(a.kind, { timeoutMs: a.timeout_s * 1000 }); return ok(`next to ${a.kind} at ${fmtPos(r.pos)} after ${(r.ms / 1000).toFixed(1)}s`); } }),
  def({ name: "goto_player", description: "Walk to a player.", input: { player: z.string(), reach: z.number().int().min(1).max(8).default(2) },
    async run(a, { p }) { const e = (await p.entities({ radius: 64, kinds: ["player"] })).find((x) => x.name === a.player); if (!e) throw new GolemError("not_found", `${a.player} is not nearby`); const r = await p.goto({ x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) }, { reach: a.reach }); return ok(`reached ${a.player} at ${fmtPos(r.pos)}`); } }),
  def({ name: "follow", description: "Follow a player until `stop`. Returns immediately.", input: { player: z.string(), distance: z.number().min(1).max(10).default(3) },
    async run(a, { p }) { await p.follow({ player: a.player }, a.distance); return ok(`following ${a.player}`); } }),
  def({ name: "stop", description: "Stop moving, mining, pathing and item use.", input: {},
    async run(_a, { p }) { await p.stop(); return ok("stopped"); } }),
  def({ name: "look_at", description: "Turn your head toward a block position or an entity id.", input: { x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), entity_id: z.number().int().optional() },
    async run(a, { p }) { const r = a.entity_id != null ? await p.lookAt({ entityId: a.entity_id }) : await p.lookAt({ x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 }); return ok(`looking yaw ${r.yaw.toFixed(0)} pitch ${r.pitch.toFixed(0)}`); } }),
  def({ name: "explore", description: "Wander into unexplored terrain until `stop`.", input: {},
    async run(_a, { p }) { await p.explore(); return ok("exploring"); } }),
  def({ name: "surface", description: "Climb to the surface.", input: {},
    async run(_a, { p }) { await p.surface(); return ok("on the surface"); } }),

  // ---- actions --------------------------------------------------------------------
  def({ name: "mine", description: "Break one block at a position (walks there, picks the best tool, collects the drop).", input: posShape,
    async run(a, { p }) { const r = await p.mine(toPos(a)); return ok(r.broken ? `broke ${r.block} in ${(r.ms / 1000).toFixed(1)}s` : `${fmtPos(toPos(a))} was already air`); } }),
  def({ name: "mine_all", description: "Mine blocks of a kind until you've collected `count` of the drop (Baritone finds them). Long-running.", input: { kind: z.string(), count: z.number().int().min(1).max(256).default(8), timeout_s: z.number().min(10).max(1800).default(300) },
    async run(a, { p }) { const r = await p.mineAll(a.kind, a.count, { timeoutMs: a.timeout_s * 1000 }); return ok(`collected ${r.got} ${r.item} in ${(r.ms / 1000).toFixed(0)}s`); } }),
  def({ name: "place", description: "Place an item from your inventory so it occupies a position.", input: { item: z.string(), ...posShape },
    async run(a, { p }) { await p.place(a.item, toPos(a)); return ok(`placed ${a.item} at ${fmtPos(toPos(a))}`); } }),
  def({ name: "use_on", description: "Right-click a block (door, lever, bed, chest...) or an entity id with what you hold.", input: { x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional(), entity_id: z.number().int().optional() },
    async run(a, { p }) { if (a.entity_id != null) { await p.interactEntity(a.entity_id); return ok(`used on #${a.entity_id}`); } await p.useOnBlock({ x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 }); return ok("used"); } }),
  def({ name: "attack", description: "Fight an entity by id until it's gone or the timeout passes (walks into reach, picks a weapon).", input: { entity_id: z.number().int(), timeout_s: z.number().min(3).max(120).default(30) },
    async run(a, { p }) { const r = await p.attack(a.entity_id, { timeoutMs: a.timeout_s * 1000 }); return ok(`${r.killed ? "killed" : "stopped"} after ${r.hits} hits`); } }),
  def({ name: "equip", description: "Equip armor, a shield, or move a tool to hand.", input: { item: z.string() },
    async run(a, { p }) { await p.equip(a.item); return ok(`equipped ${a.item}`); } }),
  def({ name: "eat", description: "Eat a named food, or the best food you carry.", input: { item: z.string().optional() },
    async run(a, { p }) { const r = await p.eat(a.item); return ok(r.ate ? `ate ${r.ate}, food now ${r.food}` : "not hungry"); } }),
  def({ name: "drop", description: "Drop items (count omitted = whole stacks).", input: { item: z.string(), count: z.number().int().min(1).optional() },
    async run(a, { p }) { const r = await p.drop(a.item, a.count); return ok(`dropped ${r.dropped}`); } }),
  def({ name: "craft", description: "Craft an item (uses a crafting table if one is open or needed and nearby).", input: { item: z.string(), count: z.number().int().min(1).max(64).default(1) },
    async run(a, { p }) { const r = await p.craft(a.item, a.count); return ok(`crafted ${r.crafted} ${r.item.replace("minecraft:", "")}`); } }),
  def({ name: "open", description: "Open a container block (chest, furnace, crafting table...) and read it.", input: posShape,
    async run(a, { p }) { const c = await p.openContainer(toPos(a)); const items = c.slots.filter((s) => s.item && s.item !== "empty" && s.item !== "minecraft:air"); return ok(`${c.handler}: ${items.map((s) => `[${s.slot}] ${s.item.replace("minecraft:", "")} x${s.count}`).join(", ") || "empty"}`); } }),
  def({ name: "close", description: "Close the open container/screen.", input: {},
    async run(_a, { p }) { await p.closeScreen(); return ok("closed"); } }),
  def({ name: "deposit", description: "Move all of an item from your inventory into the open container.", input: { item: z.string() },
    async run(a, { p }) { const r = await p.deposit(a.item); return ok(`deposited ${r.moved}`); } }),
  def({ name: "withdraw", description: "Move all of an item from the open container into your inventory.", input: { item: z.string() },
    async run(a, { p }) { const r = await p.withdraw(a.item); return ok(`withdrew ${r.moved}`); } }),
  def({ name: "smelt", description: "Smelt items in a furnace (one within 8 blocks, or placed from your inventory). Uses coal/charcoal/planks/logs you carry as fuel. Waits for the output and takes it.", input: { item: z.string(), count: z.number().int().min(1).max(64).default(1), fuel: z.string().optional() },
    async run(a, { p }) { const r = await p.smelt(a.item, a.count, { fuel: a.fuel }); return ok(`smelted ${r.smelted} ${r.output}`); } }),
  def({ name: "sleep", description: "Sleep in a bed within 24 blocks (or place one you carry). Only works at night; the night skips if every player sleeps.", input: {},
    async run(_a, { p }) { const r = await p.sleepInBed(); return ok(r.ok ? `slept${r.bed ? ` at ${fmtPos(r.bed)}` : ""}` : `couldn't sleep: ${r.reason ?? "refused"}`); } }),
  def({ name: "collect_drops", description: "Walk over nearby dropped items.", input: { radius: z.number().min(2).max(16).default(6) },
    async run(a, { p }) { const r = await p.collectDrops(a.radius); return ok(`visited ${r.visited} drops`); } }),
  def({ name: "baritone", description: "Run a raw Baritone command (e.g. \"farm\", \"tunnel\", \"sel pos1 ...\"). Expert use.", input: { command: z.string() },
    async run(a, { p }) { await p.baritone(a.command); return ok(`baritone: ${a.command}`); } }),

  // ---- comms ----------------------------------------------------------------------
  def({ name: "say", description: "Say one line in game chat. Short. Rate-limited.", input: { text: z.string().min(1) },
    async run(a, { p }) { const r = await p.say(a.text); return ok(`said: ${r.sent}`); } }),
  def({ name: "whisper", description: "Private message a player.", input: { player: z.string(), text: z.string().min(1) },
    async run(a, { p }) { const r = await p.whisper(a.player, a.text); return ok(`whispered to ${a.player}: ${r.sent}`); } }),
  def({ name: "inbox", description: "Anything that arrived since your turn started (chat, damage, reflexes).", input: {},
    async run(_a, { drive }) { return ok(drive.peekInbox()); } }),

  // ---- memory, reflexes, goals, kill switch ---------------------------------------
  def({ name: "remember", description: "Save the current position (or a given one) under a name in memory/places.md.", input: { name: z.string(), x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional(), note: z.string().optional() },
    async run(a, { rt }) { const m = rt.mirror; const pos = a.x != null && a.y != null && a.z != null ? { x: a.x, y: a.y, z: a.z } : m.blockPos; appendFileSync(resolve(rt.agent.workspaceDir, "memory", "places.md"), `- ${a.name}: ${fmtPos(pos)} ${m.dimension.replace("minecraft:", "")}${a.note ? ` — ${a.note}` : ""}\n`); return ok(`remembered ${a.name} at ${fmtPos(pos)}`); } }),
  def({ name: "reflexes", description: "List reflexes and whether they're on.", input: {},
    async run(_a, { rt }) { return ok(rt.reflexes.list().map((r) => `${r.on ? "on " : "off"} ${r.name}: ${r.description}`).join("\n")); } }),
  def({ name: "reflex_set", description: "Turn a reflex on or off (e.g. cowardice, self_defense, hunting).", input: { name: z.string(), on: z.boolean() },
    async run(a, { rt }) { rt.reflexes.enable(a.name, a.on); return ok(`${a.name} ${a.on ? "on" : "off"}`); } }),
  def({ name: "goal_set", description: "Set your standing goal. Golem will wake you periodically to continue it when nothing else is happening.", input: { text: z.string() },
    async run(a, { rt, drive }) { writeGoal(rt.agent, a.text); drive.goal = a.text; return ok(`goal: ${a.text}`); } }),
  def({ name: "goal_clear", description: "Clear the standing goal.", input: {},
    async run(_a, { rt, drive }) { writeGoal(rt.agent, ""); drive.goal = ""; return ok("goal cleared" + (readGoal(rt.agent) ? "" : "")); } }),
  def({ name: "plan_next", description: "Ask for your next turn to run on the stronger planning model. Use before a big decision (where to build, a long expedition, what to do after repeated failures). Say why in one line, then end your turn right after calling this.", input: { reason: z.string().optional() },
    async run(a, { drive, rt }) { drive.escalateNext = true; rt.trace.mark("plan_next", { reason: a.reason }); return ok("Noted. End your turn now; the next one runs on the planning model."); } }),
  def({ name: "met", description: "Stop everything immediately: movement, mining, pathing, reflex actions.", input: {},
    async run(_a, { rt }) { await rt.met(); return ok("met. everything stopped."); } }),
];

const needShem = (tc: ToolCtx): ShemEngine => { if (!tc.shem) throw new GolemError("unsupported", "Shem is not enabled for this agent"); return tc.shem; };
const paramsShape = z.record(z.string(), z.any()).optional();

export const SHEM_TOOLS: ToolDef[] = [
  def({ name: "shem_check", description: "Check a Shem script file (path under your workspace, or lib/<name>) without running it: syntax, unknown names, arity, unknown block/item ids, bare numbers where durations go.", input: { path: z.string().optional(), source: z.string().optional() },
    async run(a, tc) { const e = needShem(tc); if (a.source) return ok(e.checkSource(a.source).text); if (!a.path) throw new GolemError("failed", "give path or source"); return ok(e.check(a.path).text); } }),
  def({ name: "shem_run", description: "Run a script from a file. `path` is the file (shem/mine.shem, or lib/wood for the standard library); `script` is the script name inside it (required when the file has several, e.g. lib/craft has make_planks, make_sticks, table_here, wooden_tools); `params` are the script's own parameters as JSON. Blocks until it ends or timeout_s passes (the run keeps going; use shem_status/shem_wait). background: true returns immediately. interrupt: true preempts a lower-priority foreground run.", input: { path: z.string(), script: z.string().optional(), params: paramsShape, priority: z.number().int().min(0).max(100).default(50), interrupt: z.boolean().default(false), background: z.boolean().default(false), timeout_s: z.number().min(1).max(3600).default(120) },
    async run(a, tc) {
      const e = needShem(tc);
      const run = e.run(a.path, a.script, (a.params ?? {}) as Record<string, never>, { priority: a.priority, interrupt: a.interrupt, background: a.background, timeoutMs: Math.max(a.timeout_s, 600) * 1000 });
      if (a.background) return ok(`started ${run.id} (${run.label}) in the background`);
      return ok(await e.wait(run, a.timeout_s * 1000));
    } }),
  def({ name: "shem_eval", description: "Run a Shem snippet (statements, or a whole file with script declarations) without saving it. Good for one-off actions and for trying a script before writing it.", input: { code: z.string(), params: paramsShape, timeout_s: z.number().min(1).max(3600).default(120), background: z.boolean().default(false) },
    async run(a, tc) { const e = needShem(tc); const run = e.eval(a.code, (a.params ?? {}) as Record<string, never>, { background: a.background, timeoutMs: Math.max(a.timeout_s, 600) * 1000 }); if (a.background) return ok(`started ${run.id} in the background`); return ok(await e.wait(run, a.timeout_s * 1000)); } }),
  def({ name: "shem_status", description: "Status and trace tail of a run.", input: { run: z.string() },
    async run(a, tc) { const r = needShem(tc).runs.get(a.run); if (!r) throw new GolemError("not_found", `no run ${a.run}`); return ok(describeRun(r, 30, true)); } }),
  def({ name: "shem_wait", description: "Wait for a run to end (bounded).", input: { run: z.string(), timeout_s: z.number().min(1).max(3600).default(120) },
    async run(a, tc) { const e = needShem(tc); const r = e.runs.get(a.run); if (!r) throw new GolemError("not_found", `no run ${a.run}`); return ok(await e.wait(r, a.timeout_s * 1000)); } }),
  def({ name: "shem_cancel", description: "Cancel a run, or every active run when omitted.", input: { run: z.string().optional() },
    async run(a, tc) { const n = needShem(tc).runs.cancel(a.run, "shem_cancel"); return ok(`cancelled ${n} run(s)`); } }),
  def({ name: "shem_runs", description: "Active and recent runs.", input: {},
    async run(_a, tc) { const rs = needShem(tc).runs.list().slice(0, 15); return ok(rs.length ? rs.map((r) => `${r.id} ${r.label} p${r.priority}${r.background ? " bg" : ""}: ${r.status}${r.status === "running" && r.current ? ` (in ${r.current})` : ""}`).join("\n") : "no runs yet"); } }),
  def({ name: "shem_list", description: "Index of every script you can run: yours under shem/, the standard library under lib/, and reflexes.", input: {},
    async run(_a, tc) { return ok(needShem(tc).list()); } }),
  def({ name: "shem_doc", description: "Documentation for a Shem function, getter, event, or library script by name.", input: { name: z.string() },
    async run(a, tc) { return ok(needShem(tc).doc(a.name)); } }),
];

export const ALL_TOOLS: ToolDef[] = [...TOOLS, ...SHEM_TOOLS];

export function toolDocs(): { name: string; description: string }[] {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description }));
}
