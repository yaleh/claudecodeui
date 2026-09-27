#!/usr/bin/env bash
# start-drivers-scoped.sh [start-drivers.js args...] — start the quay drivers (promotion + worker)
# and the web server inside the memory-capped fleet slice.
#
# Why: the 2026-09-25 host OOM happened in a scope that a session had started ad hoc with no
# `MemoryMax`, so the drivers and every worker they spawn (claude sessions running vitest, tsx, tsc)
# could take all 252G of a host shared with other users. This puts them under one ceiling:
# ~/.config/systemd/user/quay-fleet.slice (MemoryHigh=48G throttles first, MemoryMax=64G kills).
#
# `QUAY_MEMORY_SLICE` is exported so scripts/with-memory-cap.sh puts each per-test scope under the
# SAME slice: `systemd-run --scope` does not nest under the caller's cgroup, so without it those
# scopes would sit outside the ceiling. `OOMPolicy=continue` keeps one OOM-killed worker from
# stopping the whole scope (systemd's default for a scope would be to stop it).
#
# Env:
#   QUAY_MEMORY_SLICE   slice to run under (default quay-fleet.slice)
#   QUAY_PLUGIN_DIR     quay plugin dir holding scripts/dist/start-drivers.js
#                       (default: newest release under ~/.claude/plugins/cache/quay/quay/)
set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLICE="${QUAY_MEMORY_SLICE:-quay-fleet.slice}"

if [ -z "${QUAY_PLUGIN_DIR:-}" ]; then
  base="$HOME/.claude/plugins/cache/quay/quay"
  newest="$(ls "$base" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
  [ -n "$newest" ] || { echo "start-drivers-scoped: no released quay plugin under $base" >&2; exit 1; }
  QUAY_PLUGIN_DIR="$base/$newest"
fi
[ -f "$QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" ] \
  || { echo "start-drivers-scoped: missing $QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" >&2; exit 1; }

# The slice must exist AND carry a MemoryMax, or "scoped" would be a lie.
max="$(systemctl --user show "$SLICE" -p MemoryMax --value 2>/dev/null || true)"
case "$max" in
  ''|infinity) echo "start-drivers-scoped: $SLICE has no MemoryMax (got '${max:-unset}') — refusing to start uncapped" >&2; exit 1 ;;
esac

# `docker`-style guard: do not start a second set of drivers for this root.
if pgrep -u "$(id -u)" -f "driver-anchor.js __anchor --root $ROOT_DIR" >/dev/null 2>&1; then
  echo "start-drivers-scoped: drivers already running for $ROOT_DIR" >&2
  exit 1
fi

UNIT="quay-drivers-$(basename "$ROOT_DIR")-$(date +%s)"
echo "start-drivers-scoped: $UNIT.scope in $SLICE (MemoryMax=$max)"
exec systemd-run --user --scope --quiet --unit="$UNIT" --slice="$SLICE" -p OOMPolicy=continue -- \
  env QUAY_MEMORY_SLICE="$SLICE" \
  node "$QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" --root "$ROOT_DIR" "$@"
