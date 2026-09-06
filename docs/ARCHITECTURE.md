# Architecture

## Decisions taken

| # | Decision | Why |
|---|---|---|
| 1 | **TypeScript** (Node 26 / Bun 1.3) | ACP and MCP reference SDKs are TS-first, the Claude Code ACP adapter is TS, Clef ships a TS client, and a parser/interpreter is pleasant in TS. Python is viable (`agent-client-protocol` and `mcp` on PyPI) and is your home stack; say the word and this flips before any code exists. |
| 2 | **Golem is an ACP client; the mind is a spawned agent subprocess** | We get Claude Code's tools, context handling, and model for free. Any other ACP agent is a config change. |
| 3 | **One MCP server per agent, hosted in-process over Streamable HTTP** | Keeps body state, the Shem runtime and the tools in one process. A stdio shim is provided for agents that only speak stdio MCP. |
| 4 | **Reflexes run in Golem, deterministic, no LLM** | Self-preservation at 200 ms is a code problem. The model is told afterwards. |
| 5 | **Speech is explicit by default** | Coding agents narrate. Only the `say` tool reaches in-game chat unless `chat.speech = "auto"`. |
| 6 | **Skills are `.shem` files in the agent's workspace** | Files are what coding agents are good at. Golem indexes them and regenerates the workspace orientation doc. |
| 7 | **One body per JVM, one mind per body, one workspace per agent** | Mirrors Clef's fleet model and keeps blast radius small. |
| 8 | **Owner chat interrupts the mind** (priority 80, same as the interrupt threshold) | A cancelled ACP turn keeps its session history, so responsiveness costs only the in-flight tool call. Everything below the threshold waits for the current turn. |
| 9 | **Dev world is peaceful by default** | Nights on a normal-difficulty world killed the unarmed bot every two minutes and buried the mind in death interrupts. `MC_DIFFICULTY=normal` for survival tests. |

## The pieces

```
                 ┌─────────────────────────────── golem (one process per fleet) ───────────────────────────────┐
                 │                                                                                             │
   Minecraft     │   body/<agent>            drive/<agent>            mind/<agent>          mcp/<agent>        │
   server ◄──────┼── Clef WS client ◄──────► event bus, inbox, ◄────► ACP session  ◄──────► tools/resources    │
      ▲          │   (typed, waits)          reflexes, budgets         (spawned agent)       (HTTP, per-agent   │
      │          │        ▲                        ▲                        │               bearer token)      │
      │          │        │                        │                        │ cwd                ▲             │
      │          │   primitives/ ◄──────── shem/ runtime ◄───────── data/<agent>/ workspace ─────┘             │
      │          │   goto mine place craft  lexer parser checker    AGENTS.md persona.md shem/ memory/ runs/  │
      │          │                          interpreter runs                                                   │
      │          │                                                                                             │
   Clef JVM      │   fleet/  spawns launcher jars or attaches to running bots; comms/ agent bus; world/ index  │
   (per body)    └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### body/
A typed wrapper over Clef's WebSocket API (`clients/schema.json` is the contract). Owns reconnect, the `hello` token, event subscription, and a **state mirror**: position, health, food, dimension, inventory, nearby entities, open screen, nav state, kept current from `tick`, `health`, `entitySpawn`, etc. Primitives read the mirror rather than round-tripping for every check.

### primitives/
Promise-returning operations with world-observable completion and typed failures. `goto(pos, reach)` resolves when the bot is within `reach` or Baritone reports done, rejects with `unreachable` or `timeout`. `mine(pos)` resolves when the block is air. `place(item, pos)` picks a face, selects the item, clicks, verifies. `craft(item, n)` uses Clef's recipe-book crafting (requested; see CLEF-CHANGES) and falls back to grid clicks driven by `minecraft-data` recipes. These are the same ops whether called from a one-shot MCP tool or from a Shem script.

### shem/
Lexer, parser, checker, tree-walking async interpreter, and a run manager (ids, priorities, cancellation, traces). Spec in `SHEM.md`.

### reflexes/
Mindcraft's modes, reimplemented as Shem `reflex` declarations shipped with Golem and loaded at boot: `self_preservation`, `unstuck`, `cowardice`, `self_defense`, `hunting`, `item_collecting`, `torch_placing`, `elbow_room`, `idle_staring`, plus `auto_eat`, `auto_respawn`. Because they are Shem, the agent can read them, toggle them, and (if allowed) edit them. A reflex firing preempts lower-priority runs and posts a note to the inbox.

### drive/
The nervous system. Subscribes to body events, applies the agent's config, and turns the world into prompt turns:

1. **Inbox.** Every interesting event (chat addressed to us, damage, death, a player arriving, a script finishing, a reflex firing, a goal timer) becomes an inbox item with a priority and a timestamp.
2. **Coalescing.** While the mind is mid-turn, items accumulate. When the turn ends, the whole inbox is rendered into one short prompt ("while you were working: ...") with a state header (position, health, food, time, current run). Nothing is dropped, nothing is sent twice.
3. **Interrupts.** Items above the configured priority (death, health below threshold, an owner addressing the bot) cancel the current turn via `session/cancel` and prompt immediately. Items below it wait.
4. **Idle and goals.** If the inbox is empty and a goal is set (`goal_set` tool, or `memory/goal.md`), Golem prompts "continue" on a cadence. With no goal the mind sleeps and costs nothing until something happens. Budgets (tokens per hour, turns per hour) are enforced here.
5. **Fast path.** Owner chat that matches a Golem command (`@Kiko met`, `@Kiko mode cowardice off`, `@Kiko goal build a hut`, `@Kiko status`) is handled deterministically without waking the mind.

### mind/
The ACP client. Spawns the configured agent (`npx @zed-industries/claude-code-acp` by default), initialises, creates a session with `cwd = data/<agent>/workspace` and the agent's MCP server, and runs prompt turns. Streams `session/update` into the transcript, dashboard and (if `speech = auto`) chat. Handles permission requests by policy, and file reads and writes by exposing the client-side `fs` capability with a workspace jail. Detail in `ACP.md`.

### mcp/
The per-agent Golem MCP server: one-shot tools for perception and action, `shem_*` tools for the workspace-scripts loop, comms tools, reflex toggles, and `met`. Also MCP resources (`golem://status`, `golem://inbox`, `golem://shem/lib`, `golem://runs/<id>`). Detail in `MCP-TOOLS.md`.

