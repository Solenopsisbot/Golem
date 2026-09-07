// The primitive table: every function and root value a Shem script can use, with typed parameters
// and one-line docs. The checker validates calls against it, the interpreter dispatches through it,
// and `shem_doc` / the orientation cheatsheet render it. The host (host.ts) supplies the bodies.

export type ShemType = "int" | "float" | "number" | "bool" | "string" | "dur" | "pos" | "vec" | "block" | "item" | "entity" | "player" | "list" | "map" | "function" | "any";

export interface ParamSpec { name: string; type: ShemType; def?: string; required?: boolean; doc?: string }
export interface BuiltinSpec {
  name: string;
  params: ParamSpec[];
  returns: string;
  doc: string;
  /** Talks to the world and may take a while (counts as an await point for the spin check). */
  blocking: boolean;
  /** Not implemented by the host yet: the checker warns, the runtime throws `unsupported`. */
  stub?: boolean;
}
export interface GetterSpec { name: string; returns: string; doc: string }

const p = (name: string, type: ShemType, def?: string, doc?: string): ParamSpec => ({ name, type, def, required: def === undefined, doc });

export const GETTERS: GetterSpec[] = [
  { name: "here", returns: "pos", doc: "Your feet block position." },
  { name: "eye", returns: "vec", doc: "Your eye position." },
  { name: "me", returns: "entity", doc: "Your own entity record (id, pos, health...)." },
  { name: "yaw", returns: "float", doc: "Head yaw in degrees." },
  { name: "pitch", returns: "float", doc: "Head pitch in degrees (down is positive)." },
  { name: "health", returns: "float", doc: "Health, 0..20." },
  { name: "food", returns: "int", doc: "Hunger, 0..20." },
  { name: "air", returns: "int", doc: "Air ticks left (300 = full)." },
  { name: "xp", returns: "int", doc: "Experience level." },
  { name: "dimension", returns: "string", doc: "overworld | the_nether | the_end." },
  { name: "gamemode", returns: "string", doc: "survival | creative | adventure | spectator." },
  { name: "phase", returns: "string", doc: "dawn | day | dusk | night." },
  { name: "is_day", returns: "bool", doc: "True during dawn and day." },
  { name: "weather", returns: "string", doc: "clear | rain | thunder." },
  { name: "time", returns: "int", doc: "World time in ticks." },
  { name: "now", returns: "int", doc: "Wall-clock milliseconds; for measuring durations." },
  { name: "inventory", returns: "inventory", doc: "Inventory view: .count(item) .has(item, n) .items .free_slots .held .armor" },
  { name: "container", returns: "container", doc: "The open container: .slots .count(item) .trades" },
  { name: "idle", returns: "bool", doc: "True when nothing is moving or being mined." },
];

export const BUILTINS: BuiltinSpec[] = [
  // ---- perception ----------------------------------------------------------------
  { name: "block_at", params: [p("pos", "pos")], returns: "block", doc: "Block record at a position: .name (\"stone\") .id (\"minecraft:stone\") .air .solid .liquid .pos", blocking: true },
  { name: "find_blocks", params: [p("kinds", "block"), p("radius", "int", "32"), p("max", "int", "32")], returns: "list<block>", doc: "Nearest blocks of a kind (or list of kinds), nearest first; each has .pos .block .dist", blocking: true },
  { name: "find_entities", params: [p("kinds", "entity", "none"), p("radius", "float", "16"), p("hostile", "bool", "false")], returns: "list<entity>", doc: "Nearby entities, nearest first: .id .type .short .name .pos .dist .hostile .health", blocking: true },
  { name: "nearest", params: [p("kinds", "entity", "none"), p("radius", "float", "16")], returns: "entity?", doc: "Nearest entity of the kinds, or none.", blocking: true },
  { name: "nearest_player", params: [p("radius", "float", "32")], returns: "entity?", doc: "Nearest other player, or none.", blocking: true },
  { name: "threats", params: [p("radius", "float", "12")], returns: "list<entity>", doc: "Hostile entities within radius, nearest first.", blocking: true },
  { name: "players", params: [], returns: "list<string>", doc: "Names on the tab list.", blocking: true },
  { name: "craftable", params: [], returns: "list<record>", doc: "What the inventory can craft now: .item .count", blocking: true },
  { name: "recipe", params: [p("item", "item")], returns: "list<record>", doc: "Recipes producing an item.", blocking: true },
  { name: "target", params: [], returns: "record", doc: "What the crosshair is on: .kind .pos .block .entity_id", blocking: true },
  { name: "chat_history", params: [p("limit", "int", "20")], returns: "list<record>", doc: "Recent chat lines: .sender .text", blocking: true },
  { name: "places", params: [], returns: "map", doc: "Named places from memory/places.md (name -> pos).", blocking: false },
  { name: "place_of", params: [p("name", "string")], returns: "pos?", doc: "A named place, or none.", blocking: false },
  { name: "chests_with", params: [p("item", "item")], returns: "list<record>", doc: "Indexed chests holding an item: .pos .items", blocking: false },
  { name: "path_exists", params: [p("pos", "pos"), p("reach", "int", "1")], returns: "bool", doc: "Quick reachability estimate (walk-only A*).", blocking: true },

  // ---- movement --------------------------------------------------------------------
  { name: "goto", params: [p("target", "any"), p("reach", "int", "1"), p("timeout", "dur", "60s")], returns: "record", doc: "Path to a pos/entity/player name; resolves on arrival within reach.", blocking: true },
  { name: "goto_xz", params: [p("x", "number"), p("z", "number"), p("reach", "int", "1")], returns: "record", doc: "Path to an XZ column at any height.", blocking: true },
  { name: "goto_nearest", params: [p("kind", "block"), p("timeout", "dur", "90s")], returns: "pos", doc: "Walk next to the nearest block of a kind (Baritone scan).", blocking: true },
  { name: "follow", params: [p("target", "any"), p("dist", "float", "3")], returns: "none", doc: "Follow a player name or entity until stop(). Returns immediately.", blocking: true },
  { name: "look_at", params: [p("target", "any")], returns: "record", doc: "Face a pos or entity.", blocking: true },
  { name: "look", params: [p("yaw", "number"), p("pitch", "number")], returns: "record", doc: "Set head angles.", blocking: true },
  { name: "move", params: [p("dir", "string", '"forward"'), p("dur", "dur", "500ms"), p("sprint", "bool", "false"), p("jump", "bool", "false")], returns: "none", doc: "Raw walking input for a duration.", blocking: true },
  { name: "jump", params: [], returns: "none", doc: "Jump once.", blocking: true },
  { name: "stop", params: [], returns: "none", doc: "Stop moving, mining, pathing, using.", blocking: true },
  { name: "flee", params: [p("from", "any"), p("dist", "float", "16")], returns: "record", doc: "Move away from a pos, entity or list of them.", blocking: true },
  { name: "wander", params: [p("radius", "int", "12")], returns: "record", doc: "Walk to a random nearby XZ.", blocking: true },
  { name: "surface", params: [p("timeout", "dur", "none")], returns: "int", doc: "Dig and climb to open sky from wherever you are (buried, in a cave). Returns the y you ended at. Fails if it can't get there in time.", blocking: true },
  { name: "explore", params: [p("for", "dur", "none")], returns: "none", doc: "Baritone explore. explore(for: 2m) blocks that long then stops; without `for` it returns at once and runs until stop().", blocking: true },
  { name: "goto_surface", params: [], returns: "record", doc: "Climb to the surface: .y .rose. Fails with `unreachable` when sealed in.", blocking: true },
  { name: "dig_down", params: [p("n", "int"), p("max_drop", "int", "3")], returns: "record", doc: "Sink straight down n blocks, one swing per block. Fast way to depth (a staircase costs 3 mines and a path-find per block). Looks before every swing and STOPS rather than dying: .dug .stopped .pos — `stopped` is \"done\", or why it halted (lava below, a long drop, stuck).", blocking: true },
  { name: "tunnel", params: [p("dir", "string"), p("n", "int")], returns: "none", doc: "Tunnel n blocks in a direction.", blocking: true, stub: true },

  // ---- actions ---------------------------------------------------------------------
  { name: "mine", params: [p("pos", "pos"), p("collect", "bool", "true")], returns: "record", doc: "Break one block (walks there, best tool, collects the drop).", blocking: true },
  { name: "mine_all", params: [p("kind", "block"), p("want", "int", "1"), p("timeout", "dur", "5m")], returns: "record", doc: "Baritone mines a block kind until `want` of its drop are collected: .got .item. Good for common blocks (stone, logs); for ore you can already see, `for (b of find_blocks(kind)) mine(b.pos)` is faster and won't wander.", blocking: true },
  { name: "place", params: [p("item", "item"), p("pos", "pos")], returns: "record", doc: "Place an item so it occupies pos.", blocking: true },
  { name: "place_here", params: [p("item", "item")], returns: "record", doc: "Place an item on a free spot next to you (north/east/south/west, needs ground under it): .pos is where it went.", blocking: true },
  { name: "use_item", params: [p("hand", "string", '"main"')], returns: "none", doc: "Right-click with what you hold.", blocking: true },
  { name: "use_hold", params: [p("ticks", "int", "25")], returns: "none", doc: "Hold right-click for `ticks` (20 = 1 s), then you must use_release. Bows, tridents, crossbows.", blocking: true },
  { name: "use_release", params: [], returns: "none", doc: "Let go of right-click (after use_hold).", blocking: true },
  { name: "shoot", params: [p("target", "any"), p("shots", "int", "1"), p("charge", "int", "25")], returns: "int", doc: "Draw your bow at an entity or a position and loose; returns shots fired. Needs a bow and arrows. NO LEAD and no drop compensation, so it only hits things that are still or coming straight at you (crystals, a perched dragon). For anything moving, use `shoot_at`, which aims on the body at 20 Hz.", blocking: true },
  { name: "use_on", params: [p("target", "any")], returns: "none", doc: "Right-click a block pos or entity.", blocking: true },
  { name: "attack", params: [p("target", "any"), p("timeout", "dur", "30s")], returns: "record", doc: "Fight an entity (or id) until it's gone: .killed .hits. One round-trip per swing, and it hits the entity you name — so it does NOTHING to a multi-part boss like the ender dragon, whose parent entity ignores damage. For a boss, or anything worth killing quickly, use `melee_while`.", blocking: true },
  { name: "shoot_at", params: [p("target", "any"), p("shots", "int", "1"), p("lead", "bool", "true"), p("charge", "int", "25"), p("max_range", "float", "64")], returns: "record", doc: "Bow the target with the aiming loop running ON THE BODY at 20 Hz: it tracks the entity every tick, leads from its real velocity and solves the arrow's drop. Use this on anything that moves - aiming from a script costs ~1.5s a shot and misses. Returns .fired .hits .damage .killed .stopped", blocking: true },
  { name: "melee_while", params: [p("target", "any"), p("max_ms", "int", "5000"), p("reach", "float", "3.5"), p("stop_below_health", "float", "0")], returns: "record", doc: "Swing at the target on the body's attack-cooldown cadence while it stays in reach. Resolves multi-part entities (the dragon) properly. Returns .fired .hits .damage .killed .stopped", blocking: true },
  { name: "combat_stop", params: [], returns: "record", doc: "Cut short a running shoot_at / melee_while.", blocking: true },
  { name: "attack_nearest", params: [p("kinds", "entity", "none"), p("radius", "float", "16")], returns: "record", doc: "Fight the nearest entity of the kinds (hostiles when omitted).", blocking: true },
  { name: "equip", params: [p("item", "item")], returns: "none", doc: "Equip armor/shield or move a tool to hand.", blocking: true },
  { name: "eat", params: [p("item", "item", "none")], returns: "record", doc: "Eat a named food, or the best you carry.", blocking: true },
  { name: "eat_something", params: [], returns: "record", doc: "Eat the best food you carry.", blocking: true },
  { name: "drop", params: [p("item", "item"), p("n", "int", "none")], returns: "record", doc: "Drop n of an item (all stacks when n omitted).", blocking: true },
  { name: "drop_all", params: [p("item", "item")], returns: "record", doc: "Drop every stack of an item.", blocking: true },
  { name: "give", params: [p("player", "player"), p("item", "item"), p("n", "int", "1")], returns: "record", doc: "Walk to a player and drop items at them.", blocking: true },
  { name: "craft", params: [p("item", "item"), p("n", "int", "1")], returns: "record", doc: "Craft an item: .crafted", blocking: true },
  { name: "smelt", params: [p("item", "item"), p("n", "int", "1"), p("fuel", "item", "none")], returns: "record", doc: "Smelt n of an item in a furnace nearby (or placed from inventory): .smelted .output", blocking: true },
  { name: "open", params: [p("pos", "pos")], returns: "container", doc: "Open a container block.", blocking: true },
  { name: "close", params: [], returns: "none", doc: "Close the open screen.", blocking: true },
  { name: "deposit", params: [p("item", "item")], returns: "record", doc: "All of an item into the open container.", blocking: true },
  { name: "withdraw", params: [p("item", "item")], returns: "record", doc: "All of an item out of the open container.", blocking: true },
  { name: "trade", params: [p("villager", "any"), p("index", "int"), p("n", "int", "1")], returns: "record", doc: "Trade with a villager.", blocking: true, stub: true },
  { name: "sleep", params: [p("radius", "int", "24")], returns: "record", doc: "Sleep in a bed within radius (or place one you carry): .ok .reason", blocking: true },
  { name: "collect_drops", params: [p("radius", "float", "6")], returns: "record", doc: "Walk over nearby dropped items.", blocking: true },
  { name: "remember", params: [p("name", "string"), p("pos", "pos", "here"), p("note", "string", '""')], returns: "none", doc: "Save a named place.", blocking: false },
  { name: "baritone", params: [p("command", "string")], returns: "none", doc: "Raw Baritone command.", blocking: true },
  { name: "screenshot", params: [], returns: "string", doc: "Take a screenshot; returns the file path.", blocking: true },

  // ---- speech, notes, time ----------------------------------------------------------
  { name: "say", params: [p("text", "string")], returns: "none", doc: "One line of chat (rate-limited).", blocking: true },
  { name: "whisper", params: [p("player", "player"), p("text", "string")], returns: "none", doc: "Private message.", blocking: true },
  { name: "dm", params: [p("agent", "string"), p("text", "string")], returns: "none", doc: "Message another golem in this fleet (capped per pair).", blocking: true },
  { name: "agents", params: [], returns: "string", doc: "The other golems in this fleet and their state lines.", blocking: false },
  { name: "note", params: [p("text", "string")], returns: "none", doc: "Append to today's journal.", blocking: false },
  { name: "wait", params: [p("dur", "dur")], returns: "none", doc: "Sleep.", blocking: true },

  // ---- pure helpers -------------------------------------------------------------------
  { name: "pos", params: [p("x", "number"), p("y", "number"), p("z", "number")], returns: "pos", doc: "Make a block position.", blocking: false },
  { name: "vec", params: [p("x", "number"), p("y", "number"), p("z", "number")], returns: "vec", doc: "Make a world point.", blocking: false },
  { name: "len", params: [p("x", "any")], returns: "int", doc: "Length of a list or string.", blocking: false },
  { name: "str", params: [p("x", "any")], returns: "string", doc: "Render a value as text.", blocking: false },
  { name: "int", params: [p("x", "any")], returns: "int", doc: "To integer (floors numbers, parses strings).", blocking: false },
  { name: "float", params: [p("x", "any")], returns: "float", doc: "To float.", blocking: false },
  { name: "abs", params: [p("x", "number")], returns: "number", doc: "", blocking: false },
  { name: "min", params: [p("a", "number"), p("b", "number")], returns: "number", doc: "", blocking: false },
  { name: "max", params: [p("a", "number"), p("b", "number")], returns: "number", doc: "", blocking: false },
  { name: "floor", params: [p("x", "number")], returns: "int", doc: "", blocking: false },
  { name: "round", params: [p("x", "number")], returns: "int", doc: "", blocking: false },
  { name: "random", params: [p("n", "number", "1")], returns: "number", doc: "Random in [0, n); integer when n is an integer > 1.", blocking: false },
  { name: "range", params: [p("n", "int"), p("m", "int", "none")], returns: "list<int>", doc: "range(n) = 0..n-1; range(a, b) = a..b-1", blocking: false },
  { name: "item_of", params: [p("block", "block")], returns: "item", doc: "The item a block drops (oak_log -> oak_log, stone -> cobblestone).", blocking: false },
  { name: "dur", params: [p("ms", "number")], returns: "dur", doc: "Milliseconds to a duration.", blocking: false },
];

