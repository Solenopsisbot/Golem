# Running bodies on another machine

The mind (Claude Code over ACP), the Golem process and the Minecraft server can stay on one machine
while the bodies run elsewhere. A body is a MezzoSopranoClef headless client: one JVM per golem,
about 1 GB of heap, no GPU needed (`noGl`, raytrace screenshots). Golem attaches over the client's
control WebSocket with a shared token.

## On the body host

Any x86-64 Linux box with Java 25 works (no root needed; everything below lives in the home directory). Java 21 ran the launcher when this was written and no longer does - the current Clef jar throws `UnsupportedClassVersionError` on it.

| what | where |
|---|---|
| JDK 25 (a Temurin tarball if the system JDK is older) | `~/jdk/jdk25` |
| launcher jar (copied from `data/clef/launcher.jar` on the Golem machine) | `~/golem-bodies/launcher.jar` |
| per-body game dir and config | `~/golem-bodies/<Agent>/game/config/mezzoclef.json` |
| logs | `~/golem-bodies/<Agent>/logs/clef.log` |
| services (`systemctl --user`; enable lingering so they outlive logout) | `~/.config/systemd/user/golem-body-<Agent>.service` |

The body config is what `ensureBodyConfig` in `src/fleet/body.ts` writes, pointed at your server and
bound on all interfaces so the Golem machine can reach it:

```json
{
  "auth": { "mode": "offline", "offlineUsername": "<Agent>" },
  "connection": { "autoConnect": true, "serverHost": "<minecraft-server-host>", "serverPort": 25566, "autoRespawn": true },
  "control": { "enabled": true, "host": "0.0.0.0", "port": 9731, "authToken": "<the clef token from data/<Agent>/tokens.json>", "auditLog": true },
  "screenshot": { "backend": "raytrace", "defaultWidth": 960, "defaultHeight": 540, "maxRayDistance": 96 },
  "headless": true, "noGl": true, "headlessLoopSleepMs": 10
}
```

A user service per body:

```ini
[Unit]
Description=Golem body <Agent>
After=network-online.target

[Service]
WorkingDirectory=%h/golem-bodies/<Agent>
Environment=CLEF_GAMEDIR=%h/golem-bodies/<Agent>/game
Environment=CLEF_MAX_HEAP=1024m
Environment=CLEF_BG_THREADS=4
Environment=JAVA_HOME=%h/jdk/jdk25
ExecStart=%h/jdk/jdk25/bin/java -Dmezzoclef.headless=TRUE -jar %h/golem-bodies/launcher.jar
Restart=always
RestartSec=5
StandardOutput=append:%h/golem-bodies/<Agent>/logs/clef.log
StandardError=append:%h/golem-bodies/<Agent>/logs/clef.log

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
loginctl enable-linger $USER
systemctl --user start golem-body-<Agent>
tail -f ~/golem-bodies/<Agent>/logs/clef.log
```

First start downloads Minecraft and Fabric into the game dir (a few minutes).

## On the Golem machine

Under the agent in `golem.toml`:

```toml
[[agents]]
name = "<Agent>"
persona = "personas/<agent>.md"
body.attach = "<body-host>:9731"
```

Golem reuses the `clef` token it already keeps in `data/<Agent>/tokens.json`, so put that same
token in the body config. Remove the `attach` line to run the body locally again. Stop the remote
body before launching a local one with the same username, or the server kicks one of them
("logged in from another location").

## Networking

The control port carries a bearer token and nothing else, so keep it off the public internet: a
LAN, or a tailnet (which is also the easy answer when a host firewalls its LAN interface; check
with `nc -z <host> 9731` from the Golem machine). The body needs to reach the Minecraft server
too, in whatever direction your network allows.

## Running an eval unattended on a headless Linux box

A long rung (the dragon ones run up to two hours) wants to be somewhere that isn't a laptop that
sleeps. The whole fleet - server, bodies, Golem, mind - moves to one Linux box happily, with three
things that will each cost you an evening:

- **Clef needs an X display even headless.** It asks GLFW for the null platform, but the bundled
  GLFW still initialises X11 on Linux and dies with `DISPLAY environment variable is missing` over
  SSH. Run it under `xvfb-run -a -s "-screen 0 1280x720x24"`. `-a` picks a free display instead of
  fighting a desktop session already on `:1`.
- **JDK 21 is not enough for the Clef jar** any more: it throws `UnsupportedClassVersionError`.
  Install a JDK 25 tarball under `~/.local/jdk` and put it first on `PATH` - no root needed.
- **Stop the mind before the bodies.** An eval supervises its Clef body and respawns it within
  seconds, so killing bodies first just breeds new ones. Kill `cli/golem.ts` first, wait, then
  `mezzoclef`.

Two more traps in the stopping, both of which produced an orphan holding the MCP port while every
relaunch failed:

- The eval runs as `node src/cli/golem.ts ...` with **relative** paths, so a `pkill -f` matching the
  checkout path misses it entirely.
- `pkill -f` matches **your own** command line. Over SSH the pattern is in the shell's argv, so the
  kill takes out the session that issued it and looks like the box hung. Put the pattern in a script
  file, and skip `$$` when iterating.

```bash
# ~/run-golem-eval.sh <task-path> <label> [config]
export PATH="$HOME/.local/jdk/jdk-25.0.4.1+1/bin:$HOME/.npm-global/bin:$PATH"
cd "$HOME/coding/mc/Golem"
exec xvfb-run -a -s "-screen 0 1280x720x24" \
  node src/cli/golem.ts eval "$1" Tester --config "${3:-golem.eval.toml}" --label "$2"
```

Launch it with `ssh <host> 'nohup ~/run-golem-eval.sh tasks/endgame/7_dragon_hard.json run1 >/tmp/eval.log 2>&1 &'`
and the run survives your laptop closing. `data/eval/*.json` is written when it ends either way, so
`bin/golem eval-report` on the box is the result whether or not you were watching.

## Moving the rest

The Minecraft server can move the same way (`scripts/dev-server.sh` runs a plain Java process;
copy `data/server` and point the body configs at the new host). Golem itself and Claude Code need
Node and an Anthropic login on whatever machine runs them; nothing in Golem assumes the bodies are
local except `golem up` supervising them when `body.attach` is unset.
