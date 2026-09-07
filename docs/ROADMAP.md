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
The finish line is the ender dragon. Everything the minds need is a capability, not intelligence: they reached diamonds unaided in one evening. Landed: bow primitives (`shoot`, `use_hold`, `use_release` on the body's hold-and-release), dimension-aware reflexes (no bunker in the End, no bunker over lava), eval vocabulary for other dimensions (`dimension` and `rcon` predicates; `dimension`, `locate`, `summon` setup), and the ladder in `tasks/endgame/`: nether portal, blaze rod, ender pearl, eye of ender, stronghold, dragon. Each rung is run on its own with the gear the previous rung would have produced, so a failure is one capability, not a whole run. Landed: library scripts `lib/nether` (build/light/enter a portal), `lib/ender` (throw and follow eyes, safe stair/tunnel down, find the portal room, fill the frames, enter the End) and `lib/dragon` (shoot the crystals, melee-and-bow the dragon). Open: a full run from nothing up the ladder, on a normal-difficulty server, fixing what breaks.
