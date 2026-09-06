# Requests for MezzoSopranoClef

What Golem needs from the body that it doesn't have today, in priority order, with proposed shapes so they can go straight into `CoreCommands`/`ActionCommands`/`UiCommands` + `ApiSchema`. Numbers are referenced from SHEM.md and MCP-TOOLS.md.

Current state for reference: 55 commands, 18 events, protocol 1 at `main`. What exists is solid; the gaps are all "the client knows this, but doesn't expose it".

**Status 2026-09-06:** a separate agent is implementing this list in MezzoSopranoClef. Its uncommitted `clients/schema.json` (protocol 2, 68 commands, 30 events) already defines `findBlocks`, `blocksIn`, `craft`, `recipes`, `craftable`, `nav.check`, `goto.reach`, `mine.wait` + `mineDone`, `place.item/confirm`, `entities.kinds`, `lookAt`, `target`, `registry`, `moveToHotbar`, `chatHistory`, `whisper`, `batch`, screenshot `mode`/`annotate`, and the events `nav.done`, `nav.failed`, `entityHurt`, `itemPickup`, `inventory`, `blockUpdate`, `explosion`, `weather`, `time`, `sleep`, `title`. Golem's primitives are already wired to those exact names behind capability checks (`body.caps`), so they switch on the moment a launcher jar with that build is in place. Items 4 and 5 (richer `entities`/`status` fields) and 16 (Baritone log capture) are the ones not visible in that schema yet.

## P0: blockers. Without these the agent is blind or can't make tools.

### 1. `findBlocks` and `blocksIn`
The single biggest gap. `blockAt` is one block per round-trip; finding a tree in a 32-block radius that way is 270,000 calls. Baritone already does chunk scans internally, and the client chunk cache is right there.

```
findBlocks {ids: string[], radius?: int=32, max?: int=32, sort?: "nearest"|"none"}
  -> [{x,y,z,block}]              nearest first, from the loaded chunk cache, capped by max
blocksIn {minX,minY,minZ,maxX,maxY,maxZ, palette?: bool=true}
  -> {palette:[ids...], data:"<base64 varint indices, x-major>", size:[dx,dy,dz]}
                                    hard cap on volume (e.g. 64^3); BAD_ARGS above it
```
Accept `#minecraft:logs` tags in `ids` if cheap (`Registries.BLOCK` + tag lookup), because "any log" is the common question.

### 2. `craft`, `recipes`, `craftable`
There is no crafting today except grid-clicking through `clickSlot`, which is fragile and slow. The client has the recipe book and `ClientPlayerInteractionManager.clickRecipe(syncId, recipe, craftAll)`.

```
craft {item: string, count?: int=1, all?: bool}   -> {crafted: int, item}
      uses the open crafting screen if any, else the 2x2 player grid; NOT_FOUND if no recipe fits
recipes {item: string}                             -> [{result, count, ingredients:[{item|tag,count}], needsTable}]
craftable {}                                       -> [{item, count}]  what the inventory can make right now
```

### 7. Navigation completion events and `reach`
`goto` returns `{pathing:true}` immediately and scripts must poll `nav.status`. Baritone fires `PathEvent`s; forward them.

```
event nav.done   {x,y,z}                  goal reached
event nav.failed {reason}                 CALC_FAILED / CANCELLED / TIMEOUT / no path
goto {x,y,z, reach?: int=1}               GoalNear when reach>1, GoalBlock/GoalXZ otherwise
nav.check {x,y,z, reach?: int=1}          -> {reachable: bool, cost?: double}   path calc only, nothing moves
```

## P1: needed for a competent survival bot

### 4. Richer `entities`
Add per entity where applicable: `health`, `maxHealth`, `hostile` (MobCategory MONSTER or currently targeting us), `baby`, `held` (main hand item id), `armor`, `velocity`, `onFire`, `villager` `{profession, level}`, `item` `{id,count}` for item entities, `owner` for tamed, `lookingAtMe` (dot product of look vector). Optional `kinds` filter so `entities {kinds:["zombie","skeleton"]}` is cheap.

### 5. Richer `status`
Add: `time` (world time, day number, phase), `weather` (`clear|rain|thunder`), `biome`, `gamemode`, `light` (block and sky at feet), `inWater`, `inLava`, `onFire`, `sleeping`, `fallDistance`, `air`, `effects:[{id,amplifier,ticks}]`, `armor:[ids]`, `offhand`, `absorption`, `saturation`.

