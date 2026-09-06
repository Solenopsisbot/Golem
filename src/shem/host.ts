// The real host: binds every builtin to the agent's primitives and body events. Values crossing
// the boundary are converted here (Vec3 <-> {x,y,z}, entity records, durations).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Journal } from "../drive/transcript.ts";
import { GolemError } from "../primitives/errors.ts";
import { withToken } from "../primitives/context.ts";
import { makePrimitives, type Primitives } from "../primitives/index.ts";
import type { Entity } from "../primitives/perception.ts";
import { shortId } from "../primitives/context.ts";
import { chestsWith } from "../world/chests.ts";
import type { Host, HostFn } from "./interpreter.ts";
import { Dur, Vec3, ShemMap, toDur, toList, toNum, toPos, toStr, toVec, type Value, type Record_ } from "./values.ts";

type P = Primitives;

function entityRecord(e: Entity): Record_ {
  return { id: e.id, type: e.type, short: e.short, name: e.name, pos: new Vec3(e.x, e.y, e.z, false), dist: e.distance, hostile: e.hostile, is_player: e.isPlayer, is_item: e.isItem, health: e.health ?? null };
}
function blockRecord(b: { id: string; short: string; air: boolean; solid: boolean; liquid: boolean; pos: { x: number; y: number; z: number } }): Record_ {
  return { id: b.id, name: b.short, short: b.short, block: b.id, air: b.air, solid: b.solid, liquid: b.liquid, pos: new Vec3(b.pos.x, b.pos.y, b.pos.z, true) };
}
function kindsArg(v: Value | undefined): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => toStr(x));
  return [toStr(v)];
}
function entityTarget(v: Value): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof (v as Record_).id === "number") return (v as Record_).id as number;
  throw new GolemError("failed", "expected an entity or entity id");
}
function durArg(v: Value | undefined, def: number): number { return v === undefined || v === null ? def : toDur(v); }
function arg(args: Value[], named: Map<string, Value>, i: number, name: string): Value | undefined {
  return i < args.length ? args[i] : named.get(name);
}

