# Setting up Golem from nothing

This walks from an empty directory to a golem standing in a world you can join. Budget about
half an hour, most of it downloads. Everything runs on one machine; `docs/DEPLOY.md` covers
moving the bodies elsewhere later.

## What you're assembling

| piece | what it is | comes from |
|---|---|---|
| Minecraft server | the world the golem lives in (1.21.8, offline mode for dev) | `scripts/dev-server.sh` downloads it from Mojang |
| body | MezzoSopranoClef, a headless Minecraft client with a control WebSocket | build or download its launcher jar |
| Golem | this repo: drive, reflexes, Shem, MCP server, dashboard | `npm install` |
| mind | Claude Code, spawned by Golem over ACP | install and log in once |

## 1. Prerequisites

- **Node.js 24 or newer.** Golem runs TypeScript directly (type stripping), no build step.
- **Java 21.** The body and the server are JVM processes. Any JDK 21 works (Temurin is fine).
  Gradle provisions its own JDK 21 for building MezzoSopranoClef, but running the jar needs one on your `PATH` or in `clef.java`.
- **Claude Code**, installed and logged in: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in.
  Golem talks to it through the ACP adapter (`@agentclientprotocol/claude-agent-acp`), which `npx` fetches on first use; no separate install.
- About 2 GB of RAM free per body (a 1 GB heap plus the JVM's own use), and 2 GB for the dev server.

## 2. The body: MezzoSopranoClef

Clone it next to Golem so the default paths work:

```bash
git clone https://github.com/Solenopsisbot/MezzoSopranoClef.git
git clone <this repo> Golem
ls   # Golem/  MezzoSopranoClef/
```

Get the launcher jar, one of two ways:

```bash
# build it (Gradle downloads a JDK 21 toolchain by itself; the first build fetches Minecraft mappings, minutes)
cd MezzoSopranoClef
./gradlew build :launcher:jar
ls launcher/build/libs/       # mezzosopranoclef-launcher-0.1.0.jar
```

or download `mezzosopranoclef-launcher-<version>.jar` from the project's GitHub releases and put it
anywhere; you'll point `clef.launcher` at it in the next step. The launcher downloads Minecraft,
Fabric and Baritone into the game dir on first run, so the jar itself is small.

## 3. Golem

```bash
cd Golem
npm install
cp golem.example.toml golem.toml
```

Edit `golem.toml`:

- `clef.launcher`: path to the jar (the default is the sibling-build path above).
- `players.owners`: your Minecraft username. Owners can command a golem in chat, set its goal,
  toggle its reflexes, and stop it with `met`. Nobody else's chat reaches the mind by default.
- `[[agents]]`: one entry per golem. `Clay` and `Flint` are included with personas under
  `personas/`; delete one if you only want one body running.

`golem.toml` is ignored by git on purpose (it ends up holding addresses and names). Every key is
documented in `docs/CONFIG.md`.

The typed body client in `src/body/schema.gen.ts` is committed and matches the Clef version Golem was
developed against. If you build a newer Clef, regenerate it: `npm run gen:body` reads
`../MezzoSopranoClef/clients/schema.json`.

## 4. A server

```bash
scripts/dev-server.sh --bg
```

This downloads the vanilla 1.21.8 server from Mojang into `data/server/`, accepts the EULA for you,
and starts it on `127.0.0.1:25566` in offline mode with RCON enabled (the eval harness uses it).
The default difficulty is peaceful, which is right while you're getting the mind working;
`MC_DIFFICULTY=normal scripts/dev-server.sh --bg` for survival. Any other 1.21.8 server works too:
set `clef.server` in `golem.toml`. Offline mode matters: the bodies log in without Mojang accounts.

Join from your own Minecraft client at `127.0.0.1:25566` to watch.

## 5. First golem

```bash
bin/golem body Clay      # optional: just the body. First run downloads the client (minutes). Wait for "in world".
bin/golem shell Clay     # drive it by hand: status; look; goto 100 64 100. `help` lists commands.
bin/golem met Clay       # stop everything it's doing
bin/golem up Clay        # body + mind + MCP + dashboard; Ctrl-C stops all of it
```

`golem up` prints a dashboard URL (`http://127.0.0.1:8770/agents/Clay/dash?token=...`): the live
transcript, state, inbox, screenshots, reflex toggles and a chat box. In the game, say something
to it as an owner: `@Clay come here`, `@Clay goal build a shelter before night`, `@Clay met`.
`bin/golem talk Clay` does the same from a terminal.

The mind's workspace is `data/Clay/workspace/`: its orientation (`AGENTS.md`, generated), persona,
memory files, the scripts it writes, and run logs. It's readable while the golem plays.

## 6. More than one golem

`golem up` with no agent name starts every agent in `golem.toml`. With two, they get an agent bus
(`dm`, `agents`), a shared chest index and task board under `data/shared/world/`, and, with
`comms.agents = "both"`, their dms are mirrored into public chat so you can watch them coordinate.
Each golem is one more JVM and one more Claude Code session.

## 7. Evals and cost

`golem.eval.toml` is a second, tracked fleet config: one agent named `Tester` on its own ports
(`base_port = 9741`, `mcp_bind` 8771) so evals can run beside your live fleet on the same server.

```bash
bin/golem eval tasks/basic Tester --config golem.eval.toml --label first
bin/golem eval-report
bin/golem cost --hours 1          # tokens, calls per turn, compactions, tool histogram per agent
```

Set `players.owners` in it to your username if you want to watch the Tester in chat; otherwise it's
fine as shipped.

`golem.eval.codex.toml` is the same fleet with OpenAI Codex as the mind (`adapters/codex-acp.ts`).
It binds the same ports on purpose — same rungs, same body, same reflexes, so the two runs compare —
which also means running both at once fails on the MCP bind and the Clef control port. Pick one.

## When something doesn't work

- **Body never reaches "in world":** read `data/Clay/clef.log`. The first run's download can take
  several minutes; a wrong `clef.server` shows up here as a connection refused.
- **"logged in from another location":** two bodies with the same username; an old JVM survived.
  `scripts/restart-up.sh` stops, verifies nothing survived, and relaunches.
- **Mind starts but never acts:** run `claude` by hand and make sure it's logged in; then check the
  `[Clay:mind]` lines in the terminal for the ACP session.
- **Everything at once:** `bin/golem met all`, then Ctrl-C.