### comms/
- **Players.** `players.owners` can command and toggle; `trusted` get answered; `ignored` are dropped. `chat.listen` decides whether the bot hears everything, only when addressed (`Kiko`, `@Kiko`, whisper), or only owners.
- **Agents.** A message bus inside the Golem process (and over WebSocket between Golem processes) so bots can talk without spamming server chat. `comms.agents = bus | chat | both`; `both` mirrors bus messages as in-game whispers so players can watch. Conversations have explicit start/end and a max-turn cap so two bots don't loop forever agreeing with each other.

### world/
Golem-maintained knowledge the mind shouldn't have to rediscover: a **chest index** (every container opened, contents on close, position, dimension), deaths (where, why, what was carried), beds and portals seen, named places, and a daily **journal** digest of events. All written as JSON or markdown into the workspace so the agent can read and grep it.

### fleet/
Spawns Clef bodies from the launcher jar (`java -jar mezzosopranoclef-launcher.jar` with `-Dmezzoclef.*` overrides, one game dir per body under `data/<agent>/clef/`), or attaches to an already-running bot by host, port and token. Health-checks, restarts, and passes each body's token to its `body/` client and nobody else.

## Vision

Two layers, pixels second.

- **Structured perception** (default, cheap, exact): `look_around` returns a compact summary built from `findBlocks`, `entities`, `status`, the chest index and the state mirror: what's around by type and distance, nearest of each interesting thing, threats, terrain profile in the four cardinal directions, light and time. This is what the mind uses 90% of the time.
- **Pictures** (when aesthetics or layout matter): `see` returns a PNG as MCP image content from Clef's CPU raycaster (map-style colours, no GPU) or the GL backend when a context exists. Camera can be placed anywhere, so `see(from: above, of: base)` is a real thing. Planned: a top-down `map` render and screenshots annotated with entity labels and coordinates (camera parameters are known, so projecting entity positions is arithmetic).

The ACP adapter for Claude Code advertises `promptCapabilities.image = true`, so Golem can also push a picture *into* a prompt turn (a death screenshot, say) rather than only returning one from a tool.

## Memory and persistence

- `memory/` in the workspace is the agent's: `places.md`, `people.md`, `notes.md`, `goal.md`, `journal/YYYY-MM-DD.md`. The agent edits these with its own file tools.
- `world/` is Golem's (see above). The agent reads it, Golem writes it.
- On restart Golem uses `session/load` when the agent advertises `loadSession`; otherwise it opens a fresh session and injects the last journal entries plus `goal.md`.
- All body events and commands are appended to `data/<agent>/trace.jsonl` so `golem replay` can reconstruct how the bot ended up in the lava.

## Process and hardware

- One `golem` process per fleet; N agents inside it; N Clef JVMs beside it; N agent subprocesses beside those.
- Clef needs ~768 MB heap per body. ladybug (24 GB) comfortably runs a few for dev. cytonic (x86, 32 GB) is the fleet host. astral cannot run bodies (aarch64, no LWJGL natives). vega is off limits.
- The MCP server binds `127.0.0.1` and each agent gets its own bearer token so a mind can only drive its own body.
- `met` is wired at three levels: MCP tool, owner chat fast path, and `golem met <agent|all>` on the CLI.

## Settled (2026-09-06)

1. **TypeScript.**
2. **Speech is explicit**: only the `say` tool reaches chat.
3. **Dev world is a local survival server** (`scripts/dev-server.sh`, offline mode, port 25566 so Clef's own e2e keeps 25565). Control ports start at 9731 for the same reason (Clef's verify scripts also use 8741 and up).
4. **Personas are generic and hookable.** A persona is a markdown file plus the `[bridge]` config: an HTTP inbox and SSE event stream per agent, webhooks, and shell hooks, so any outside system (Discord, Ayusami, a web page) can push messages in and read what the agent does. Nothing in Golem knows about any particular outside system.

## Ports and processes on a dev box

| What | Where |
|---|---|
| Golem dev server | `127.0.0.1:25566` (`data/server/`) |
| Clay's body control plane | `127.0.0.1:9731` (`data/Clay/clef/`) |
| Golem MCP / bridge HTTP | `127.0.0.1:8770` (M2) |
| MezzoSopranoClef's own e2e | `25565` and `8731`, untouched |
