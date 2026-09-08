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

### 19. A combat control loop: `shootAt`, `meleeWhile` (measured, 2026-09-07)

The one gap the ender dragon cannot be beaten around. Everything else on this list is "the client knows
this but doesn't expose it"; this is "the loop is running at the wrong end of the wire".

Aiming a bow over the WebSocket costs four round-trips — sample the target, `useHold`, re-sample,
`lookAt`, `useRelease` — about **1.5 s per arrow**. An ender dragon covers roughly twenty blocks in that
time, so the arrow is loosed at where the target used to be. Measured on a real fight: hundreds of
arrows, 54 spent shafts on the ground at once, and the dragon's health moving three points in ten
minutes. Fixing Golem-side ballistics (the drop was compensated at about half its real value; a
Minecraft arrow falls at 20 blocks/s², so it drops 10·t² over flight time t) restarted damage, which is
the tell — ballistics was the only error latency could not hide. The rest is latency, and no amount of
Shem tuning fixes a 1.5 s control loop against a 20 Hz target.

The client already has every piece: entity velocity per tick, the player's rotation, and the draw
progress. It just needs to own the loop, exactly as Baritone owns pathfinding.

```
shootAt {entityId: int, lead?: bool=true, charge?: int=25, shots?: int=1, maxRange?: double=64}
  -> {fired: int, hits?: int}
      Draws, tracks the entity every tick, solves lead from its actual velocity and drop from
      10*t^2 with t = distance/53, sets rotation on the release tick, looses. Repeats for `shots`.
      NOT_FOUND if the entity goes away, MISSING_ITEM without a bow/arrows.

meleeWhile {entityId: int, maxMs?: int=5000, reach?: double=3.5, stopBelowHealth?: double}
  -> {hits: int, killed: bool, stopped: "dead"|"gone"|"timeout"|"health"}
      Swings on the attack-cooldown cadence while the target is in reach, facing it each tick.
      For a multi-part entity (the dragon) resolve the part under the crosshair, since the parent
      entity ignores damage — `/damage` on an ender_dragon reports "Applied" and changes nothing.
```

Both should honour `pause`/`cancel` so a reflex can take the body back. With these, the split is the one
that already works for movement: the mind decides *fight that*, a reflex decides *it has perched, melee*,
and the body does the 20 Hz work.

### 20. Entity velocity in `entities` (small, unblocks aiming anywhere)

`entities` returns position but not motion, so anything that wants to lead a target has to sample the
same entity twice and divide by a wall-clock guess. Over the wire that guess is wrong: the gap between
two calls is whatever the network gave you, and the error goes straight into the aim. The client has
`Entity.getVelocity()` sitting right there.

```
entities {...}  ->  [{... , vx: double, vy: double, vz: double}]   blocks per tick, as the client has it
```

Cheap, and it makes decent aiming possible from Shem even before #19 lands.

### 21. Idempotent armour equip

`equip` is a shift-click out of the player inventory, and the armour slots are part of that inventory —
so asking to wear a piece that is already worn quick-moves it back OFF. A mind that defensively
re-equipped its armour each turn undressed itself and fought a boss at zero armour points with the
gear in its bag. Golem now guards this client-side by checking `status.player.armor` first, but the
body is the right place for it.

```
equip {item}    already in the matching armour slot -> no-op, {equipped: item, changed: false}
```

Same for `swapHands`/offhand if it has the same shape.

### 22. A headless body pauses itself, and `closeScreen` cannot un-pause it (confirmed, 2026-09-08)

Two dragon runs were lost to this and it took a live probe to see, because every symptom points
away from the cause.

**What happens.** `options.txt` ships `pauseOnLostFocus:true`. A headless body runs on the GLFW null
platform, so its window is never focused. The moment `screen` goes null - reliably the tick after a
death screen is dismissed, which in a boss fight is often - vanilla opens `PauseScreen`. An open
screen blocks *all* item use, and nothing reports it:

```
screen        -> {"screen":"other","screenClass":"PauseScreen", ...}
useHold {}    -> OK          status.usingItem stays false
useRelease {} -> OK          arrow count never moves
shootAt {...} -> OK          zero arrow entities in the world
```

Movement, mining, pathing and combat *approach* all keep working, so the body looks healthy from
every angle except the one that matters. Tester fought a full dragon fight in this state with 320
arrows in the bag and never fired a shot.

**Two separate bugs.**

1. `closeScreen` cannot close it, and says it did:

   ```java
   d.register("closeScreen", ..., ctx -> ctx.onMain(() -> {
       if (mc.player != null) mc.player.closeContainer();   // container menus only
       o.addProperty("closed", true);                        // unconditional
   }));
   ```

   `closeContainer()` only closes an `AbstractContainerMenu`. `PauseScreen` is a plain `Screen` set
   via `setScreen`, so it is untouched - and `closed:true` is hardcoded, so the caller is told it
   worked. Please make it `mc.setScreen(null)` for non-container screens too, and report the truth:

   ```
   closeScreen  -> {closed: bool, was: "PauseScreen"|null, still: "PauseScreen"|null}
   ```

   `clickButton` on the pause menu's own "Back to Game" does not help either - it returns
   `{"clicked":0,"text":"Back to Game"}` and the screen is straight back on the next tick, which is
   the tell that this is the focus check re-opening it rather than a stuck screen.

