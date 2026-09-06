# Deploying bodies away from the laptop

The mind (Claude Code over ACP), the Golem process and the dev server can stay on one machine while
the bodies run elsewhere. A body is a MezzoSopranoClef headless client: one JVM per golem, ~1 GB
heap, no GPU needed (`noGl`, raytrace screenshots). Golem attaches over the client's control
WebSocket with a shared token.

## cytonic (done 2026-09-06)

Arch Linux, 16 threads, 32 GB. No passwordless sudo, so everything lives in the home directory:

| what | where |
|---|---|
| JDK 21 (Temurin, user-local; the system has only 17) | `~/jdk/jdk21` |
| launcher jar (copied from `data/clef/launcher.jar`) | `~/golem-bodies/launcher.jar` |
| per-body game dir and config | `~/golem-bodies/<Agent>/game/config/mezzoclef.json` |
| logs | `~/golem-bodies/<Agent>/logs/clef.log` |
| services (`systemctl --user`, lingering enabled so they outlive logout) | `~/.config/systemd/user/golem-body-<Agent>.service` |

The body config points at the dev server on the laptop's LAN address (`192.168.0.74:25566`) and
binds its control port on `0.0.0.0` (9731 Clay, 9732 Flint) with the same `clef` token Golem keeps in
`data/<Agent>/tokens.json`, so `golem.toml` only needs `body.attach = "192.168.0.174:<port>"` under
the agent. Remove that line to run the body locally again.

Useful commands on cytonic:

```
systemctl --user status golem-body-Clay golem-body-Flint
systemctl --user restart golem-body-Flint
tail -f ~/golem-bodies/Clay/logs/clef.log
```

First start downloads Minecraft and Fabric into the game dir (a few minutes). The control port
is LAN-only; the token is the only auth, so don't expose it beyond the LAN or the tailnet.

## Moving the rest

The dev server can move the same way (`scripts/dev-server.sh` is a plain Java process; copy
`data/server` and point the body configs at the new host). Golem itself and Claude Code need Node
and an Anthropic login on whatever machine runs them; nothing in Golem assumes the bodies are local
except `golem up` supervising them when `body.attach` is unset.
