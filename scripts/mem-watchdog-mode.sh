#!/usr/bin/env bash
# mem-watchdog-mode.sh — repo-agnostic managed-window control
#
# Purpose:
#   Control ~/.config/mem-watchdog/mode for automation sessions.
#   - sleep   => write SLEEP (daemon defers kill/reclaim actions)
#   - normal  => clear mode file (resume normal watchdog behavior)
#   - status  => print current mode
#   - run ... => run a command inside a managed SLEEP window

set -euo pipefail

MODE_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/mem-watchdog/mode"

usage() {
  cat <<'EOF'
Usage:
  mem-watchdog-mode.sh status
  mem-watchdog-mode.sh sleep
  mem-watchdog-mode.sh normal
  mem-watchdog-mode.sh run -- <command> [args...]

Examples:
  mem-watchdog-mode.sh sleep
  mem-watchdog-mode.sh normal
  mem-watchdog-mode.sh run -- node scripts/capture.js
EOF
}

set_sleep_mode() {
  mkdir -p "$(dirname "$MODE_FILE")"
  printf 'SLEEP\n' > "$MODE_FILE"
  echo "mode=SLEEP"
}

set_normal_mode() {
  rm -f "$MODE_FILE"
  echo "mode=NORMAL"
}

show_status() {
  local mode=''
  if [[ -f "$MODE_FILE" ]]; then
    read -r mode < "$MODE_FILE" 2>/dev/null || mode=''
  fi

  if [[ "$mode" == 'SLEEP' ]]; then
    echo "mode=SLEEP"
  else
    echo "mode=NORMAL"
  fi
}

run_managed_window() {
  if [[ "$1" == '--' ]]; then
    shift
  fi

  if (( $# == 0 )); then
    echo "ERROR: run requires a command" >&2
    usage
    return 2
  fi

  set_sleep_mode >/dev/null

  cleanup_mode() {
    set_normal_mode >/dev/null || true
  }

  trap cleanup_mode EXIT INT TERM
  "$@"
}

cmd="${1:-}"

case "$cmd" in
  status)
    show_status
    ;;
  sleep)
    set_sleep_mode
    ;;
  normal)
    set_normal_mode
    ;;
  run)
    shift
    run_managed_window "$@"
    ;;
  -h|--help|'')
    usage
    ;;
  *)
    echo "ERROR: unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac
