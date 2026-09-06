#!/usr/bin/env bash
# Restart the running fleet (`golem up`) in place: graceful stop, verify no body process or control
# port is left behind, relaunch, wait for "up:". Sessions resume (data/<agent>/session.json).
#
#   scripts/restart-up.sh            # all agents in golem.toml
#   scripts/restart-up.sh Clay       # just one
#
# Why a script: hand-rolling this eight times in one evening produced an orphaned body that kept a
# username logged in and kicked its replacement for two hours. The supervisor now kills whole
# process trees; this script is the belt to that brace, and it refuses to launch on a dirty slate.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE=data/up.pid
if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  echo "stopping up (pid $(cat $PIDFILE))"
  kill -INT "$(cat $PIDFILE)"
  for _ in $(seq 1 40); do kill -0 "$(cat $PIDFILE)" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$(cat $PIDFILE)" 2>/dev/null && { echo "up did not exit in 20s; killing"; kill -9 "$(cat $PIDFILE)" || true; sleep 1; }
fi

# Nothing of a body may survive a stop. If it did, the supervisor's tree kill has a bug: say so loudly.
left=$(pgrep -f 'mezzoclef.headless=TRUE|data/clef/launcher.jar' || true)
if [[ -n $left ]]; then
  echo "WARNING: body processes survived the stop: $(echo "$left" | tr '\n' ' '); killing them"
  # shellcheck disable=SC2086
  kill -9 $left 2>/dev/null || true
  sleep 2
fi
ports=$(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | while read -r pid; do ps -o command= -p "$pid" | grep -qE 'mezzoclef|launcher\.jar' && echo "$pid"; done || true)
[[ -n $ports ]] && { echo "ERROR: a Clef process still holds a port: $ports"; exit 1; }

: > data/up.log
GOLEM_LOG=${GOLEM_LOG:-info} nohup node src/cli/golem.ts up "$@" > data/up.log 2>&1 &
echo $! > $PIDFILE
echo "launched up (pid $(cat $PIDFILE)); waiting for the fleet"
for _ in $(seq 1 200); do
  if grep -qE '\[golem\] up:' data/up.log; then grep -E 'resumed|\[golem\] up:|dashboard:' data/up.log | cut -c1-180; exit 0; fi
  if grep -qE ' error \[golem\]' data/up.log; then echo "up failed:"; grep -E ' error ' data/up.log | cut -c1-200; exit 1; fi
  sleep 3
done
echo "timed out waiting for up:"; tail -5 data/up.log; exit 1