### 8. More events
```
blockUpdate  {x,y,z,from,to}       within N blocks (config, default 8), only when subscribed
itemPickup   {item,count}          from the pickup packet / inventory diff
inventory    {changed:[slots]}     coalesced per tick
entityHurt   {id, amount, attacker?}   includes ourselves (attacker id is what self_defense needs)
explosion    {x,y,z,power}
weather      {kind}
time         {phase}               dawn/day/dusk/night transitions only
sleep        {ok:bool, reason?}
title        {title,subtitle,actionBar}   when they change
chat         add `raw` (the JSON component) and make `kind` an enum: chat|system|whisper|team|actionbar
```

### 9. `mine` and `place` completion
`mine` should emit `mineDone {x,y,z,broken:bool,reason?}` (or take `wait:true`) so scripts don't poll `blockAt`, and expose `cant_break` (bedrock / wrong tool / gave up after MAX_MINING_TICKS) as a reason. `place` should report whether the block state actually changed (`placed` today is always true).

### 10. `place` with item selection, `moveToHotbar`
```
place {x,y,z,face?, item?}         if item given: select it (from hotbar, else swap into hotbar), then place
moveToHotbar {item, slot?: int}    -> {slot}   the swap that `equip`-style helpers already do internally
```

### 6. `target`
What is under the crosshair within reach: `{kind:"block"|"entity"|"none", x,y,z, block?, entityId?, face?}`. `MinecraftClient.crosshairTarget` already has it.

### 16. Capture Baritone's log output (small, high value)
Baritone prints everything interesting (`find` results, `eta`, "No known locations of ...", build progress, missing materials) through `Settings.logger` (a `Consumer<Component>`) straight into the local chat HUD, which the control plane never sees. Replace it from the reflective bridge and forward:

```
event baritone.log {text}          every line Baritone would have printed
baritone {command}  -> {ran, backend, output?: [lines received within ~250 ms]}
```
With this, `#find oak_log` becomes a usable `findBlocks` stand-in and every Baritone process becomes observable. One setter on `BaritoneAPI.getSettings().logger.value`, one event.

## P2: quality of life

### 11. `registry`
`{blocks:[ids], items:[ids], entities:[ids], tags?:{...}}` for the running version, so Golem's checker can validate against the truth rather than `minecraft-data` (which does have 1.21.8 tables, so this is a nice-to-have).

### 12. Screenshot extras
- `screenshot {..., annotate?: bool}` returning, alongside the PNG, the camera parameters and the screen-space boxes of visible entities so Golem can draw labels. Or just return the camera and Golem projects.
- An orthographic top-down mode for the software raycaster: `screenshot {mode:"topdown", centerX, centerZ, radius}`. The raycaster already has the voxel snapshot; this is a different camera.

### 13. `lookAt`
`lookAt {x,y,z} | {entityId}` computing yaw and pitch from the actual eye height. Golem can compute this from `status`, so low priority.

### 14. `chat` history and `whisper` helper
`chatHistory {limit}` for a bot that just woke up, and `whisper {player,text}` so Golem doesn't assume `/msg` exists on every server.

### 17. Readable screen names
Outside a dev (Loom) run the client is obfuscated, so `status.screen` and `screenOpen.screen` come back as `class_424`, not `TitleScreen`. Golem can't tell "on the title screen" from "connecting" from "dead". Map the common ones by `instanceof`: `title | connect | disconnected | death | downloading | inventory | container | crafting | furnace | anvil | enchanting | merchant | sign | book | other`, and keep the raw class name in a second field.

### 18. Baritone commands with a block argument deadlock the client (confirmed)
`baritone {command:"goto jungle_log"}` (and by the same path `mine <block>`, `sel fill <block>`, anything parsed through `ForBlockOptionalMeta`) parks the render thread forever; every later main-thread command times out until the JVM is killed. Coordinates (`goto 106 89 120`) are fine. Thread dump from the production launcher jar, Baritone 1.15.0, noGl, 2026-09-06:

```
"Render thread" WAITING (parking)
  java.util.concurrent.CompletableFuture.join
  baritone.api.utils.BlockOptionalMeta$ServerLevelStub.method_30349(BlockOptionalMeta.java:285)
  baritone.api.utils.BlockOptionalMeta$ServerLevelStub.holder(BlockOptionalMeta.java:289)
  baritone.api.utils.BlockOptionalMeta.getDrops(BlockOptionalMeta.java:255)
  baritone.api.utils.BlockOptionalMeta.drops(BlockOptionalMeta.java:226)      <- locked BlockOptionalMeta.class
  baritone.api.utils.BlockOptionalMeta.getStackHashes(BlockOptionalMeta.java:161)
  baritone.api.utils.BlockOptionalMeta.<init>(BlockOptionalMeta.java:108)
  baritone.api.command.datatypes.ForBlockOptionalMeta.get(ForBlockOptionalMeta.java:46)
  baritone.command.defaults.GotoCommand.execute(GotoCommand.java:55)
  baritone.command.manager.CommandManager.execute(CommandManager.java:78)
  dev.mezzo.clef ... `baritone` command via ctx.onMain
```

