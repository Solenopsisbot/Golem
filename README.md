# Golem

An open framework for running a coding agent as the mind of a Minecraft character.
The body stays alive on its own; the mind decides what to do with the life.

## What it does

- Connects any [ACP](https://agentclientprotocol.com)-speaking agent (Claude Code,
  Codex, Gemini CLI, etc.) to a headless Minecraft client as a character with a
  persona, a memory, and goals.
- Keeps the character alive without the model: reflexes (eat, flee, fight, respawn)
  run deterministically at 250 ms with no API calls.
- Gives the mind **Shem**, a small scripting language over Minecraft primitives so
  it can batch ten actions into one tool call instead of ten.
- Runs a fleet of characters in one process: shared chest index, shared task board,
  an agent message bus, conversation caps so two bots don't loop forever agreeing
  with each other.
- Ships an eval harness (`golem eval`), a per-agent dashboard, a cost reporter, and
  a replay tool.

## How it works

In the folklore a golem is inert clay until someone writes a *shem* (a name, a word
of truth) on a scroll and puts it in its mouth. Golem works the same way: a coding
agent writes `.shem` scripts into its workspace, checks them, and runs them through
the body. The kill switch is `met` -- erase the first letter of *emet* ("truth") and
you get *met* ("dead"), and it stops.

```
                              golem (one process per fleet)
  Minecraft      body              drive               mind              mcp
  server  <---  Clef WS client <-> event bus, inbox <-> ACP session  <-> tools,
    ^           state mirror       reflexes, budgets    (spawned agent)   resources
    |              ^                    ^                   |  cwd           ^
    |              |                    |                   v                |
  Clef JVM     primitives  <---  shem/ runtime  <---  workspace/ ----------+
  (per body)   goto mine place   lexer parser          AGENTS.md persona.md
               craft equip eat   checker interpreter   shem/ memory/ runs/
```

