# Shem

The language a mind writes and puts in the body's mouth. A Shem script is a small, readable program over Minecraft primitives. Files end in `.shem`.

## Design goals

1. **Familiar to a coding model.** JS-shaped syntax, no surprises: braces, `let`, `if`, `for`, `while`, string interpolation.
2. **Blocking by default.** `goto(p)` returns when you're there. `mine(p)` returns when the block is gone. No callbacks, no polling.
3. **Time is a first-class thing.** Durations are literals (`30s`), every primitive has a default timeout, any statement can take a `timeout` suffix.
4. **Interruptible.** Every await point checks for cancellation. Reflexes can preempt a run. `met` kills everything.
5. **Checkable before running.** `shem_check` parses, type-checks, validates every block/item/entity id against the 1.21.8 registry, and reports unknown primitives and arity mistakes, with no side effects.
6. **Traceable.** Every run writes a log of every primitive call with args, result and duration.
7. **Safe.** No filesystem, no network, no eval. Loop and time budgets. The only side effects are game actions.

## A first script

```shem
/// Collect logs from the nearest trees. Returns the number of logs gathered.
script collect_wood(kind: block = "oak_log", want: int = 16, radius: int = 48) {
  let start = inventory.count(kind)
  let logs = find_blocks(kind, radius: radius, max: 64)
  if (logs.length == 0) fail "no ${kind} within ${radius} blocks"

  for (pos of logs) {
    goto(pos, reach: 4) timeout 30s
    mine(pos)
    if (inventory.count(kind) - start >= want) break
  }
  collect_drops(radius: 6)
  return inventory.count(kind) - start
}
```

Run it from the MCP side with `shem_run("shem/collect_wood.shem", { kind: "birch_log", want: 8 })`.

## Lexical structure

- Comments: `// line`, `/* block */`. Doc comments `/// ...` directly above a `script` or `reflex` become its description in the library index.
- Identifiers: `[a-zA-Z_][a-zA-Z0-9_]*`.
- Integers `12`, floats `0.5`, booleans `true`/`false`, `none`.
- Strings `"..."` with interpolation `"${expr}"`. Single quotes are also accepted.
- Durations: `10t` (ticks), `500ms`, `30s`, `2m`, `1h`. A bare number where a duration is expected is an error, not seconds.
- Positions: `(x, y, z)` with integer parts is a `pos`; with any float part it is a `vec`. `here` is the bot's block position, `eye` its eye position, `me` the bot's own entity.
- Block, item and entity ids are **strings** in typed positions: `"oak_log"`, `"minecraft:oak_log"`, `"zombie"`. The namespace defaults to `minecraft:`. The checker validates them.

## Types

`int float bool string dur pos vec block item entity player list<T> map<K,V> run any`, plus `T?` for optional. Typing is gradual: literals, primitive return types and annotated parameters are known and mismatches are errors; untyped values pass through as `any`. `block`, `item`, `entity` are string subtypes the checker validates against the registry, and `player` is a string validated against the tab list at run time.

`pos` and `vec` support `+`, `-`, `.x .y .z`, `.above(n=1)`, `.below(n)`, `.offset(dx,dy,dz)`, `.dist(other)`, `.toward(other, n)`, `.floor()`. Lists support `.length`, `.first`, `.last`, `.sort_by(fn)`, `.filter(fn)`, `.map(fn)`, `.includes(x)`, `.nearest(from = here)`. Maps support `.get(k, default)`, `.set(k,v)`, `.keys`, `.values`.

## Declarations

```shem
use "lib/trees"                  // imports every script in shem/lib/trees.shem
const HOME: pos = (120, 64, -30)

script name(a: int, b: block = "stone", c: dur = 20s): int { ... }

reflex low_health priority 90 on health(hp, food) when hp <= 6 {
  say "ow, retreating"
  flee(threats(radius: 12), 16)
  eat_something()
}
```

A file may hold many scripts. The entry point of a file is the script named `main` or the one sharing the file's name. `script` bodies can call each other and any imported script. `reflex` is only valid at top level and only loaded from `shem/reflexes/` (shipped) or the agent's `shem/reflexes/` (if `reflexes.allow_custom = true`).

## Statements