2. Headless mode should force `pauseOnLostFocus:false`, next to where the client already forces
   `onboardAccessibility=false` and mutes audio in `ClefClient`. A body with no window can never
   satisfy a focus check, so the option can only ever hurt it.

Golem now seeds `pauseOnLostFocus:false` into the game dir's `options.txt` before every launch,
which fixes it for bodies Golem spawns. That is a workaround in the wrong repo: anyone running Clef
headless without Golem still hits it, and it stays silent when they do.

**Worth considering generally:** any command that cannot take effect because a screen is up should
fail loudly rather than return OK. A no-op that reports success is much more expensive to debug
than an error.

### 23. `shootAt` under-compensates arrow drop by about half (measured, 2026-09-08)

`shootAt`'s solver lands arrows roughly two blocks low at 25-50 blocks, consistently and in a tight
group - it is a systematic bias, not scatter. Against an end crystal on a pillar this reads as
"caged": every arrow buries itself in the obsidian just under the crystal it was aimed at.

Measured against a crystal 25 blocks out and 25 up, firing three full-charge arrows per setting and
aiming at target + drop:

| drop model | arrows landed | result |
|---|---|---|
| `10*t^2` (half gravity) | 8.6 blocks low | miss |
| `15*t^2` | 1.2 blocks low | miss |
| `20*t^2` | on target | **crystal destroyed** |

`t = distance / 53`. The naive figure is what you get treating the arrow as drag-free: gravity is
20 blocks/s^2, so `0.5*g*t^2` = `10*t^2`. A real arrow sheds about 1% of its speed per tick, so it
is in the air appreciably longer, and drop goes as t^2 - hence roughly double.

Golem now does its own aiming for stationary targets (`shoot_static` in `lib/combat`) rather than
call `shootAt`, which is a workaround in the wrong repo. If `CombatController` is using `0.5*g*t^2`
or a fixed fudge, applying drag to the flight-time estimate should fix it for everything - the same
bias will be there for mobs at range, just harder to notice because they move.

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

Not covered by Baritone at all: crafting (#2), richer status and entities (#4, #5), events (#7, #8), crosshair target (#6), region dumps (#1 `blocksIn`), screenshot extras (#12), and combat aiming (#19) — Baritone paths and mines, it does not fight.

## Feedback on the protocol-2 build (live, 2026-09-06)

Everything Golem touched works: `findBlocks`, `mine {wait}` (returns `{broken, ticks}`), `craft` (`oak_planks` x4 from one log), `target`, `nav.check`, `chatHistory`, `screenshot {mode:"topdown"}`, `nav.done`/`nav.failed`, `goto {reach}`. Small notes:

- `nav.failed {reason:"NEXT_CALC_FAILED"}` is emitted for a non-terminal condition: Baritone recalculated and reached the goal two seconds later (`nav.done` followed). Either don't emit it, or add a `terminal: bool` field so clients can tell.
- `nav.check` is a walk-only A* that exhausted at 20001 nodes and said `reachable: false` for a goal Baritone then reached. Fine as a hint; the name suggests more than it is. Maybe `nav.estimate`.
- `craftable` returned nothing while holding 4 oak planks (crafting table and sticks were craftable). Possibly the recipe-book unlock hadn't arrived yet; worth a look.
- `chatHistory` returns `{lines:[...]}` with `kind: "system"` lines like "Clay was shot by Skeleton"; the schema doesn't say so. Golem accepts either shape.
- `status.screen` is readable now (`title`, `none`); thanks.
- `craft` only knows recipes the server has *unlocked* in the recipe book ("no known recipe produces minecraft:iron_pickaxe" while the ingots were still in the furnace). Crafting by recipe id from the registry would remove that dependency.
- Container slot `item` strings carry the count (`minecraft:coal x7`); a separate `count` field already exists, so the suffix is just a trap. Golem strips it.
- `withdraw`/`deposit` move one stack slot per call; Golem loops, but a `{all:true}` would save round trips.

## Conventions to keep

- Everything above stays behind `hasSubscribers(...)` gating for events and `onMain` for world access, like the existing code.
- New commands get `ApiSchema` entries and regenerated `clients/schema.json`; Golem generates its typed body client from that file, so drift is a build failure on our side too.
- Decide read-only scope membership for each: `findBlocks`, `blocksIn`, `recipes`, `craftable`, `registry`, `target`, `chatHistory` are read-only; the rest actuate.
