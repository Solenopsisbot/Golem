# Developing Golem

First time here? `docs/SETUP.md` goes from an empty directory to a golem in a world. This file is the day-to-day.

## One-time

```bash
npm install
npm run gen:body          # regenerate src/body/schema.gen.ts from ../MezzoSopranoClef/clients/schema.json
```

The body needs the launcher jar from MezzoSopranoClef (`./gradlew :launcher:jar` there, or the prebuilt one under `launcher/build/libs/`). `golem.toml` points at it; Golem stages a copy under `data/clef/`.

## Every day

```bash
scripts/dev-server.sh --bg          # survival, offline mode, 127.0.0.1:25566, world in data/server/world
MC_DIFFICULTY=normal scripts/dev-server.sh --bg   # default is peaceful: hostiles only get in the way while developing the mind
bin/golem body Clay                 # spawn Clay's body (first run downloads Minecraft, minutes), wait for it to join
bin/golem shell Clay                # drive it by hand; `help` lists commands
bin/golem shell Clay -c "status; look; goto 100 64 100"
bin/golem attach Clay               # stream events
bin/golem met Clay                  # everything stop
bin/golem up Clay                   # body + mind (Claude Code over ACP) + MCP + bridge; Ctrl-C stops all of it
bin/golem talk Clay                 # chat with a running agent as its first owner, watching what it does
bin/golem prompt Clay "hey, find some wood"
```

Join the dev server from a normal client at `127.0.0.1:25566` to watch. Owners in `golem.toml` are the only players whose chat the fast path listens to (M2).

## Shem from the shell

```
bin/golem shell Clay -c "check lib/wood; shem lib/wood collect_wood want=2; runs"
bin/golem shell Clay -c 'eval say "hi"'          # one snippet per -c segment: the shell splits on ';'
```

Scripts the agent writes live in `data/<agent>/workspace/shem/`; run traces in `data/<agent>/workspace/runs/`. The shipped library is `shem/lib/` in this repo (mounted read-only as `lib/...`), Shem reflexes in `shem/reflexes/`.

## Evals