Baritone's first `BlockOptionalMeta` builds a stub server level to run loot tables (block drops) and `join()`s a future that needs the thread it is blocking. Options, cheapest first: (a) warm it once off the main thread at startup (`new BlockOptionalMeta(Blocks.STONE)` on a worker, which populates the static cache so later calls never block); (b) run the `baritone` passthrough's `execute` off the main thread for commands whose first argument isn't numeric; (c) check whether `-Dmax.bg.threads`/`CLEF_BG_THREADS=4` starves the loader and raise it. Golem treats `gotoNearestBlock`/`mineAll` as unsafe until one of these lands and relies on `findBlocks` (#1) instead.

### 15. `batch`
`batch {commands:[{cmd,args}]}` executed in order on the main thread, returning an array of results. Cuts round-trips for inventory manipulation sequences.

## What Baritone already covers (no Clef change needed)

Verified against the bundled Baritone 1.15.0 jar: `axis blacklist build click come eta elytra explore explorefilter farm find follow forcecancel gc goal goto help invert litematica mine path pickup proc reloadall render repack saveall schematica sel set surface thisway tunnel version waypoints`.

| Need | Baritone | Status in Golem |
|---|---|---|
| go to the nearest block of a kind | `goto <block>` (own chunk scan) | `gotoNearestBlock` primitive, done |
| mine N of a block kind | `mine <n> <block>` | `mineAll` primitive, done |
| follow a player / entity type | `follow player <name>`, `follow entity <type>`, `set followRadius` | `follow` primitive, done |
| reach the surface, tunnel, explore | `surface`, `tunnel`, `explore` | `surface`/`explore` done |
| farm crops | `farm [range]` | trivial to add |
| pick up drops | `pickup` | `collectDrops` is Golem-side today; can switch |
| named places | `waypoints` (`wp save/goto`) | Golem keeps its own in memory/places, may mirror |
| build from a schematic | `build <file> [x y z]` reads `<gameDir>/schematics/` | planned: Golem writes Sponge `.schem` files, Baritone places |
| fill / walls / shell / clear a region | `sel pos1/pos2`, `sel fill|walls|shell|cleararea|replace` | planned building primitives without schematics |
| safety knobs | `set allowBreak|allowPlace|mobAvoidanceRadius|blocksToAvoid|avoidance` | etiquette config maps onto these |
| pause / resume for reflexes | `pause`, `resume` | reflex preemption can use these |
| stop | `cancel`, `forcecancel` | `met` |
| list positions of a block kind | `find <block>` | output invisible until #16 |

Not covered by Baritone at all: crafting (#2), richer status and entities (#4, #5), events (#7, #8), crosshair target (#6), region dumps (#1 `blocksIn`), screenshot extras (#12).

## Feedback on the protocol-2 build (live, 2026-09-06)

Everything Golem touched works: `findBlocks`, `mine {wait}` (returns `{broken, ticks}`), `craft` (`oak_planks` x4 from one log), `target`, `nav.check`, `chatHistory`, `screenshot {mode:"topdown"}`, `nav.done`/`nav.failed`, `goto {reach}`. Small notes:

- `nav.failed {reason:"NEXT_CALC_FAILED"}` is emitted for a non-terminal condition: Baritone recalculated and reached the goal two seconds later (`nav.done` followed). Either don't emit it, or add a `terminal: bool` field so clients can tell.
- `nav.check` is a walk-only A* that exhausted at 20001 nodes and said `reachable: false` for a goal Baritone then reached. Fine as a hint; the name suggests more than it is. Maybe `nav.estimate`.
- `craftable` returned nothing while holding 4 oak planks (crafting table and sticks were craftable). Possibly the recipe-book unlock hadn't arrived yet; worth a look.
- `chatHistory` returns `{lines:[...]}` with `kind: "system"` lines like "Clay was shot by Skeleton"; the schema doesn't say so. Golem accepts either shape.
- `status.screen` still reports `class_434` on the launcher build (#17).

## Conventions to keep

- Everything above stays behind `hasSubscribers(...)` gating for events and `onMain` for world access, like the existing code.
- New commands get `ApiSchema` entries and regenerated `clients/schema.json`; Golem generates its typed body client from that file, so drift is a build failure on our side too.
- Decide read-only scope membership for each: `findBlocks`, `blocksIn`, `recipes`, `craftable`, `registry`, `target`, `chatHistory` are read-only; the rest actuate.
