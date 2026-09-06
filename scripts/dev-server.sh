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

# Keep the difficulty line in sync with MC_DIFFICULTY even on an existing properties file.
sed -i '' "s/^difficulty=.*/difficulty=$DIFFICULTY/" "$DIR/server.properties"

cd "$DIR"
if [[ "${1:-}" == "--bg" ]]; then
  nohup "$JAVA" -Xmx2G -jar "$JAR" nogui > "$DIR/server.log" 2>&1 &
  echo $! > "$DIR/server.pid"
  echo "[dev-server] started pid $(cat "$DIR/server.pid"), log: $DIR/server.log"
else
  exec "$JAVA" -Xmx2G -jar "$JAR" nogui
fi
