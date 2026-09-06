# Golem

An embodied-agent framework for Minecraft. Mindcraft-shaped, with a different spine:

- the **body** is a [MezzoSopranoClef](../MezzoSopranoClef) headless client: the real Fabric client, Baritone, no GPU;
- the **mind** is any coding agent that speaks [ACP](https://agentclientprotocol.com): Claude Code, Codex, Gemini CLI, Kimi, OpenCode, ...;
- the **shem** is the script the mind writes and puts in the body's mouth.

In the folklore a golem is inert clay until someone writes a *shem* (a name) on a scroll and puts it in its mouth. Rub out the first letter of *emet* ("truth") on its forehead and you're left with *met* ("dead"), and it stops. So: skills are `.shem` files, and the kill switch is `met`.

## Why not just run Mindcraft

Mindcraft is good and Golem steals its best ideas: profiles, modes, a code sandbox, self-prompting, agent-to-agent chat, a task harness. It differs in three deliberate ways.

1. **The mind is a real coding agent, not a prompt loop.** Golem is an ACP *client*. It spawns Claude Code (or whatever you configure) with a workspace directory as `cwd` and a Golem MCP server attached. The agent brings its own file tools, shell, context management and model. We don't write the agent loop; we write the body, the world it lives in, and the language it thinks in.
2. **The body is the real client.** Mineflayer reimplements the protocol and physics in JS and trails versions. MezzoSopranoClef *is* the Minecraft client, so anything a player can do the bot can do, on any server the client can join, modded or not.
3. **Skills are files.** The agent writes Shem scripts into its workspace, checks them, runs them with parameters, and keeps the ones that work. A coding agent is already excellent at exactly that loop, so the skill library grows the way a codebase does.

## Read next

| Doc | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, process model, the event loop, reflexes, comms, vision, memory, where things run |
| [docs/SHEM.md](docs/SHEM.md) | The Shem scripting language: syntax, types, primitives, runtime, grammar |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | The MCP tool surface the mind sees |
| [docs/ACP.md](docs/ACP.md) | How Golem drives an agent over ACP: sessions, prompt turns, permissions, resume |
| [docs/CONFIG.md](docs/CONFIG.md) | `golem.toml`: fleet, agents, chat, comms, etiquette, budgets |
| [docs/CLEF-CHANGES.md](docs/CLEF-CHANGES.md) | What Golem needs added to MezzoSopranoClef, prioritised, with proposed shapes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones |
| [docs/IDEAS.md](docs/IDEAS.md) | Everything else worth building, ranked |

## Status

M0 through M3 done, M4 (fleet and comms) in progress, M5 (evals, dashboard) mostly in (see `docs/ROADMAP.md`). `golem up Clay` boots a body, joins the dev server, spawns Claude Code over ACP with the Golem MCP server attached, and turns world events into prompt turns; `golem talk Clay` chats with it through the bridge. Shem (M3) is in: the mind writes `.shem` scripts into its workspace, checks and runs them through `shem_*` tools, and the standard library in `shem/lib/` is written in Shem itself. Two golems run in one `golem up`, talk over an agent bus, and share a chest index and task board. `docs/DEV.md` is the quickstart; `docs/ARCHITECTURE.md` records the decisions.

## Planned layout

```
golem.toml              fleet config
personas/               one markdown file per character
shem/lib/               shipped standard library (collect, craft, smelt, build, ...)
tasks/                  eval tasks (json)
src/
  body/                 typed wrapper over the Clef WebSocket API + waits/timeouts
  primitives/           goto/mine/place/craft/... as promise-returning ops
  shem/                 lexer, parser, checker, interpreter, run manager
  reflexes/             built-in reflexes (as .shem, loaded at boot)
  mind/                 ACP client: spawn, session, prompt turns, permissions
  mcp/                  the per-agent MCP server (Streamable HTTP, in-process)
  drive/                event bus, inbox, coalescing, interrupts, self-prompting
  comms/                chat routing, player policy, agent bus, conversations
  world/                chest index, deaths, places, journal
  fleet/                spawn Clef launcher jars, attach to running bots, lifecycle
  cli/                  golem up / attach / shell / eval / replay
data/<agent>/           runtime state (workspace, runs, shots, journal)
```