| Statement | Meaning |
|---|---|
| `let x = e` / `const x = e` | Block-scoped bindings. |
| `x = e`, `x += e`, `x -= e` | Assignment. |
| `if (c) { } else if (c) { } else { }` | A branch may also be a single statement: `if (x) fail "no"`. |
| `for (x of list) { }`, `for (i, x of list) { }` | Loop bodies may be a single statement, like `if`. |
| `while (c) { }`, `repeat (n) { }` | Loops are budgeted (see limits). |
| `break`, `continue`, `return e` | |
| `fail e` | Throw a `failed` error with message `e`. |
| `wait 5s` | Sleep. |
| `wait until c` / `wait until c timeout 20s else { }` | Poll `c` each tick until true. Without `else`, timing out throws `timeout`. |
| `e timeout 30s` | Run statement `e` under a timeout; throws `timeout`. |
| `timeout 30s { ... } else { ... }` | Block form. |
| `parallel { } { } ...` | Run blocks concurrently, wait for all. One failing fails all (others cancelled). |
| `race { } { } ...` | First block to finish wins; the rest are cancelled. |
| `spawn { }` | Background task; returns a `run` handle with `.cancel()`, `.done`, `.result`. |
| `try { } catch (e) { } finally { }` | `e.kind`, `e.message`, `e.at`. |
| `on event(args) when c { }` | Handler scoped to the enclosing block; removed when the block exits. |
| `log "text"` | Writes to the run trace only. |
| `say "text"` | In-game chat, subject to chat policy and rate limit. |

Expressions: the usual arithmetic and comparison operators, `and`/`or`/`not` (also `&&`, `||`, `!`), member access, calls with positional and **named** arguments (`goto(p, reach: 3)`), anonymous functions `(x) => x.y > 60` for `filter`/`sort_by`/`map`, ternary `c ? a : b`.

## Events

Usable in `on` and `reflex`: `tick`, `health(hp, food)`, `damage(amount, hp, source?)`, `death`, `respawn`, `chat(sender, text, kind)`, `whisper(sender, text)`, `player_join(name)`, `player_leave(name)`, `entity_near(entity)`, `entity_gone(id)`, `block_changed(pos, from, to)`, `item_picked(item, count)`, `inventory_changed`, `screen_open(kind)`, `screen_close`, `nav_done`, `nav_failed(reason)`, `run_done(run)`, `run_failed(run, error)`, `time(phase)` (dawn/day/dusk/night), `weather(kind)`, `stuck(seconds)`. Some of these need Clef additions (see CLEF-CHANGES); until then Golem synthesises them from polling where it can.

## Errors

`fail` raises `failed`. Primitives raise typed kinds: `timeout`, `unreachable`, `not_found`, `missing_item`, `cant_place`, `cant_break`, `blocked`, `cancelled`, `preempted`, `clef` (with `code` from Clef, e.g. `NOT_IN_WORLD`), `check` (only from the checker). `cancelled` and `preempted` cannot be caught into silence: a `catch` may run cleanup but the run still ends with that status.

## Runs

A run is one invocation of a script. `shem_run` returns a run id immediately if `background: true`, otherwise it blocks until the run ends (bounded by `timeout`) and returns `{ status, result, error, trace_tail }`.

- **Priority** (0 to 100, default 50). A new run with `interrupt: true` preempts a lower-priority run (which ends `preempted`). Reflexes carry their own priority and preempt the same way. Equal or lower priority queues.
- **Params** are JSON, coerced to the script's parameter types, with the same validation as literals.
- **Budgets** per run: wall time (default 10 m, max 1 h), primitive calls (default 2000), loop iterations (default 100k). Exceeding one ends the run `failed` with a clear message.
- **Trace**: `runs/<id>.log` in the workspace, one line per primitive call: time, primitive, args, outcome, duration; plus `log` lines and errors.
- **Cancellation**: `shem_cancel(run)`, a preempting run, `met`, or the mind's ACP turn being cancelled with `cancel_runs_on_turn_cancel = true`.

## Primitives

Blocking unless stated. Default timeouts in brackets. "Clef:" names the commands used; "needs" points at CLEF-CHANGES.

### Perception (instant, from the mirror or a single call)

