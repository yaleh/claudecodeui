#!/usr/bin/env bash
# with-memory-cap.sh <cmd> [args...] — run <cmd> in its own cgroup scope with a hard memory cap.
#
# Why: a runaway test (2026-09-25: chatComposerResponsive.test.tsx, peak 218G of 252G) shares the
# tmux pane's cgroup with everything else started from that pane — the :3001 server, other
# sessions. The kernel OOM killer then takes the WHOLE scope, so an unbounded test looks like
# "the server died". With its own scope the OOM kill is confined to the test.
#
# The command is exec'd, so its stdio, PID and exit status are unchanged. Note the OOM killer picks
# a victim inside the scope, so a multi-process runner (vitest) may exit 1, not 137: ask the journal.
#
# Env:
#   QUAY_MEMORY_MAX=<size>  cap for the scope, systemd size syntax (default 24G).
#                           `0` or `off` disables the wrapper and runs <cmd> directly.
#   QUAY_MEMORY_UNIT=<name> name the scope `<name>.scope` instead of a generated one, so the caller
#                           can ask the journal afterwards whether this cap's OOM kill happened
#                           (`journalctl --user -u <name>.scope | grep 'OOM killer'`).
#
# Degrades to running <cmd> uncapped (with one stderr line saying so) when there is no usable
# systemd user manager, e.g. macOS, containers, CI runners. The probe is a real `true` in a real
# capped scope, because `systemd-run` failing and <cmd> failing are indistinguishable by exit code.
set -u

[ "$#" -gt 0 ] || { echo "usage: with-memory-cap.sh <cmd> [args...]" >&2; exit 2; }

CAP="${QUAY_MEMORY_MAX:-24G}"

case "$CAP" in
  0|off) exec "$@" ;;
esac

if command -v systemd-run >/dev/null 2>&1 \
  && systemd-run --user --scope --quiet -p MemoryMax="$CAP" -p MemorySwapMax=0 true >/dev/null 2>&1; then
  UNIT_ARGS=()
  [ -n "${QUAY_MEMORY_UNIT:-}" ] && UNIT_ARGS=(--unit="$QUAY_MEMORY_UNIT")
  exec systemd-run --user --scope --quiet "${UNIT_ARGS[@]+"${UNIT_ARGS[@]}"}" -p MemoryMax="$CAP" -p MemorySwapMax=0 -- "$@"
fi

echo "with-memory-cap: no systemd user manager, running uncapped: $1" >&2
exec "$@"