export const BUILTIN_BY_NAME = new Map(BUILTINS.map((b) => [b.name, b]));
export const GETTER_BY_NAME = new Map(GETTERS.map((g) => [g.name, g]));

/** Events usable in `on` handlers and `reflex` declarations, with the argument names they bind. */
export const EVENTS: Record<string, string[]> = {
  tick: [],
  health: ["hp", "food"],
  damage: ["amount", "hp", "source"],
  death: [],
  respawn: [],
  chat: ["sender", "text", "kind"],
  whisper: ["sender", "text"],
  player_join: ["name"],
  player_leave: ["name"],
  entity_near: ["entity"],
  entity_gone: ["id"],
  block_changed: ["pos", "from", "to"],
  item_picked: ["item", "count"],
  inventory_changed: [],
  screen_open: ["kind"],
  screen_close: [],
  nav_done: ["pos"],
  nav_failed: ["reason"],
  run_done: ["run"],
  run_failed: ["run", "error"],
  time: ["phase"],
  weather: ["kind"],
  stuck: ["seconds"],
};

/** Render a builtin's signature for docs and errors. */
export function signature(b: BuiltinSpec): string {
  const ps = b.params.map((x) => `${x.name}: ${x.type}${x.def !== undefined ? ` = ${x.def}` : ""}`).join(", ");
  return `${b.name}(${ps}): ${b.returns}`;
}