`tasks/basic/` is the survival ladder; `tasks/endgame/` runs the road to the dragon one rung at a time (each rung is set up with the previous rung's gear, and needs the dev server on normal difficulty: `MC_DIFFICULTY=normal scripts/dev-server.sh --bg`). Rungs 1-5 are the road; `6_dragon` is the fight with `keep_inventory` on, and `7_dragon_hard` is the same fight with it off, through a built portal, with five spare kits and nothing else.

Both dragon rungs need a world whose End still has its dragon, and a `/summon`ed one will not do: it has no `EndDragonFight` controller, so it never perches, never rolls a phase and cannot be killed by fighting it at all. `scripts/regen-end.sh` resets the island between attempts - it flushes and stops the server, moves `world/DIM1` aside and restarts, and the End regenerates with ten crystals and a new dragon on first entry.

That works after an *aborted* run, not after a won one. Killing a dragon writes `DragonKilled` into `level.dat`, and the fight state outlives the region files: delete DIM1 after a kill and you get a fresh island with no dragon on it, which looks exactly like success until the bot arrives. The script refuses in that case. **Copy `data/server/world` before the first dragon run** and putting it back is one `mv`.

```bash
bin/golem eval tasks/basic                 # every task in the folder, fresh mind session each
bin/golem eval tasks/basic/wood.json --label "opus-act"   # one task, tagged for comparison
bin/golem eval-report                                     # table of all results, grouped by label
```

A task is a JSON file: a `goal` for the mind, a `setup` (RCON world reset: clear, give, teleport or `spread` onto safe surface ground near a point, time, weather, gamemode, raw commands), `success` predicates that must all hold at once (inventory with `*` wildcards, block, near, said, alive, script_exists, dimension, rcon), optional `fail` predicates, a `timeout_s`. Results land in `data/eval/*.json` with turns, tool calls, tokens, deaths and seconds. The runner owns the agent while it runs: stop `golem up` first. The dev server enables RCON on port 25576 with the password in `data/server/rcon.password`. `src/eval/task.ts` is the schema and documents every field; the ones that shape a run rather than decorate it:

| Field | Why it exists |
|---|---|
| `setup.arena` | A sealed, lit stone box with the bot in the middle. Combat rungs otherwise lose to the terrain lottery - real Nether ground is magma over a lava sea and kills the bot before it acts. `summon`ed mobs appear inside it. |
| `setup.portal_room` | A lit overworld room with a working 3x3 `end_portal` (placed directly - a stronghold's own portal costs twelve eyes and is not what the rung measures), the spawnpoint set beside it, and chests holding `spares` copies of the `give` kit. This is the way home for a rung with `keep_inventory` off. |
| `setup.keep_inventory` | On by default: a combat rung that strips the bot on every death makes each retry strictly worse than the last and measures despair. Off is the real game, and needs a `portal_room` to be fair. |
| `setup.locate` | Put the bot near the nearest structure of a kind. `spread: true` (default) picks solid non-lava footing; a raw tp lands inside a wall. |
| `fresh_workspace` | Archive the agent's own `shem/` scripts to `data/<agent>/script-archive/` before the run. A fresh mind with a workspace full of its previous attempts is not a fresh run - the scripts are in its orientation, so run N inherits run N-1's habits. Off by default; accumulating scripts is the point in normal play, just not in a measurement. |

`give` entries are split into stacks automatically: `item replace block` silently refuses counts over 64, so `arrow 320` in a spare kit chest becomes five stacks rather than nothing at all.

## What it costs

`bin/golem cost [agent...] [--hours N]` prints turns, input tokens (cached and not), tool calls per turn, compactions and the tool histogram per agent from the transcripts. If tool calls per turn creep past four, read a turn in the dashboard and see what the mind is doing one call at a time; usually it wants a library script.

## The dashboards

`golem up` prints `http://127.0.0.1:8770/` for the fleet and `http://127.0.0.1:8770/agents/<name>` for each agent. On a loopback bind they open with no token (`fleet.dashboard_auth = "none"`, the default); set it to `"token"` and the pages ask for the fleet token once and remember it in localStorage. The mind's `/mcp` endpoint always needs its token whatever the setting.

The fleet page: one card per agent (health and food bars, the server and account it is on, level, what it is holding and doing, a live hotbar, its last line said, its goal), a live timeline of everything said, bussed, run and reflexed across the fleet with filters, a composer that speaks as the owner to one agent or everyone, the shared world files (tasks, places, chests) with search, and a `met all` button. The agent page: the state bar (position, biome, level, status effects, on fire / drowning / asleep), the live transcript (prompts, agent text, tool calls with results, thoughts, turn ends with model and tokens) with filters, a Body panel with three tabs (the inventory as a slot grid with armour, offhand and hotbar plus totals; the body's connection, server, account, facing, light, armour, effects, world clock, players online and nearby entities; the mind's adapter, model, session, hourly turn and token budget and context), the inbox, runs, reflex toggles, the latest picture (or take a new one), a context meter, a chat box with the owner fast paths (`goal …`, `met`, `status`, `come`, `mode <reflex> off`), and a met button. No build step: `src/dashboard/{fleet,index}.html` share `style.css` and `common.js` and sit over the bridge's SSE and JSON routes; set `GOLEM_DEV=1` to reload them from disk on every request.

## Watching a mind

`data/<agent>/transcript.jsonl` has every prompt Golem sent, every Golem tool call with its result, and the agent's text. `data/<agent>/mind.log` is the ACP adapter's stderr. `data/<agent>/workspace/` is what the agent sees: read `AGENTS.md` there to see the orientation it got. The bridge's SSE stream (`GET /agents/<name>/events`) carries the same in real time; `golem talk` is a thin client for it.

## Checks

```bash
npm run typecheck
npm test
```

## Where things live

| Path | What |
|---|---|
| `data/<agent>/clef/` | the body's game dir: config/mezzoclef.json, mods, logs |
| `data/<agent>/clef.log` | launcher + client stdout |
| `data/<agent>/trace.jsonl` | every command, response and event, plus Golem markers |
| `data/<agent>/shots/` | screenshots |
| `data/<agent>/tokens.json` | Clef control token and Golem MCP token (0600) |
| `data/server/` | dev server (jar, world, log) |

## Ports

Golem stays off MezzoSopranoClef's defaults so both projects' tests can run side by side: dev server `25566` (Clef e2e uses `25565`), body control ports from `9731` (Clef's default is `8731` and its verify scripts use `8741` and up), Golem HTTP `8770`.

If a body or server dies with exit 143 and you didn't stop it, something else on the machine sent SIGTERM. MezzoSopranoClef's verify scripts do `pkill -f "mezzoclef.headless=true"` and `pkill -f "server.jar nogui"` between runs. Golem sidesteps both: the server jar is `mc-<version>-golem-dev.jar`, and bodies are launched with `-Dmezzoclef.headless=TRUE` (same meaning to Java, invisible to a case-sensitive pkill). `bench_e2e.sh` also kills `knot.KnotClient`, which we can't dodge; if that runs, `golem up` respawns the body.

Golem also refuses to drive a body that isn't its own: ours always require a token and log in with the agent's username. If `golem shell` says the body on the port is logged in as someone else, another project's bot took the port.

## Reading a production body

The launcher runs an obfuscated client, so screen names come back as `class_424` and friends (CLEF-CHANGES #17). Dev clients (`./gradlew runClient` in Clef) show real names. Golem never keys logic on them.

## Restarting the fleet in place

`scripts/restart-up.sh [agent...]` stops `golem up` gracefully, refuses to relaunch while any body process or control port survives, relaunches, and waits for the fleet. Sessions resume from `data/<agent>/session.json`. Use it instead of killing and relaunching by hand: a body left behind keeps its username logged in and gets its replacement kicked with "logged in from another location".

Evals run beside the live fleet on their own agent and ports: `bin/golem eval tasks/basic Tester --config golem.eval.toml --label <name>`, then `bin/golem eval-report`.
