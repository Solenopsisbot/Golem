#!/usr/bin/env bash
# Regenerate the End so a dragon rung can be run again: fresh island, ten crystals, a new dragon
# generated on first entry.
#
# Only valid while the CURRENT dragon is still alive - after an aborted run, not after a won one.
# Once a dragon has been killed, level.dat carries DragonKilled and a new DragonUUID, and deleting
# DIM1 does not bring it back: the region files regenerate but the fight state says the fight is
# over, so you get an empty island. Undoing that means editing NBT. Copy data/server/world before
# the first dragon run and it is a restore instead.
#
#   scripts/regen-end.sh          # stop, swap DIM1 aside, restart
#
# The old dimension is moved rather than deleted, so a mistake here is recoverable.
set -euo pipefail
cd "$(dirname "$0")/.."

JAR_PATTERN="${MC_JAR_PATTERN:-mc-.*-golem-dev.jar}"
[[ -f data/server/rcon.password ]] || { echo "no data/server/rcon.password - is the dev server set up?" >&2; exit 1; }

# Refuse rather than produce a dragonless End. This check is the whole point of the script: the
# failure it prevents looks exactly like success until the bot walks onto an empty island.
node - <<'EOF'
import { Rcon } from "./src/eval/rcon.ts";
import { readFileSync } from "node:fs";
const pw = readFileSync("data/server/rcon.password", "utf8").trim();
const r = new Rcon("127.0.0.1", 25576, pw);
await r.connect();
const alive = await r.command("execute in minecraft:the_end run execute if entity @e[type=ender_dragon]");
if (!alive.includes("Test passed")) {
  console.error("REFUSING: no live dragon in the End. level.dat's fight state would need resetting too;");
  console.error("restore a copy of data/server/world taken before the kill instead.");
  r.close();
  process.exit(2);
}
await r.command("save-all flush");
await new Promise((s) => setTimeout(s, 3000));
await r.command("stop");
r.close();
EOF

# Wait for the JVM to actually exit: moving DIM1 out from under a running server corrupts it.
for _ in $(seq 1 40); do pgrep -f "$JAR_PATTERN" >/dev/null || break; sleep 2; done
if pgrep -f "$JAR_PATTERN" >/dev/null; then echo "server did not stop; not touching the world" >&2; exit 1; fi

spent="data/server/world/DIM1.spent-$(date +%Y%m%d-%H%M%S)"
mv data/server/world/DIM1 "$spent"
echo "moved the old End to $spent"

MC_DIFFICULTY="${MC_DIFFICULTY:-normal}" bash scripts/dev-server.sh --bg
for _ in $(seq 1 60); do grep -q "RCON running" data/server/server.log && break; sleep 2; done
echo "server back up; the End regenerates with its dragon on first entry"