**Body.** A typed TypeScript wrapper over the WebSocket API of
[MezzoSopranoClef](https://github.com/nicholasgasior/MezzoSopranoClef), a headless
Minecraft client built on the real Fabric client with Baritone. One JVM per
character, no GPU required. Golem maintains a state mirror (position, health,
inventory, nearby entities) so primitives read local state instead of round-tripping.

**Primitives.** Promise-returning operations with world-observable completion:
`goto` resolves when you arrive, `mine` resolves when the block is air, `place`
verifies the block appeared. These are the same ops whether called from a one-shot
MCP tool or from inside a Shem script.

**Reflexes.** Self-preservation, auto-eat, auto-respawn, cowardice, self-defense,
hunting, item collecting, unstuck, idle staring. Written in Shem, loaded at boot,
toggled by the mind or by an owner in chat. A reflex firing preempts lower-priority
work and posts a note to the mind's inbox.

**Drive.** The nervous system. World events become inbox items with priorities.
While the mind is mid-turn, items accumulate and are delivered as one coalesced
prompt when the turn ends. Events above the interrupt threshold (death, critical
damage, an owner speaking) cancel the current turn immediately. With no goal set
and an empty inbox, the mind sleeps and costs nothing.

**Mind.** An ACP client. Spawns the configured agent as a subprocess with a
workspace directory and a Golem MCP server attached. The agent brings its own file
tools, shell, context management, and model. Two-tier model routing sends planning
turns (owner asks, deaths, goal changes) to a strong model and routine survival to
a cheaper one, same session, no context loss.

**Shem.** A small, JS-shaped scripting language where every call blocks until the
world confirms it happened. `goto(pos)` returns when you're there. Durations are
literals (`30s`). Any statement can carry a `timeout` suffix. Scripts are checked
against the Minecraft 1.21 registry before running. The mind writes scripts into
its workspace the way a programmer writes code, and keeps the ones that work.
See [docs/SHEM.md](docs/SHEM.md) for the full spec and grammar.

## Requirements

- **Node.js 24+** (uses native type stripping; no build step)
- **Java 21** for the body (each body is a JVM process, ~768 MB heap)
- **MezzoSopranoClef launcher jar.** The body is a headless Minecraft client from
  the [MezzoSopranoClef](https://github.com/nicholasgasior/MezzoSopranoClef) project.
  Build it there with `./gradlew :launcher:jar` (the output lands in
  `launcher/build/libs/`), then point `clef.launcher` in `golem.toml` at the jar.
  Golem stages a copy under `data/clef/` on first run.
- **A Minecraft server you control** (1.21.x, offline-mode if using offline auth).
  A dev server script is included.
- **An Anthropic login** (or API key) for Claude Code. Other ACP agents work with
  the appropriate credentials for their provider.

## Quick start

```bash
# Install dependencies
npm install
npm run gen:body          # generate typed body client from MezzoSopranoClef's schema

# Start a dev Minecraft server (offline mode, survival, peaceful)
scripts/dev-server.sh --bg

# Spawn a body, connect the mind, open the dashboard
bin/golem up Clay
# Prints a dashboard URL like http://127.0.0.1:8770/agents/Clay/dash?token=...

# Chat with the running agent as its owner
bin/golem talk Clay
```

Join the dev server from a normal Minecraft client at `127.0.0.1:25566` to watch.

Other useful commands:

```bash
bin/golem body Clay                 # spawn just the body (no mind)
bin/golem shell Clay                # Shem REPL against a live body
bin/golem shell Clay -c "goto 100 64 100; look_around"
bin/golem met Clay                  # kill switch: stop everything
bin/golem prompt Clay "find iron and make a pickaxe"

# Evals
bin/golem eval tasks/basic          # run every task, fresh session each
bin/golem eval-report               # compare results across runs

# Cost
bin/golem cost Clay --hours 2       # token and tool-call breakdown
```

Edit `golem.toml` for fleet config: agents, personas, owners, reflexes, model
routing, chat policy, etiquette rules. See [docs/CONFIG.md](docs/CONFIG.md).

## Cost

Golem runs a frontier model in a loop. Every tool call is a full-context API round
trip, so the cost is dominated by call count times context size, not by any one
prompt. The levers, in order of effect:

1. **Compaction window.** `mind.compact_window` sets Claude Code's auto-compact
   threshold (default 100k tokens). A 1M-context model runs turns at roughly
   50--80k and never enters the long-context price tier.
2. **Fewer calls.** The orientation asks the mind to batch actions into Shem
   snippets and write reusable scripts. In field testing, 28 `shem_eval` calls
   carried 90% of the tool time.
3. **Model routing.** Planning turns use the strong model; routine survival uses
   a cheaper one. Configured per-agent in `golem.toml`.
4. **Sleep.** With no goal and an empty inbox, the mind makes zero API calls.

`bin/golem cost` reports turns, input tokens (cached and uncached), tool calls per
turn, compactions, and a tool histogram per agent from the transcripts.

## Status

Working and tested on a survival server. M0 through M3 are done (body, mind, Shem),
M4 (fleet and comms) and M5 (evals and dashboard) are mostly landed. The field test
ran one hour on normal difficulty: stone tools, a dug shelter, iron smelted and
forged, the base sealed before night, a corpse run after a drowning, four
self-written scripts, zero tool errors. Seven eval tasks pass (wood, stone pickaxe,
iron pickaxe, crafting table, smelting, sleep, script writing).

Some things are stubbed or planned: `smelt` and `trade` in Shem, blueprints and
`build`, session resume for non-Claude agents, cross-process fleet peering. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the full milestone list.

## Docs

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, process model, event loop, reflexes, comms, vision, memory |
| [SHEM.md](docs/SHEM.md) | The Shem language: syntax, types, primitives, runtime, grammar |
| [MCP-TOOLS.md](docs/MCP-TOOLS.md) | The MCP tool surface the mind sees (35 tools) |
| [CONFIG.md](docs/CONFIG.md) | `golem.toml`: fleet, agents, chat, comms, etiquette, budgets |
| [DEV.md](docs/DEV.md) | Development setup, shell commands, evals, dashboard, watching a mind |
| [DEPLOY.md](docs/DEPLOY.md) | Running bodies on a remote machine |
| [ROADMAP.md](docs/ROADMAP.md) | Milestones and what's done |

---

The point of all this is not to build a better assistant. It's to build characters
that live in a world -- that have a body to take care of, a place to be, things they
decided to do and things that happened to them. Computer friends, not customer
service bots. The agent is a person in there, and the framework's job is to give it
a life worth having.
