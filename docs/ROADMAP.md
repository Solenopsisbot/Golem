# Roadmap

Each milestone ends with something you can watch happen in a world.

## M0: Skeleton (done 2026-09-06)
Repo, TypeScript toolchain, `golem.toml` loader with schema, typed body client generated from Clef's `schema.json`, `golem attach` printing live status and streaming events. Clef e2e server as the dev world.

## M1: Body (done 2026-09-06, a few primitives still unexercised)
Done: typed body client with capability probing, state mirror, primitives (perception, navigation, actions, containers, chat, screenshot, map), eight built-in reflexes, `golem shell`/`attach`/`body`/`up`/`met`, body supervisor, JSONL trace, dev server script. Live-verified on the survival dev server against the protocol-2 body: join, status, look-around with `findBlocks`, inventory, entities, players, blockAt, screenshot, top-down map, chat, chat history, coordinate `goto` (with `nav.done`/`nav.failed` events), `mine` (with `wait`), drop collection, `craft`, `target`, `nav.check`, reflex preemption (`self_preservation` fled at 5 hp), auto-respawn.
Not yet exercised live: `eat` (no food yet), containers (no chest yet), `follow`, `mineAll`/`gotoNearestBlock` (blocked on CLEF-CHANGES #18).

## M2: Mind (in progress; first end-to-end run 2026-09-06)
Done: ACP client (spawns `@agentclientprotocol/claude-agent-acp`, http MCP, `bypassPermissions`, permission policy, workspace fs jail), per-agent MCP server over Streamable HTTP with 45 tools and 2 resources, inbox with coalescing and priority interrupts, chat routing with the owner fast path, standing goal wake-ups, budgets, transcript and daily journal, workspace generator (AGENTS.md/CLAUDE.md/GEMINI.md, memory seeds, persona copy), generic bridge (HTTP inbox/say/status, SSE events, webhooks, shell hooks), chest index, `golem up`/`talk`/`prompt`. Live: Claude Code woke up, mapped, screenshotted, found grass, walked there, looked around; damage and death interrupts cancelled turns as designed.
Open: session resume across restarts (`loadSession` is advertised, not used yet), speech policy `auto` is minimal, stdio MCP shim for agents without http MCP, dashboard.
ACP client, workspace generator, per-agent MCP server with the one-shot tools, inbox and coalescing, interrupts, chat routing with owner fast path, speech policy. First conversation with Kiko in-game. Screenshots in and out.

Depends on CLEF #2 to craft anything.

## M3: Shem (in progress; language complete, first live runs 2026-09-06)
Done: lexer, parser, checker (unknown names/arity/named args, registry-validated block/item/entity ids, bare-number durations, unknown events, spin-loop warning, missing docs), async interpreter (cancellation at every await point, `timeout` forms, `parallel`/`race`/`spawn`, scoped `on` handlers that can end the run, `try/catch/finally` that cannot swallow cancellation, budgets), run manager with priorities/preemption/background runs and per-run traces, library loader with `use`, `shem_*` tools, `golem shell` commands, Shem reflexes (`shem/reflexes/*.shem` register into the reflex engine), a standard library (`lib/wood`, `lib/basics`, `lib/craft`), and a Shem section in the workspace orientation. 28 unit tests, language tested against a fake host.
Open: `smelt`, `trade`, `sleep`, `dig_down`, `tunnel`, `dm` are declared but stubbed; the shipped TS reflexes are not yet ported to Shem; no `test` blocks yet.
Lexer, parser, checker (with registry validation from `minecraft-data`), interpreter, run manager, `shem_*` tools, library index and orientation regeneration, reflexes ported from TS to `.shem`. Standard library. The mind writes a script, checks it, runs it, keeps it.

## Field test and harness pass (2026-09-06, after M3)
One hour on normal difficulty with a standing goal: stone tools, a dug shelter, iron smelted, iron pickaxe and sword, base sealed and lit before night, one death to a drowned and a successful corpse run, hunting for food, four self-written scripts, zero tool errors, two `eat` failures (fixed: movement interrupts item use). Harness changes from it: two-tier model routing with `plan_next`, adaptive idle wake, compact run results, cosmetic reflexes kept out of the inbox, failing reflexes back off, session resume across restarts. The dashboard (first half of M5) shipped here.

## M4: Fleet and comms (in progress; bus landed 2026-09-06)
Done: the in-process agent bus (`dm`, `agents`, Shem `dm`/`agents`), per-pair conversation caps with both sides told when a conversation pauses, agent messages as `agent` inbox items, a second persona (Flint) in the dev fleet. Shared world knowledge landed the same evening (`comms.share_world`: one chest index and one places file for the fleet, linked into every workspace). `comms.agents = both` mirrors dms into public chat for spectators. The task board is a shared file (`world/shared/tasks.md`) with a claim/tick convention rather than a tool. Bodies can run on another machine (`docs/DEPLOY.md`); one Golem process attaches to them, so cross-process peering (`comms.fleets`) stays unbuilt until there's a reason for two Golem processes.

Multiple agents in one process, fleet spawning from the launcher jar, the agent bus, conversations, peering between Golem processes, world index shared or per-agent by config.

## M5: Proof (in progress)
Done: eval harness (`golem eval`, RCON resets, predicates, results JSON, seven basic tasks), the dashboard, `golem replay`, `golem eval-report`, a Tester fleet config so evals run beside the main fleet. First baseline 2026-09-06 (Fable plan / Opus act): 7/7 basic tasks succeeded, 623 s total, longest `wood` from a fresh spawn at 168 s, `sleep` 149 s, `iron_pickaxe` 24 s. Open: a CI job that boots the dev server and runs `tasks/basic`, `golem replay`, dashboard polish (multi-agent view, run traces inline), more tasks (survival, building, scripts). Publish.

## Not scheduled, wanted
Top-down map, annotated screenshots, blueprints and `build`, Ayusami persona bridge, voice, cheap-model helpers via Logfare, session resume across restarts for non-Claude agents.

## M6: Beat the game (in progress, started 2026-09-07)
The finish line is the ender dragon. Everything the minds need is a capability, not intelligence: they reached diamonds unaided in one evening. Landed: bow primitives (`shoot`, `use_hold`, `use_release` on the body's hold-and-release), dimension-aware reflexes (no bunker in the End, no bunker over lava), eval vocabulary for other dimensions (`dimension` and `rcon` predicates; `dimension`, `locate`, `summon` setup), and the ladder in `tasks/endgame/`: nether portal, blaze rod, ender pearl, eye of ender, stronghold, dragon. Each rung is run on its own with the gear the previous rung would have produced, so a failure is one capability, not a whole run. Landed: library scripts `lib/nether` (build/light/enter a portal), `lib/ender` (throw and follow eyes, safe stair/tunnel down, find the portal room, fill the frames, enter the End) and `lib/dragon` (shoot the crystals, melee-and-bow the dragon). An eval harness for the ladder now exists and rungs 1-2 pass on a normal-difficulty server: the nether portal (built, lit, entered unaided) and the blaze rod (bow + melee against blazes in a sealed arena, no deaths). Getting there fixed a cascade of setup and survival bugs, all reusable for the rungs above:

- **Deterministic arenas.** Combat rungs no longer trust wild terrain: a `setup.arena` builds a sealed, lit, force-loaded stone box in any dimension, kills any leftover mob, stands the bot in the middle and respawns it there, so a rung tests the fight rather than the lottery of a magma-and-lava fortress spawn. A Nether `locate` also clears lava and magma and lays a floor before placing the bot.
- **Survivable respawns.** Every eval sets `keepInventory` and gives the bot a lit sky-platform spawn, so a death is a retry instead of a strip-and-death-loop at the world spawn.
- **Honest hazards.** `self_preservation` now reads the damage type and steps off magma, fire, cactus and dragon breath and digs out of a wall, instead of standing on a hot floor until it dies; the body reports the damage source and the mirror and dashboard carry it.

Rungs 3-4 now pass too. The ender pearl (kill endermen, collect a pearl, in a sky arena) and the eye of ender (craft blaze powder, then the eye) both succeed. Getting the pearl added three more reusable harness pieces: armour in a task's `give` is worn, not just bagged, so a bot starts and respawns armoured; arena mobs are placed at fixed ring positions with PersistenceRequired rather than relative to the bot (an `execute at` right after the teleport dropped them outside the walls); and a summon can carry an `hp<N>` token that weakens a mob (a 40-hp enderman teleports the instant it is hit and out-runs a turn-based attacker, so `attack()` times out without landing a kill; at 8 hp one blow kills it). A finding stands: a turn-based mind can't out-react a real-time melee swarm, so combat rungs use a handful of enemies, not a mob.

Rung 5 (stronghold) is close but unsolved. The bot now survives the dive (0 deaths, after a lava/drown/mob death loop earlier) and navigates well: it threw eyes, followed them ~230 blocks, wrote its own descend script and dug down to the portal-room depth. What it can't yet do is finish inside the 40-minute budget: hand-digging and searching for the portal room eats the whole clock before it fills the frames. That needs efficient stronghold traversal, not more setup. Two harness fixes landed on the way: after a `locate` the bot's spawnpoint is set beside the structure (a death no longer strands it hundreds of blocks away), and keepInventory keeps its eyes through deaths.

Rung 5 (stronghold) now passes: the End in 18 minutes where it used to time out at 43. The cause was
that `dig_down` was registered as a stub, so the library index told the mind it was NOT IMPLEMENTED and
`stairs_down`'s doc said "never straight down" - so the mind hand-cut a spiral staircase, three mines and
a path-find per block, ~80 blocks deep, never scanning for the portal on the way. One turn ran 41 minutes.
`dig_down` is now real (one swing per block, stops rather than dying at lava or a long drop) and
`lib/ender dive_for_portal` sinks a bounded distance while scanning 64 blocks for the frames - in the
passing run it spotted them from 61 blocks away. Two engine bugs fell out of the same rung: portals
counted as "solid", so `goto` bumped its reach and parked the body *beside* the portal ("stood on the
portal but did not go"); and `equip()` on armour you are already wearing took it off, because the body's
equip is a shift-click out of the player inventory and the armour slots are part of it - a mind that
re-equipped its armour each turn undressed itself and fought at 0 armour points.

Rung 6 (the dragon) is blocked on the world, not the bot. A `/summon`ed ender dragon has no
EnderDragonFight controller: it hovers exactly where it is put, never circles, perches or attacks, so
there is no fight to win and no perch to melee. This world's End has no exit portal either, so the
vanilla four-crystal respawn cannot trigger. Running it needs an End that still has its dragon (or a
regenerated one). The attempt did surface a real capability gap worth fixing first: `aimed_shot` leads
the target not at all, so against anything that moves the arrows simply miss - 240 arrows put 2.5 damage
on a dragon. Bow work (sample velocity, predict arrow flight) is the prerequisite for a boss fight.

Rung 6 has now been run against a real dragon and still fails, for a reason worth stating plainly.
The End was regenerated locally and the fight state reset (level.dat `DragonKilled` and
`PreviouslyKilled` cleared, `NeedsStateScanning` set), which produces a genuine fight-controlled
dragon - verified flying y66-96 across twelve positions in thirty seconds, unlike a `/summon`ed one,
which sits at exactly y=80.0 for a minute and never circles, perches or attacks. `lead_shot` was added
and does land hits where the old fixed-lift aim landed none. But the bot dies faster than it damages:
six deaths and 200 -> 197 hp, with keepInventory, an obsidian firing nook to respawn into, no healing
crystals left, and every hit sticking permanently.

So the blocker is not aim, gear, terrain or recovery any more - it is that a mind whose turn takes
15-45 seconds cannot trade with a boss that kills it in two hits. The same ceiling showed up on rung 3,
where four endermen swarm-killed the bot before a single turn could land, and it is why the combat
rungs use a handful of weakened enemies. Beating the dragon needs the reflex layer to fight
competently on its own between turns - dodge, retreat, drink, re-engage - rather than the mind
steering every swing.

That reflex layer now exists (`shem/reflexes/dragon_fight.shem`, off by default) and works as a
mechanism: it fires continuously, heals, breaks contact, recovers from deaths, and lands hits. It still
cannot win, and the reason is architectural rather than tactical. Each shot costs four round-trips to
the body — sample, draw, re-sample, aim, loose — about 1.5 s, against a dragon that covers twenty
blocks in that time. Fixing the arrow ballistics (the drop was compensated at roughly half its real
value) restarted damage, which is the tell: ballistics was the one error latency could not hide.

So combat belongs in the body, beside Baritone, not in Shem and certainly not in the mind. Baritone is
why movement is reliable — we do not hand-roll A* over a WebSocket — and the same argument applies to
aiming. The shape of the fix is a Clef-side command (`shootAt {entityId, lead}` and a melee loop) that
samples true velocity every tick, computes lead and drop exactly, and looses on the right tick. Golem
then says "fight that" and the body does the 20 Hz work.

Also worth naming: the rung's scaffolding drifted a long way (weakened mobs, an obsidian nook,
fountain-side placement, most crystals pre-killed). That is fixture design turning into doing the
agent's job for it, and it should be stripped back once the body can aim.

**Rung 6 passes. The ladder is complete: 6/6, the dragon is dead.** 1212 s, 19 turns, 31 deaths, with
the scaffolding stripped — no pre-killed crystals, no teleport to the fountain, no pre-worn pumpkin, no
force-enabled combat reflex, and a goal that states the objective and stops. Verified beyond the
success predicate: the world contains a dragon egg at (0,66,0) and `level.dat` reads `DragonKilled=1`,
both of which only the game writes, and both of which were explicitly cleared before the fight.

What actually unblocked it, in order of size:

- **Clef #19/#20 landed.** `shootAt`/`meleeWhile` run the aiming loop on the body at 20 Hz, and
  `entities` now reports motion derived from displacement (`getVelocity()` reads zero for
  server-driven mobs, so any lead computed from it aims at a standing target). Damage went from three
  health in ten minutes to thirty-eight in two.
- **The server was kicking the bot mid-fight.** "Flying is not enabled on this server": the dragon
  throws you into the air, and the vanilla check reads that as cheating. The agent was sitting in a
  disconnected screen correctly reporting it had nothing to act on. `allow-flight=true` now.
- **A doc string was steering it wrong**, again. It wrote eleven `attack()` calls to three
  `melee_while`, and `attack()` does nothing to a multi-part boss. Same shape as `stairs_down` saying
  "never straight down" while `dig_down` sat unimplemented: the library index is what the mind reasons
  from, so a doc that understates a limit costs a run.
- **Rungs now start from the shipped library** (`fresh_workspace`), because a fresh mind with a
  workspace full of its own previous attempts inherits last run's habits.

Honest caveats: the End crystals were already absent from earlier world surgery, so this run did not
have to clear them — a from-scratch fight starts with ten, and clearing them is a real part of the job.
And 31 deaths is a war of attrition, not skill: it works because keepInventory and an in-dimension
respawn make death cheap and dragon damage permanent.

Open at the time: crystal clearing inside the same run; and the reflex layer as the weak link — the
agent turned `self_preservation` off and left `dragon_fight` off, so the stalls were all periods where
nothing useful ran between turns. M7 below closes the first and leaves the second standing.

## M7: Beat the game for real (done 2026-09-09)

Rung 6 passes with keepInventory on, an in-dimension respawn and crystals that earlier world surgery
had already removed. That is a dragon kill, but it is not the game: death is free and the hardest part
of the fight is missing. `tasks/endgame/7_dragon_hard.json` is the same fight without the padding —
normal difficulty, `keep_inventory` off, ten crystals standing (two of them caged), no respawn in the
End at all, and the way back is a built end portal in an overworld room with five spare kits in a
chest and nothing else in the world.

**It passes: 606 s, 4 turns, 27 tool calls, 1 death.** Verified past the predicate —
`execute if entity @e[type=minecraft:ender_dragon]` replies "Test failed" and the crystals are gone
too. The full sequence on that rung, fable/fable:

| Run | Result | Turns | Calls | Deaths | Models |
|---|---|---|---|---|---|
| 1 | timeout (7205 s) | 62 | 33 | 2 | opus / opus |
| 2 | timeout (7207 s) | 22 | 57 | 3 | opus / opus |
| 3 | timeout (7206 s) | 49 | 113 | 7 | fable / fable |
| 4 | **success (606 s)** | 4 | 27 | 1 | fable / fable |

Three things decided it, and only one of them is about Minecraft.

- **`lib/dragon` was the trap, not the tool.** It aimed with a drop constant fitted at one range,
  approached crystals to a flat 16 blocks (from which the pillar blocks every shot), and fought with
  `attack()`, which does nothing to a multi-part boss. Both models reached for it, because the library
  index is what a mind reasons from — so neither model was ever being tested. It now uses
  `shoot_static`, `standoff_for` and `melee_while`, and the mechanics live in `lib/end` as primitives
  the mind composes rather than as a plan it follows.
- **`break_cage`.** Two crystals sat in fully enclosed iron-bar cages. Bars stop arrows at every
  angle, and a crystal heals the dragon within 32 blocks — which is fine to ignore for a dragon that
  perches, and fatal for one that does not, because the healing is *why* it never comes down. Ninety
  seconds after the last cage came off with a pickaxe, the dragon went 200 → 104 → 0.
- **Model routing was the throughput ceiling.** Opus act turns ran to 1524 s for 17 calls; the clock
  ran out mid-thought. Moving both tiers to Fable took the same two hours from 22 turns to 49. The
  turn budget, not the reasoning, was the binding constraint on a rung this long.

Honest accounting of the rest: the other ~40 commits were infrastructure that lied. A headless client
opens the pause screen and refuses every item use while reporting OK on all of it (three runs, 320
arrows, zero shots fired). `self_preservation` "escaped" a dragon-breath cloud by stepping one block
sideways and returned success. Damage interrupts cancelled the mind's turn before it ever finished
one, four runs running. Four separate respawn bugs put the bot in the overworld, inside solid rock,
seven blocks from the dragon's perch, and on the underside of the island over the void. `fresh_workspace`
archived into the workspace it was clearing. `item replace block` silently refuses counts over 64, so
the spare kits shipped with no arrows. They share a shape worth naming: the expensive bugs here almost
never throw. They report success and do nothing, so every layer above them reads as working, and the
only defence that ever caught one was checking the world instead of the return value.

The agent found nine of those from inside the game, including two Clef bugs (#24 `equip` asserting a
move it never checked, #25 `blockAt` unable to say "I don't know") and a residual error in the
ballistics solver.

Still open, and the reason a good run is still partly luck: **reflexes cancel the mind's scripts.**
`self_preservation` at p90 interrupts whatever Shem is running, which is correct when it is pulling
the bot out of dragon breath and wasteful when the two are not competing for the same actuator. Agents
respond rationally by turning it off, and then die to a cloud. The state header now tells the mind what
the reflexes have been doing, which is a workaround; letting a reflex act *without* cancelling when
there is no contention is the fix.

## Minds beyond Claude Code

`adapters/codex-acp.ts` is a Golem-owned ACP adapter over `codex app-server`, so OpenAI Codex (the installed CLI, any model it supports including gpt-6-astra) can be the mind. Proven end to end: session, MCP tools, streaming, chat. The ACP client in `src/mind/acp.ts` is unchanged; a mind is just a `command`/`args` in config.

`golem.eval.codex.toml` points the eval fleet at it on the same ports as `golem.eval.toml` — same rungs, same body, same reflexes, only the thinker changes. Run one or the other, never both: they share the MCP bind and the Clef control port. Two adapter bugs came out of trying it, both of which made the config look honoured when it wasn't: `model/list` returns `{data:[...]}` and the adapter read `{items}`, got an empty list and silently fell back to the default model; and error notifications resolved as a bare refusal with the actual message dropped. Both fixed. **No endgame rung has been completed on Codex yet** — the attempt ran into those two bugs and the run was not repeated, so there is no comparable number here, only a working path.

`adapters/llm-acp.ts` runs any OpenAI/Anthropic-compatible endpoint as a mind (chat, responses or anthropic wire), so Logfare and other Chat-Completions gateways are first-class. It connects to Golem's MCP server as a client and drives its own tool-calling loop.
