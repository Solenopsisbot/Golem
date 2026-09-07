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

Open: lead-predicting bow aim, and rung 6 against a real dragon.

## Minds beyond Claude Code

`adapters/codex-acp.ts` is a Golem-owned ACP adapter over `codex app-server`, so OpenAI Codex (the installed CLI, any model it supports including gpt-6-astra) can be the mind. Proven end to end: session, MCP tools, streaming, chat. The ACP client in `src/mind/acp.ts` is unchanged; a mind is just a `command`/`args` in config.

`adapters/llm-acp.ts` runs any OpenAI/Anthropic-compatible endpoint as a mind (chat, responses or anthropic wire), so Logfare and other Chat-Completions gateways are first-class. It connects to Golem's MCP server as a client and drives its own tool-calling loop.
