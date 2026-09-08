#!/usr/bin/env bash
# Boots a local offline-mode SURVIVAL Minecraft 1.21.8 server for Golem development.
#
#   scripts/dev-server.sh            # start (foreground; Ctrl-C stops it)
#   scripts/dev-server.sh --bg       # start in the background, logs to data/server/server.log
#
# The server jar is copied from MezzoSopranoClef's e2e fixture if present, otherwise downloaded from
# Mojang. The world lives in data/server/world and persists across runs. Offline mode is required
# so offline-auth bodies can join; don't expose this port to the internet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/data/server"
MC_VERSION="${MC_VERSION:-1.21.8}"
PORT="${MC_PORT:-25566}"   # 25565 is left free for MezzoSopranoClef's own e2e server
JAVA="${SERVER_JAVA:-java}"
DIFFICULTY="${MC_DIFFICULTY:-peaceful}"   # peaceful while developing the mind; set MC_DIFFICULTY=normal for survival tests
mkdir -p "$DIR"

JAR="$DIR/mc-$MC_VERSION-golem-dev.jar"   # not "server.jar": sibling projects pkill that pattern
if [[ ! -f "$JAR" ]]; then
  # The e2e fixture's server.jar is Mojang's bundler jar (the versions/ one lacks its libraries).
  SRC="$ROOT/../MezzoSopranoClef/e2e/server/server.jar"
  if [[ -f "$SRC" ]]; then
    echo "[dev-server] copying server jar from MezzoSopranoClef e2e fixture"
    cp "$SRC" "$JAR"
  else
    echo "[dev-server] downloading server $MC_VERSION from Mojang"
    VURL=$(curl -fsSL https://launchermeta.mojang.com/mc/game/version_manifest_v2.json \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(v['url'] for v in d['versions'] if v['id']=='$MC_VERSION'))")
    SURL=$(curl -fsSL "$VURL" | python3 -c "import sys,json;print(json.load(sys.stdin)['downloads']['server']['url'])")
    curl -fsSL "$SURL" -o "$JAR"
  fi
fi

echo "eula=true" > "$DIR/eula.txt"
if [[ ! -f "$DIR/server.properties" ]]; then
cat > "$DIR/server.properties" <<PROPS
online-mode=false
server-port=$PORT
gamemode=survival
difficulty=$DIFFICULTY
level-name=world
spawn-protection=0
view-distance=8
simulation-distance=6
max-players=10
enable-command-block=true
motd=Golem dev world
PROPS
fi

# Set a server.properties key, replacing the line if present and appending it if not.
#
# `sed -i` takes a mandatory suffix argument on BSD/macOS and a forbidden one on GNU/Linux, so a
# script hardcoding either form runs on half the machines it is copied to. This one broke the moment
# the repo was cloned onto Linux. Rewrite in place with python instead and stay out of the argument.
setprop() {
  python3 - "$DIR/server.properties" "$1" "$2" <<'PYPROPS'
import re, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f: text = f.read()
except FileNotFoundError:
    text = ""
line = f"{key}={value}"
if re.search(rf"^{re.escape(key)}=", text, flags=re.M):
    text = re.sub(rf"^{re.escape(key)}=.*$", line, text, flags=re.M)
else:
    if text and not text.endswith("\n"): text += "\n"
    text += line + "\n"
with open(path, "w") as f: f.write(text)
PYPROPS
}

# Keep the difficulty line in sync with MC_DIFFICULTY even on an existing properties file.
setprop difficulty "$DIFFICULTY"

# The ender dragon throws players around, and Baritone's movement looks like flight to the vanilla
# check, which kicks the bot mid-fight ("Flying is not enabled on this server"). A bot that gets
# disconnected for being airborne cannot fight anything that launches it.
setprop allow-flight "true"

# RCON for the eval runner (world resets without op-ing the bot). Password lives next to the world.
RCON_PORT="${MC_RCON_PORT:-25576}"
[[ -f "$DIR/rcon.password" ]] || python3 -c "import secrets;print(secrets.token_urlsafe(18))" > "$DIR/rcon.password"
RCON_PASS="$(cat "$DIR/rcon.password")"
setprop enable-rcon "true"
setprop rcon.port "$RCON_PORT"
setprop rcon.password "$RCON_PASS"

cd "$DIR"
if [[ "${1:-}" == "--bg" ]]; then
  nohup "$JAVA" -Xmx2G -jar "$JAR" nogui > "$DIR/server.log" 2>&1 &
  echo $! > "$DIR/server.pid"
  echo "[dev-server] started pid $(cat "$DIR/server.pid"), log: $DIR/server.log"
else
  exec "$JAVA" -Xmx2G -jar "$JAR" nogui
fi
