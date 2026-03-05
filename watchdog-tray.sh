#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# watchdog-tray.sh — System tray icon showing mem-watchdog health
#
# Displays a colour-coded icon in the ChromeOS/Crostini system tray:
#   🟢 Green  — watchdog running, memory healthy (≥ 40% free)
#   🟡 Yellow — watchdog running, memory moderate (25–40% free)
#   🔴 Red    — watchdog running, memory low (< 25%) or watchdog stopped
#
# Tooltip shows: watchdog status, % RAM free, VS Code RSS, free MB.
# Click the icon → show a one-time popup summary.
# Very low resource: ~3 MB RAM, 0% CPU at idle (sleeps between updates).
#
# USAGE:
#   Start:   ./scripts/watchdog-tray.sh &
#   Stop:    pkill -f watchdog-tray.sh
#   Autostart: add to ~/.config/autostart/ (see below)
# ─────────────────────────────────────────────────────────────────────────────

INTERVAL=3   # seconds between tray tooltip updates

# Icon names from hicolor theme (installed with yad)
ICON_GREEN="emblem-default"       # green checkmark
ICON_YELLOW="emblem-important"    # yellow exclamation
ICON_RED="emblem-urgent"          # red urgent (falls back to dialog-warning)

# ── Named pipe for yad --notification commands ───────────────────────────────
PIPE=$(mktemp -t watchdog-tray-XXXXXX.fifo)
rm -f "$PIPE"
mkfifo "$PIPE"
trap 'rm -f "$PIPE"; kill "$YAD_PID" 2>/dev/null' EXIT INT TERM

# ── Start yad in notification (tray) mode ────────────────────────────────────
DISPLAY=:0 yad --notification \
  --image="$ICON_GREEN" \
  --text="Watchdog: starting…" \
  --command="bash -c 'notify-send --urgency=low \"mem-watchdog\" \"$(systemctl --user is-active mem-watchdog 2>/dev/null) — click tray icon for status\"'" \
  --listen < "$PIPE" &
YAD_PID=$!

# Keep the pipe open so yad does not exit
exec 3>"$PIPE"

# ── Main update loop ──────────────────────────────────────────────────────────
while kill -0 "$YAD_PID" 2>/dev/null; do

  # Watchdog service status
  if systemctl --user is-active --quiet mem-watchdog 2>/dev/null; then
    svc="● running"
  else
    svc="✗ STOPPED"
  fi

  # Memory stats
  avail=$(awk '/^MemAvailable/{print $2; exit}' /proc/meminfo)
  total=$(awk '/^MemTotal/{print $2; exit}' /proc/meminfo)
  if [[ -n "$avail" && -n "$total" && "$total" -gt 0 ]]; then
    pct=$(( avail * 100 / total ))
    avail_mb=$(( avail / 1024 ))
  else
    pct=0; avail_mb=0
  fi

  # VS Code RSS
  vscode_rss_kb=$(ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
  vscode_rss_mb=$(( vscode_rss_kb / 1024 ))

  # Pick icon by severity
  if [[ "$svc" == *"STOPPED"* ]] || (( pct < 25 )); then
    icon="$ICON_RED"
  elif (( pct < 40 )); then
    icon="$ICON_YELLOW"
  else
    icon="$ICON_GREEN"
  fi

  # Build tooltip (single line — yad truncates multi-line tooltips)
  tooltip="Watchdog: ${svc} | RAM: ${pct}% free (${avail_mb} MB) | VS Code: ${vscode_rss_mb} MB"

  # Send updates to yad
  echo "icon:$icon" >&3
  echo "tooltip:$tooltip" >&3

  sleep "$INTERVAL"
done