export function makeShemHost(rt: AgentRuntime): Host {
  const agent = rt.agent;
  const journal = new Journal(agent.workspaceDir);
  const P = (token: import("../primitives/errors.ts").CancelToken): P => makePrimitives(withToken(rt.ctx, token));
  const placesFile = resolve(agent.workspaceDir, "memory", "places.md");
  const readPlaces = (): ShemMap => {
    const m = new ShemMap();
    if (!existsSync(placesFile)) return m;
    for (const line of readFileSync(placesFile, "utf8").split("\n")) {
      const mm = /^-\s*([^:]+):\s*\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/.exec(line);
      if (mm) m.set(mm[1]!.trim(), new Vec3(Number(mm[2]), Number(mm[3]), Number(mm[4]), true));
    }
    return m;
  };
  const inventoryView = async (p: P): Promise<Record_> => {
    const inv = await p.inventory();
    return {
      count: ((item: Value) => inv.count(toStr(item))) as unknown as Value,
      has: ((item: Value, n: Value = 1) => inv.has(toStr(item), toNum(n))) as unknown as Value,
      slot_of: ((item: Value) => inv.slotsOf(toStr(item))[0]?.slot ?? null) as unknown as Value,
      items: inv.items.map((i) => ({ item: i.item, short: shortId(i.item), count: i.count, slot: i.slot })) as Value,
      free_slots: inv.freeSlots,
      held: inv.held ? shortId(inv.held.item) : null,
      armor: inv.armor.map((i) => shortId(i.item)),
    };
  };
  const containerView = (c: { handler: string; slots: { slot: number; item: string; count: number }[]; trades?: unknown[] }): Record_ => {
    const clean = (it: string) => it.replace(/\s+x\d+$/, "");
    const own = c.slots.slice(0, Math.max(0, c.slots.length - 36)).filter((s) => s.item && clean(s.item) !== "empty" && clean(s.item) !== "minecraft:air");
    return {
      handler: c.handler,
      slots: own.map((s) => ({ slot: s.slot, item: clean(s.item), name: shortId(clean(s.item)), short: shortId(clean(s.item)), count: s.count })) as Value,
      count: ((item: Value) => { const id = toStr(item).includes(":") ? toStr(item) : `minecraft:${toStr(item)}`; return own.filter((s) => clean(s.item) === id).reduce((a, s) => a + s.count, 0); }) as unknown as Value,
      trades: (c.trades ?? []) as Value,
    };
  };
  const posOf = (v: Value) => toPos(v).plain;
  const targetPos = async (p: P, v: Value): Promise<{ x: number; y: number; z: number }> => {
    if (typeof v === "string") {
      const e = (await p.entities({ radius: 64, kinds: ["player"] })).find((x) => x.name === v);
      if (!e) throw new GolemError("not_found", `${v} is not nearby`);
      return { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) };
    }
    if (v && typeof v === "object" && !(v instanceof Vec3) && typeof (v as Record_).id === "number") {
      const e = await p.entityById((v as Record_).id as number);
      if (!e) throw new GolemError("not_found", `entity #${(v as Record_).id} is not nearby`);
      return { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) };
    }
    return posOf(v);
  };

  const calls = new Map<string, HostFn>();
  const def = (name: string, fn: (p: P, args: Value[], named: Map<string, Value>) => Promise<Value> | Value) => {
    calls.set(name, (args, named, ctx) => fn(P(ctx.token), args, named));
  };

  // ---- perception ----
  def("block_at", async (p, a, n) => blockRecord(await p.blockAt(posOf(arg(a, n, 0, "pos") ?? null))));
  def("find_blocks", async (p, a, n) => {
    const kinds = kindsArg(arg(a, n, 0, "kinds")) ?? [];
    const hits = await p.findBlocks(kinds, { radius: toNum(arg(a, n, 1, "radius") ?? 32), max: toNum(arg(a, n, 2, "max") ?? 32) });
    return hits.map((h) => ({ block: h.block, name: shortId(h.block), short: shortId(h.block), pos: new Vec3(h.x, h.y, h.z, true), dist: h.dist }));
  });
  def("find_entities", async (p, a, n) => (await p.entities({ kinds: kindsArg(arg(a, n, 0, "kinds")), radius: toNum(arg(a, n, 1, "radius") ?? 16), hostileOnly: !!arg(a, n, 2, "hostile") })).map(entityRecord));
  def("nearest", async (p, a, n) => { const e = (await p.entities({ kinds: kindsArg(arg(a, n, 0, "kinds")), radius: toNum(arg(a, n, 1, "radius") ?? 16) }))[0]; return e ? entityRecord(e) : null; });
  def("nearest_player", async (p, a, n) => { const e = (await p.entities({ kinds: ["player"], radius: toNum(arg(a, n, 0, "radius") ?? 32) }))[0]; return e ? entityRecord(e) : null; });
  def("threats", async (p, a, n) => (await p.threats(toNum(arg(a, n, 0, "radius") ?? 12))).map(entityRecord));
  def("players", async (p) => (await p.players()).map((x) => x.name));
  def("craftable", async (p) => (await p.craftable()).map((c) => ({ item: c.item, short: shortId(c.item), count: c.count })));
  def("recipe", async (p, a, n) => (await p.recipes(toStr(arg(a, n, 0, "item") ?? ""))).map((r) => ({ result: r.result, count: r.count, needs_table: r.needsTable, ingredients: r.ingredients.map((i) => ({ item: i.item ?? i.tag ?? "", count: i.count })) })));
  def("target", async (p) => { const t = await p.target(); return { kind: t.kind, pos: t.x != null ? new Vec3(t.x, t.y!, t.z!, true) : null, block: t.block ?? null, entity_id: t.entityId ?? null, face: t.face ?? null }; });
  def("chat_history", async (p, a, n) => (await p.chatHistory(toNum(arg(a, n, 0, "limit") ?? 20))).map((l) => ({ sender: l.sender ?? null, text: l.text, kind: l.kind })));
  def("places", () => readPlaces());
  def("place_of", (_p, a, n) => readPlaces().get(toStr(arg(a, n, 0, "name") ?? "")) ?? null);
  def("chests_with", (_p, a, n) => chestsWith(agent.workspaceDir, toStr(arg(a, n, 0, "item") ?? "")).map((c) => ({ pos: new Vec3(c.x, c.y, c.z, true), items: new ShemMap(Object.entries(c.items)) })));
  def("path_exists", async (p, a, n) => (await p.navCheck(posOf(arg(a, n, 0, "pos") ?? null), toNum(arg(a, n, 1, "reach") ?? 1))).reachable);

  // ---- movement ----
  def("goto", async (p, a, n) => { const t = await targetPos(p, arg(a, n, 0, "target") ?? null); const r = await p.goto(t, { reach: toNum(arg(a, n, 1, "reach") ?? 1), timeoutMs: durArg(arg(a, n, 2, "timeout"), 60_000) }); return { arrived: r.arrived, pos: new Vec3(r.pos.x, r.pos.y, r.pos.z, false), distance: r.distance, ms: r.ms }; });
  def("goto_xz", async (p, a, n) => { const r = await p.gotoXZ(toNum(arg(a, n, 0, "x") ?? 0), toNum(arg(a, n, 1, "z") ?? 0), { reach: toNum(arg(a, n, 2, "reach") ?? 1) }); return { arrived: r.arrived, pos: new Vec3(r.pos.x, r.pos.y, r.pos.z, false) }; });
  def("goto_nearest", async (p, a, n) => { const r = await p.gotoNearestBlock(toStr(arg(a, n, 0, "kind") ?? ""), { timeoutMs: durArg(arg(a, n, 1, "timeout"), 90_000) }); return new Vec3(Math.floor(r.pos.x), Math.floor(r.pos.y), Math.floor(r.pos.z), true); });
  def("follow", async (p, a, n) => { const t = arg(a, n, 0, "target"); const d = toNum(arg(a, n, 1, "dist") ?? 3); if (typeof t === "string") await p.follow({ player: t }, d); else if (t && typeof t === "object") await p.follow({ entity: String((t as Record_).short ?? (t as Record_).type) }, d); else throw new GolemError("failed", "follow wants a player name or entity"); return null; });
  def("look_at", async (p, a, n) => { const t = arg(a, n, 0, "target"); const r = t && typeof t === "object" && !(t instanceof Vec3) && typeof (t as Record_).id === "number" ? await p.lookAt({ entityId: (t as Record_).id as number }) : await p.lookAt(toVec(t ?? null).plain); return { yaw: r.yaw, pitch: r.pitch }; });
  def("look", async (p, a, n) => { const r = await p.lookAt({ yaw: toNum(arg(a, n, 0, "yaw") ?? 0), pitch: toNum(arg(a, n, 1, "pitch") ?? 0) }); return { yaw: r.yaw, pitch: r.pitch }; });
  def("move", async (p, a, n) => { await p.move((arg(a, n, 0, "dir") as "forward" | "backward" | "left" | "right") ?? "forward", durArg(arg(a, n, 1, "dur"), 500), { sprint: !!arg(a, n, 2, "sprint"), jump: !!arg(a, n, 3, "jump") }); return null; });
  def("jump", async (p) => { await p.jump(); return null; });
  def("stop", async (p) => { await p.stop(); return null; });
  def("flee", async (p, a, n) => { const from = arg(a, n, 0, "from") ?? null; const pts = (Array.isArray(from) ? from : [from]).map((v) => toVec(v).plain); const r = await p.flee(pts, toNum(arg(a, n, 1, "dist") ?? 16)); return { pos: new Vec3(r.pos.x, r.pos.y, r.pos.z, false) }; });
  def("wander", async (p, a, n) => { const r = toNum(arg(a, n, 0, "radius") ?? 12); const m = rt.mirror.pos; const ang = Math.random() * Math.PI * 2; const res = await p.gotoXZ(m.x + Math.cos(ang) * r, m.z + Math.sin(ang) * r, { reach: 2, timeoutMs: 30_000 }); return { pos: new Vec3(res.pos.x, res.pos.y, res.pos.z, false) }; });
  def("explore", async (p, a, n) => { const d = arg(a, n, 0, "for"); await p.explore(d == null ? undefined : toDur(d)); return null; });
  def("goto_surface", async (p) => { const r = await p.surface(); return { y: r.y, rose: r.rose }; });

  // ---- actions ----
  def("mine", async (p, a, n) => { const r = await p.mine(posOf(arg(a, n, 0, "pos") ?? null), { collect: arg(a, n, 1, "collect") !== false }); return { broken: r.broken, block: r.block, ms: r.ms }; });
  def("mine_all", async (p, a, n) => { const r = await p.mineAll(toStr(arg(a, n, 0, "kind") ?? ""), toNum(arg(a, n, 1, "want") ?? 1), { timeoutMs: durArg(arg(a, n, 2, "timeout"), 300_000) }); return { got: r.got, item: r.item, ms: r.ms }; });
  def("place", async (p, a, n) => { const r = await p.place(toStr(arg(a, n, 0, "item") ?? ""), posOf(arg(a, n, 1, "pos") ?? null)); return { placed: r.placed }; });
  def("place_here", async (p, a, n) => { const at = await p.placeNearby(toStr(arg(a, n, 0, "item") ?? "")); return { placed: true, pos: new Vec3(at.x, at.y, at.z, true) }; });
  def("use_item", async (p, a, n) => { await p.useItem((arg(a, n, 0, "hand") as "main" | "off") ?? "main"); return null; });
  def("use_on", async (p, a, n) => { const t = arg(a, n, 0, "target") ?? null; if (t && typeof t === "object" && !(t instanceof Vec3) && typeof (t as Record_).id === "number") await p.interactEntity((t as Record_).id as number); else await p.useOnBlock(posOf(t)); return null; });
  def("attack", async (p, a, n) => { const r = await p.attack(entityTarget(arg(a, n, 0, "target") ?? null), { timeoutMs: durArg(arg(a, n, 1, "timeout"), 30_000) }); return { killed: r.killed, hits: r.hits }; });
  def("attack_nearest", async (p, a, n) => { const kinds = kindsArg(arg(a, n, 0, "kinds")); const es = await p.entities({ radius: toNum(arg(a, n, 1, "radius") ?? 16), kinds, hostileOnly: !kinds }); if (!es[0]) throw new GolemError("not_found", "nothing to attack"); const r = await p.attack(es[0].id); return { killed: r.killed, hits: r.hits, target: entityRecord(es[0]) }; });
  def("equip", async (p, a, n) => { await p.equip(toStr(arg(a, n, 0, "item") ?? "")); return null; });
  def("eat", async (p, a, n) => { const it = arg(a, n, 0, "item"); const r = await p.eat(it == null ? undefined : toStr(it)); return { ate: r.ate, food: r.food }; });
  def("eat_something", async (p) => { const r = await p.eat(); return { ate: r.ate, food: r.food }; });
  def("drop", async (p, a, n) => { const cnt = arg(a, n, 1, "n"); const r = await p.drop(toStr(arg(a, n, 0, "item") ?? ""), cnt == null ? undefined : toNum(cnt)); return { dropped: r.dropped }; });
  def("drop_all", async (p, a, n) => { const r = await p.drop(toStr(arg(a, n, 0, "item") ?? "")); return { dropped: r.dropped }; });
  def("give", async (p, a, n) => { const who = toStr(arg(a, n, 0, "player") ?? ""); const t = await targetPos(p, who); await p.goto(t, { reach: 2, timeoutMs: 60_000 }); await p.lookAt(t); const r = await p.drop(toStr(arg(a, n, 1, "item") ?? ""), toNum(arg(a, n, 2, "n") ?? 1)); return { dropped: r.dropped }; });
  def("craft", async (p, a, n) => { const r = await p.craft(toStr(arg(a, n, 0, "item") ?? ""), toNum(arg(a, n, 1, "n") ?? 1)); return { crafted: r.crafted, item: r.item }; });
  def("open", async (p, a, n) => containerView(await p.openContainer(posOf(arg(a, n, 0, "pos") ?? null))));
  def("close", async (p) => { await p.closeScreen(); return null; });
  def("deposit", async (p, a, n) => { const r = await p.deposit(toStr(arg(a, n, 0, "item") ?? "")); return { moved: r.moved }; });
  def("withdraw", async (p, a, n) => { const r = await p.withdraw(toStr(arg(a, n, 0, "item") ?? "")); return { moved: r.moved }; });
  def("smelt", async (p, a, n) => { const fuel = arg(a, n, 2, "fuel"); const r = await p.smelt(toStr(arg(a, n, 0, "item") ?? ""), toNum(arg(a, n, 1, "n") ?? 1), { fuel: fuel == null ? undefined : toStr(fuel) }); return { smelted: r.smelted, output: r.output }; });
  def("sleep", async (p, a, n) => { const r = await p.sleepInBed(toNum(arg(a, n, 0, "radius") ?? 24)); return { ok: r.ok, reason: r.reason ?? null, bed: r.bed ? new Vec3(r.bed.x, r.bed.y, r.bed.z, true) : null }; });
  def("collect_drops", async (p, a, n) => { const r = await p.collectDrops(toNum(arg(a, n, 0, "radius") ?? 6)); return { visited: r.visited }; });
  def("remember", (_p, a, n) => { const name = toStr(arg(a, n, 0, "name") ?? ""); const pos = arg(a, n, 1, "pos"); const at = pos == null ? rt.mirror.blockPos : posOf(pos); const note = arg(a, n, 2, "note"); mkdirSync(resolve(agent.workspaceDir, "memory"), { recursive: true }); appendFileSync(placesFile, `- ${name}: (${at.x}, ${at.y}, ${at.z}) ${rt.mirror.dimension.replace("minecraft:", "")}${note ? ` — ${toStr(note)}` : ""}\n`); return null; });
  def("baritone", async (p, a, n) => { await p.baritone(toStr(arg(a, n, 0, "command") ?? "")); return null; });
  def("screenshot", async (p) => (await p.screenshot()).path ?? "");

  // ---- speech, notes, time ----
  def("say", async (p, a, n) => { await p.say(toStr(arg(a, n, 0, "text") ?? "")); return null; });
  def("whisper", async (p, a, n) => { await p.whisper(toStr(arg(a, n, 0, "player") ?? ""), toStr(arg(a, n, 1, "text") ?? "")); return null; });
  def("note", (_p, a, n) => { journal.note(toStr(arg(a, n, 0, "text") ?? "")); return null; });
  def("dm", (_p, a, n) => { const bus = rt.drive?.bus; if (!bus) throw new GolemError("unsupported", "no agent bus in this fleet"); bus.send(agent.name, toStr(arg(a, n, 0, "agent") ?? ""), toStr(arg(a, n, 1, "text") ?? "")); return null; });
  def("agents", () => rt.drive?.bus ? rt.drive.bus.roster(agent.name) : "no agent bus in this fleet");
  calls.set("wait", async (a, n, ctx) => { const { sleep } = await import("../primitives/errors.ts"); await sleep(toDur(arg(a, n, 0, "dur") ?? null), ctx.token); return null; });

  // ---- pure helpers ----
  def("pos", (_p, a, n) => new Vec3(Math.floor(toNum(arg(a, n, 0, "x") ?? 0)), Math.floor(toNum(arg(a, n, 1, "y") ?? 0)), Math.floor(toNum(arg(a, n, 2, "z") ?? 0)), true));
  def("vec", (_p, a, n) => new Vec3(toNum(arg(a, n, 0, "x") ?? 0), toNum(arg(a, n, 1, "y") ?? 0), toNum(arg(a, n, 2, "z") ?? 0), false));
  def("len", (_p, a, n) => { const x = arg(a, n, 0, "x"); return Array.isArray(x) ? x.length : typeof x === "string" ? x.length : x instanceof ShemMap ? x.size : 0; });
  def("str", async (_p, a, n) => { const { show } = await import("./values.ts"); return show(arg(a, n, 0, "x") ?? null); });
  def("int", (_p, a, n) => { const x = arg(a, n, 0, "x"); if (typeof x === "number") return Math.floor(x); const v = parseInt(String(x), 10); if (isNaN(v)) throw new GolemError("failed", `int(): not a number: ${String(x)}`); return v; });
  def("float", (_p, a, n) => { const x = arg(a, n, 0, "x"); const v = typeof x === "number" ? x : parseFloat(String(x)); if (isNaN(v)) throw new GolemError("failed", `float(): not a number: ${String(x)}`); return v; });
  def("abs", (_p, a, n) => Math.abs(toNum(arg(a, n, 0, "x") ?? 0)));
  def("min", (_p, a, n) => Math.min(toNum(arg(a, n, 0, "a") ?? 0), toNum(arg(a, n, 1, "b") ?? 0)));
  def("max", (_p, a, n) => Math.max(toNum(arg(a, n, 0, "a") ?? 0), toNum(arg(a, n, 1, "b") ?? 0)));
  def("floor", (_p, a, n) => Math.floor(toNum(arg(a, n, 0, "x") ?? 0)));
  def("round", (_p, a, n) => Math.round(toNum(arg(a, n, 0, "x") ?? 0)));
  def("random", (_p, a, n) => { const k = toNum(arg(a, n, 0, "n") ?? 1); return Number.isInteger(k) && k > 1 ? Math.floor(Math.random() * k) : Math.random() * k; });
  def("range", (_p, a, n) => { const x = toNum(arg(a, n, 0, "n") ?? 0); const m = arg(a, n, 1, "m"); const [lo, hi] = m == null ? [0, x] : [x, toNum(m)]; return Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i); });
  def("item_of", (_p, a, n) => { const b = rt.ctx.mc.blocksByName[shortId(toStr(arg(a, n, 0, "block") ?? ""))]; const d = b?.drops?.[0]; return typeof d === "number" ? (rt.ctx.mc.items[d]?.name ?? b!.name) : (b?.name ?? toStr(arg(a, n, 0, "block") ?? "")); });
  def("dur", (_p, a, n) => new Dur(toNum(arg(a, n, 0, "ms") ?? 0)));

  // ---- getters ----
  const m = rt.mirror;
  const getters = new Map<string, (ctx: { token: import("../primitives/errors.ts").CancelToken }) => Promise<Value> | Value>([
    ["here", () => new Vec3(m.blockPos.x, m.blockPos.y, m.blockPos.z, true)],
    ["eye", () => new Vec3(m.eye.x, m.eye.y, m.eye.z, false)],
    ["me", () => ({ id: -1, type: "minecraft:player", short: "player", name: agent.body.username, pos: new Vec3(m.pos.x, m.pos.y, m.pos.z, false), dist: 0, hostile: false, is_player: true, is_item: false, health: m.health })],
    ["yaw", () => m.yaw], ["pitch", () => m.pitch],
    ["health", () => m.health], ["food", () => m.food],
    ["air", () => m.status?.player?.air ?? 300],
    ["xp", () => m.status?.player?.xpLevel ?? 0],
    ["dimension", () => m.dimension.replace("minecraft:", "")],
    ["gamemode", () => m.status?.player?.gamemode ?? "survival"],
    ["phase", () => m.phase ?? "day"],
    ["is_day", () => m.phase === undefined || m.phase === "day" || m.phase === "dawn"],
    ["weather", () => m.weather ?? "clear"],
    ["time", () => m.status?.world?.time ?? 0],
    ["now", () => Date.now()],
    ["inventory", (ctx) => inventoryView(P(ctx.token))],
    ["container", async (ctx) => containerView(await P(ctx.token).container())],
    ["idle", () => !rt.ctx.activity.busy && !m.navActive],
  ]);

  // ---- events: Shem event names -> body events ----
  const b = rt.body;
  const onEvent: Host["onEvent"] = (name, handler) => {
    const wrap = (mapper: (d: any) => Value[] | null) => (d: unknown) => { const v = mapper(d); if (v) handler(v); };
    switch (name) {
      case "tick": return b.on("tick", wrap(() => []));
      case "health": return b.on("health", wrap((d) => [d.health, d.food]));
      case "damage": return b.on("damage", wrap((d) => [d.amount, d.health, m.lastAttacker && Date.now() - m.lastAttacker.at < 3000 ? m.lastAttacker.type : null]));
      case "death": return b.on("death", wrap(() => []));
      case "respawn": return b.on("respawn", wrap(() => []));
      case "chat": return b.on("chat", wrap((d) => d.sender && d.sender !== agent.body.username ? [d.sender, d.text, d.kind] : null));
      case "whisper": return b.on("chat", wrap((d) => d.kind === "whisper" && d.sender ? [d.sender, d.text] : null));
      case "player_join": return b.on("join", wrap((d) => [d.name]));
      case "player_leave": return b.on("leave", wrap((d) => [d.name]));
      case "entity_near": return b.on("entitySpawn", wrap((d) => [{ id: d.id, type: d.type, short: shortId(d.type), pos: new Vec3(d.x, d.y, d.z, false), dist: Math.hypot(d.x - m.pos.x, d.y - m.pos.y, d.z - m.pos.z), hostile: rt.ctx.mc.entitiesByName[shortId(d.type)]?.type === "hostile", is_player: shortId(d.type) === "player", is_item: shortId(d.type) === "item", name: shortId(d.type), health: null }]));
      case "entity_gone": return b.on("entityRemove", wrap((d) => [d.id]));
      case "block_changed": return b.on("blockUpdate", wrap((d) => [new Vec3(d.x, d.y, d.z, true), d.from, d.to]));
      case "item_picked": return b.on("itemPickup", wrap((d) => [d.item, d.count]));
      case "inventory_changed": return b.on("inventory", wrap(() => []));
      case "screen_open": return b.on("screenOpen", wrap((d) => [d.screen]));
      case "screen_close": return b.on("screenClose", wrap(() => []));
      case "nav_done": return b.on("nav.done", wrap((d) => [new Vec3(d.x, d.y, d.z, true)]));
      case "nav_failed": return b.on("nav.failed", wrap((d) => [d.reason ?? "unknown"]));
      case "time": return b.on("time", wrap((d) => [d.phase]));
      case "weather": return b.on("weather", wrap((d) => [d.kind]));
      case "stuck": { const t = setInterval(() => { if (m.navActive && !m.movedRecently(15_000)) handler([Math.round((Date.now() - m.lastMoveAt) / 1000)]); }, 5000); return () => clearInterval(t); }
      case "run_done": case "run_failed": return () => {};   // wired by the run manager
      default: return () => {};
    }
  };

  return { calls, getters, onEvent };
}

/** Registry adapter for the checker, backed by minecraft-data. */
export function makeRegistry(rt: AgentRuntime): import("./checker.ts").Registry {
  const mc = rt.ctx.mc;
  const tables = { block: mc.blocksByName, item: mc.itemsByName, entity: mc.entitiesByName } as Record<string, Record<string, unknown>>;
  return {
    has: (kind, id) => id in tables[kind]!,
    suggest: (kind, id) => Object.keys(tables[kind]!).filter((k) => k.includes(id) || id.includes(k) || levenshtein(k, id) <= 2).slice(0, 3),
  };
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]) as number[][];
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m]![n]!;
}
