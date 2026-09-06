# Developing Golem

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

## The dashboard

`golem up` prints a URL like `http://127.0.0.1:8770/agents/Clay/dash?token=…`. One page per agent: the state line, the live transcript (prompts, agent text, tool calls with results, turn ends with model and tokens), the inbox, runs, reflex toggles, the latest picture (or take a new one), a chat box that speaks as the first owner (fast paths like `goal …` and `met` work there too), and a met button. The page remembers the token in localStorage after the first open. No build step: it's `src/dashboard/index.html` over the bridge's SSE and JSON routes.

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
