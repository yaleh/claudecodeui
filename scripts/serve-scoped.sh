#!/usr/bin/env bash
# serve-scoped.sh start|stop|restart|status — run the :3001 server as its own systemd user service.
#
# Why: `setsid nohup npm run server &` from a tmux pane leaves the server in that pane's
# `tmux-spawn-<uuid>.scope` cgroup. Anything else that OOMs in the pane (a runaway vitest) takes
# the server with it, and server.log just stops with no crash line. A transient service has its
# own cgroup, so it is only killed for its own memory use. There is deliberately NO MemoryMax
# here: the server has never leaked, and a cap would make it the OOM victim instead of a bystander.
# Cap the tests instead (scripts/with-memory-cap.sh).
#
# Env (same names the server reads):
#   HOST         bind address (default 0.0.0.0)
#   SERVER_PORT  port (default 3001)
#
# Do NOT run `stop`/`restart` from a session the server hosts: sessions are its child processes
# and the whole cgroup is stopped, so the caller is killed mid-command. Run it from a tmux pane.
set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${QUAY_SERVER_UNIT:-claudecodeui-server}"
HOST="${HOST:-0.0.0.0}"
SERVER_PORT="${SERVER_PORT:-3001}"

is_active() { systemctl --user is-active --quiet "$UNIT.service" 2>/dev/null; }

case "${1:-}" in
  start)
    if is_active; then echo "$UNIT already running" >&2; exit 1; fi
    systemd-run --user --quiet --collect --unit="$UNIT" \
      --working-directory="$ROOT_DIR" \
      --setenv=HOST="$HOST" --setenv=SERVER_PORT="$SERVER_PORT" \
      --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
      --property=StandardOutput=append:"$ROOT_DIR/server.log" \
      --property=StandardError=append:"$ROOT_DIR/server.log" \
      -- npm run server
    echo "started $UNIT.service on $HOST:$SERVER_PORT (log: $ROOT_DIR/server.log)"
    ;;
  stop)
    systemctl --user stop "$UNIT.service"
    ;;
  restart)
    systemctl --user stop "$UNIT.service" 2>/dev/null || true
    exec "$0" start
    ;;
  status)
    systemctl --user status "$UNIT.service" --no-pager
    ;;
  *)
    echo "usage: serve-scoped.sh start|stop|restart|status" >&2
    exit 2
    ;;
esac