| Primitive | Returns |
|---|---|
| `here`, `eye`, `me`, `yaw`, `pitch` | Position, eye position, own entity, orientation. |
| `health`, `food`, `air`, `xp`, `dimension`, `gamemode` | Numbers and strings. `gamemode` needs Clef #5. |
| `time`, `time.phase`, `is_day`, `weather`, `biome`, `light_at(pos)` | Needs Clef #5 for weather/biome/light. |
| `block_at(pos)` | `{ id, air, solid, liquid, pos }`. Clef: `blockAt`. |
| `find_blocks(kinds, radius, max: 32, sort: "nearest")` | `list<pos>`. Clef: `findBlocks` (**needs #1**). |
| `blocks_in(min, max)` | Region dump, palette-compressed, for building and mapping. **Needs #1.** |
| `find_entities(kinds?, radius: 16, hostile?: bool)` | `list<entity>`; entity has `id type name pos dist health? hostile? held?`. Clef: `entities` (**richer with #4**). |
| `nearest(kinds?, radius)`, `nearest_player(radius)`, `threats(radius)` | Convenience over `find_entities`. |
| `players()` | Tab list. Clef: `players`. |
| `inventory` | `.count(item)`, `.has(item, n)`, `.slot_of(item)`, `.items`, `.free_slots`, `.armor`, `.held`. Clef: `inventory`. |
| `container` | Open container view: `.slots`, `.count(item)`, `.trades`. Clef: `container`. |
| `craftable()` / `recipe(item)` | From `minecraft-data` plus inventory. Clef `recipes` (**#2**) preferred. |
| `target()` | What the crosshair is on. **Needs #6.** |
| `place_of(name)` / `places()` | Named places from `memory/places` and `world/`. |
| `chests_with(item)` | From the chest index. |

### Movement [goto 60s, others 20s]

| Primitive | Behaviour |
|---|---|
| `goto(pos | entity | player, reach: 1)` | Baritone path; resolves on arrival within `reach`. Clef: `goto` + `nav.status` polling now, `nav_done`/`nav_failed` events with **#7**. |
| `goto_xz(x, z)` | Surface travel. |
| `follow(entity | player, dist: 3)` | Runs until cancelled or the target vanishes; use in `spawn` or `race`. |
| `look_at(pos | entity)` / `look(yaw, pitch)` | Instant. Clef: `look` (Golem computes angles from eye position). |
| `move(dir: "forward", dur: 500ms, sprint?, jump?)` / `jump()` / `sneak(on)` / `sprint(on)` / `stop()` | Raw input. Clef: `move`, `stopMove`. |
| `flee(from: entity | list<entity> | pos, dist: 16)` | Pick a point away from all sources, `goto` it. |
| `wander(radius: 12)` | Random reachable point. |
| `explore(for?)`, `surface(timeout?)`, `dig_down(n)`, `tunnel(dir, n)` | Baritone `explore`, plus Golem-side digging loops with safety checks (no digging into lava or air). |
| `path_exists(pos)` | Non-blocking estimate. **Needs #7** (`nav.check`) for a true answer. |

### Actions [15s unless noted]

| Primitive | Behaviour |
|---|---|
| `mine(pos)` | Break one block; resolves when it is air. Auto-selects the best tool in hotbar unless `tool: none`. Clef: `mine` + `blockAt` polling (`block_changed` with **#8**). |
| `mine_all(kind, want, radius)` | Baritone `mine` with a stop condition. |
| `place(item, pos, face?)` | Selects the item (moving it into the hotbar if needed), finds a solid neighbour and face, clicks, verifies `block_at(pos)`. Errors: `missing_item`, `cant_place`. Clef: `findItem`, `clickSlot`, `setSlot`, `place`, `blockAt`. Atomic with **#10**. |
| `place_here(item)` | Place at `here` after stepping aside. |
| `use_item(hand?)`, `use_on(pos | entity, hand?)`, `hold_use(ticks)`, `release_use()` | Right-click family. Clef: `use`, `place`, `interactEntity`, `useHold`, `useRelease`. |
| `attack(entity)` [30s] | Approach to reach and swing until dead or gone. Clef: `attack` + `entities`. |
| `attack_nearest(kinds, radius)` | |
| `equip(item)`, `unequip(slot)` | Clef: `equip`, `clickSlot`. |
| `eat(item?)` / `eat_something()` | Eat named item or the best food in inventory. Clef: `setSlot`, `eat`. |
| `drop(item, n)`, `drop_all(item)` | Clef: `dropItem`, `dropStack`. |
| `give(player, item, n)` | `goto` the player then drop toward them. |
| `craft(item, n: 1, table?: pos)` [30s] | Recipe-book craft; opens a table if needed and one is given or nearby. **Needs #2**; fallback is grid clicking from `minecraft-data` recipes. |
| `smelt(item, n, fuel?: item, furnace?: pos)` [long] | Load furnace, wait for output, collect. Clef: `place`, `container`, `deposit`, `withdraw`. |
| `open(pos)`, `close()` | Containers. Clef: `place` (right-click), `closeScreen`; `screenOpen` event confirms. |
| `deposit(item, n?)`, `withdraw(item, n?)`, `deposit_all(except?)` | Clef: `deposit`, `withdraw`, `clickSlot`. Updates the chest index. |
| `trade(villager, index, n)` | Clef: `interactEntity`, `selectTrade`, `clickSlot`. |
| `sleep()` | Find a bed, use it, wait for morning or `sleep_failed`. |
| `collect_drops(radius: 6)` [20s] | Walk over nearby item entities. |
| `remember(name, pos = here)`, `forget(name)` | Writes `memory/places`. |
| `say(text)`, `whisper(player, text)`, `dm(agent, text)` | Comms, subject to policy and rate limits. |
| `wait(dur)` | Sleep. |
| `note(text)` | Append to today's journal. |

### Building

`build(blueprint, origin: pos, orientation?: "north")` walks a blueprint (a `map<pos, block>` or a `blueprint` object produced by helpers `box`, `fill`, `hollow`, `line`, `stairs`, `layer(y, rows)`) in a safe order (bottom up, reachable first), fetching materials from the chest index if `fetch: true`. `check_build(blueprint, origin)` returns what is still missing. This is where `blocks_in` and `place` do the heavy lifting.

## Standard library (shipped, in Shem)

`collect_blocks`, `craft_recipe` (resolves sub-recipes and missing tables), `smelt_items`, `go_to_player`, `follow_player`, `place_here`, `attack_nearest`, `go_to_bed`, `dig_down`, `go_to_surface`, `deposit_loot`, `fetch(item, n)` (from indexed chests), `build_shelter`, `light_area`, `farm_harvest`, `fish(n)`, `bridge_to(pos)`. Each is a normal `.shem` file the agent can read and copy from.

## The checker

`shem_check(path)` reports, with line and column:

- syntax errors;
- unknown primitives and scripts, wrong arity, unknown named arguments;
- type mismatches where both sides are known (`goto("oak_log")`);
- unknown block/item/entity ids, with nearest-match suggestions;
- durations written as bare numbers;
- `reflex` outside the reflexes folder;
- `on` handlers for unknown events;
- unbounded loops with no await inside (would spin);
- scripts with no doc comment (warning).

## Runtime limits

Wall time, primitive-call and loop budgets per run (see Runs). `say` is rate-limited by config. Recursion depth 64. `parallel` fan-out 8. A run cannot spawn more than 16 background tasks.

## Implementation notes (as built, 2026-09-06)

- The interpreter is `src/shem/interpreter.ts`; the builtin table `src/shem/builtins.ts` is what the checker, the docs (`shem_doc`) and the host (`src/shem/host.ts`) share. A builtin marked `stub` parses and checks (with a warning) but fails at run time with `unsupported`: `smelt`, `trade`, `sleep`, `dig_down`, `tunnel`, `dm`.
- `if`, `for`, `while` and `repeat` accept a single statement instead of a block. Keyword names (`timeout`, `when`) are allowed as named-argument labels.
- Records from the host (entities, blocks, inventory views) are plain objects: `e.pos`, `e.dist`, `b.short`, `inventory.count("oak_log")`. Method-style members on them (`inventory.count`) are host closures.
- Reflexes declared in `shem/reflexes/*.shem` (shipped) or the agent's own `shem/reflexes/` (when `reflexes.allow_custom = true`) register with the reflex engine at session start: `on tick when <cond>` is evaluated on the engine's 250 ms cadence; other events arm on arrival and fire on the next engine tick. Priority 60 and above preempts foreground work; every Shem reflex has a 3 s cooldown. They must still be enabled by name in `reflexes.on` (or with `reflex_set`).
- `on` handlers inside a script run concurrently with the body; an uncaught error in a handler (including `fail`) ends the run with that error.
- `race` finishes on the first block to settle, success or failure. `spawn` tasks are cancelled when the run ends.
- Foreground runs derive their cancel token from the agent's foreground token, so `met` and interrupting reflexes stop them; background runs are only stopped by `shem_cancel`, `met`, or a preempting run.
- Run traces live in `runs/<id>.log` in the workspace; `shem_run` returns the last lines.

## Grammar

```ebnf
file        = { use | constDecl | script | reflex } ;
use         = "use" STRING ;
constDecl   = "const" IDENT [ ":" type ] "=" expr ;
script      = { DOC } "script" IDENT "(" [ params ] ")" [ ":" type ] block ;
params      = param { "," param } ;
param       = IDENT [ ":" type ] [ "=" expr ] ;
reflex      = { DOC } "reflex" IDENT [ "priority" INT ] "on" event [ "when" expr ] block ;
event       = IDENT [ "(" [ IDENT { "," IDENT } ] ")" ] ;
block       = "{" { stmt } "}" ;
stmt        = varDecl | assign | ifStmt | forStmt | whileStmt | repeatStmt
            | waitStmt | timeoutStmt | parallelStmt | raceStmt | spawnStmt
            | tryStmt | onStmt | "break" | "continue"
            | "return" [ expr ] | "fail" [ expr ] | "log" expr | exprStmt ;
varDecl     = ( "let" | "const" ) IDENT [ ":" type ] "=" expr ;
assign      = lvalue ( "=" | "+=" | "-=" ) expr ;
ifStmt      = "if" "(" expr ")" ( block | stmt ) [ "else" ( ifStmt | block | stmt ) ] ;
forStmt     = "for" "(" IDENT [ "," IDENT ] "of" expr ")" ( block | stmt ) ;
whileStmt   = "while" "(" expr ")" ( block | stmt ) ;
repeatStmt  = "repeat" "(" expr ")" ( block | stmt ) ;
waitStmt    = "wait" ( expr | "until" expr [ "timeout" expr ] [ "else" block ] ) ;
timeoutStmt = "timeout" expr block [ "else" block ] ;
parallelStmt= "parallel" block block { block } ;
raceStmt    = "race" block block { block } ;
spawnStmt   = [ "let" IDENT "=" ] "spawn" block ;
tryStmt     = "try" block "catch" [ "(" IDENT ")" ] block [ "finally" block ] ;
onStmt      = "on" event [ "when" expr ] block ;
exprStmt    = expr [ "timeout" expr ] ;
expr        = ternary ;
ternary     = orExpr [ "?" expr ":" expr ] ;
orExpr      = andExpr { ( "or" | "||" ) andExpr } ;
andExpr     = notExpr { ( "and" | "&&" ) notExpr } ;
notExpr     = ( "not" | "!" ) notExpr | cmpExpr ;
cmpExpr     = addExpr [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) addExpr ] ;
addExpr     = mulExpr { ( "+" | "-" ) mulExpr } ;
mulExpr     = unary { ( "*" | "/" | "%" ) unary } ;
unary       = "-" unary | postfix ;
postfix     = primary { "." IDENT [ "(" [ args ] ")" ] | "[" expr "]" | "(" [ args ] ")" } ;
primary     = literal | IDENT | lambda | tuple | listLit | mapLit | "(" expr ")" ;
lambda      = "(" [ IDENT { "," IDENT } ] ")" "=>" ( expr | block ) ;
args        = arg { "," arg } ;
arg         = [ IDENT ":" ] expr ;
tuple       = "(" expr "," expr "," expr ")" ;
listLit     = "[" [ expr { "," expr } ] "]" ;
mapLit      = "{" [ mapEntry { "," mapEntry } ] "}" ;
mapEntry    = ( IDENT | STRING ) ":" expr ;
literal     = INT | FLOAT | STRING | DUR | "true" | "false" | "none" ;
type        = IDENT [ "<" type { "," type } ">" ] [ "?" ] ;
```

`here`, `eye`, `me`, `now`, `inventory`, `container`, `health`, `food`, `time` and friends are ordinary identifiers bound in the root scope, not keywords.

## Saving from a snippet

The `shem_eval` tool takes `save: "shem/name.shem"`: the snippet is checked, written as a script file (bare statements are wrapped as `script main()`), the library index in the orientation is regenerated, and the saved file is run. A new script therefore costs one tool call. Files under `shem/lib/` can't be written this way. `shem_run` also checks before running, so a separate `shem_check` is only for diagnostics without execution.

## What comes back

A foreground run returns its status, the value it `return`ed (lists capped at 40 items, maps at 30 entries), its `log` lines, and an `[after]` line: position, health, held item, the inventory delta since the run started ("+9 melon_slice, -1 bone_meal"), and hostiles within 16. Background runs report the same into the inbox when they end. The point is that acting and observing are one call.

## The endgame library

`shem/lib/nether.shem`, `ender.shem` and `dragon.shem` are the road to the dragon as reusable scripts: `to_nether()`, `follow_eyes()` and `fill_portal()`/`enter_end()`, `beat_dragon()`. They lean on the bow primitives (`shoot`, `use_hold`, `use_release`) and dig defensively (staircases and floor checks, never straight down). `npm run check:shem` validates every library file against the block/item/entity registry with no body needed.
