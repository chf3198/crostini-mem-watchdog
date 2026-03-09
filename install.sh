#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install.sh — One-command installer for crostini-mem-watchdog
#
# Usage:  bash install.sh [--no-extension] [--dry-run]
#
# What this does:
#   1. Copies mem-watchdog.sh → ~/.local/bin/
#   2. Installs mem-watchdog.service → ~/.config/systemd/user/
#   3. Reloads systemd user daemon
#   4. Enables + starts the mem-watchdog service
#   5. Optionally installs the VS Code status bar extension
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BIN="${HOME}/.local/bin"
INSTALL_SYSTEMD="${HOME}/.config/systemd/user"
DRY_RUN=false
SKIP_EXTENSION=false

# ── Parse args ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=true ;;
    --no-extension)  SKIP_EXTENSION=true ;;
    --help|-h)
      echo "Usage: bash install.sh [--no-extension] [--dry-run]"
      exit 0 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo "  ✔  $*"; }
warning() { echo "  ⚠  $*"; }
run()     {
  if $DRY_RUN; then
    echo "  [dry-run] $*"
  else
    # shellcheck disable=SC2294
    eval "$@"
  fi
}

echo ""
echo "┌─────────────────────────────────────────────────────┐"
echo "│         crostini-mem-watchdog  installer            │"
echo "└─────────────────────────────────────────────────────┘"
echo ""

$DRY_RUN && echo "  *** DRY RUN — no changes will be made ***" && echo ""

# ── Preflight checks ─────────────────────────────────────────────────────────
if ! command -v systemctl &>/dev/null; then
  echo "ERROR: systemctl not found. Is systemd running?"
  exit 1
fi

if ! systemctl --user status &>/dev/null; then
  warning "systemd user session may not be fully started."
  warning "If service enable fails, log out and back in, then re-run."
fi

# ── Step 1: Copy the daemon ───────────────────────────────────────────────────
echo "Step 1/4 — Install daemon"
run "mkdir -p '${INSTALL_BIN}'"
run "cp '${SCRIPT_DIR}/mem-watchdog.sh' '${INSTALL_BIN}/mem-watchdog.sh'"
run "chmod +x '${INSTALL_BIN}/mem-watchdog.sh'"
info "mem-watchdog.sh → ${INSTALL_BIN}/mem-watchdog.sh"

# ── Step 2: Install service unit ──────────────────────────────────────────────
echo "Step 2/4 — Install systemd user service"
run "mkdir -p '${INSTALL_SYSTEMD}'"
run "cp '${SCRIPT_DIR}/mem-watchdog.service' '${INSTALL_SYSTEMD}/mem-watchdog.service'"
info "mem-watchdog.service → ${INSTALL_SYSTEMD}/mem-watchdog.service"

# ── Step 3: Enable and start ──────────────────────────────────────────────────
echo "Step 3/4 — Enable and start service"
run "systemctl --user daemon-reload"
run "systemctl --user enable mem-watchdog"
run "systemctl --user restart mem-watchdog"
info "Service enabled and started"
# ── Step 3b: Journal size limits (optional, requires sudo) ───────────────────
# Default journald has no file-level or total size cap. Confirmed 260 MB
# after ~3 days on this system. Installs SystemMaxUse=100M, SystemMaxFiles=5,
# SystemMaxFileSize=16M, SystemKeepFree=500M, MaxRetentionSec=3d.
JOURNALD_DROPIN="/etc/systemd/journald.conf.d/50-size-limits.conf"
if ! $DRY_RUN && sudo -n true 2>/dev/null; then
  if [[ ! -f "$JOURNALD_DROPIN" ]]; then
    echo "Step 3b — Journal size limits (sudo available)"
    sudo mkdir -p /etc/systemd/journald.conf.d
    sudo cp "${SCRIPT_DIR}/journald-limits.conf" "$JOURNALD_DROPIN"
    sudo systemctl restart systemd-journald 2>/dev/null || true
    info "journald size limits installed → ${JOURNALD_DROPIN}"
  else
    # Drop-in already present — update it in case content changed
    if ! diff -q "${SCRIPT_DIR}/journald-limits.conf" "$JOURNALD_DROPIN" &>/dev/null; then
      sudo cp "${SCRIPT_DIR}/journald-limits.conf" "$JOURNALD_DROPIN"
      sudo systemctl restart systemd-journald 2>/dev/null || true
      info "journald size limits updated → ${JOURNALD_DROPIN}"
    else
      info "journald size limits already current (${JOURNALD_DROPIN})"
    fi
  fi
  # Immediately apply the new retention/size limits to the existing journal.
  # journald vacuum only removes *archived* files; --rotate archives the
  # active file first so vacuum can actually shrink the existing 260 MB journal.
  echo "     Rotating + vacuuming journal to apply new limits..."
  journalctl --rotate 2>/dev/null || true
  journalctl --vacuum-size=95M --vacuum-time=3d 2>/dev/null | grep -E 'Deleted|Freed|vacuuming' || true
else
  warning "Skipping journald limits — sudo not available or dry-run"
  warning "To apply manually:"
  warning "  sudo mkdir -p /etc/systemd/journald.conf.d"
  warning "  sudo cp '${SCRIPT_DIR}/journald-limits.conf' '${JOURNALD_DROPIN}'"
  warning "  journalctl --rotate && journalctl --vacuum-size=95M --vacuum-time=3d"
fi

# ── Step 3c: tmpfiles.d backstop for scratch/ ─────────────────────────────────
# systemd-tmpfiles-clean.service runs daily. This config tells it to remove
# files in scratch/ that haven't been modified in 30 days, providing a
# persistent backstop independent of whether tests are run.
# Uses modification-time-only prefix 'm:' so reads don't reset the age clock.
TMPFILES_DIR="${HOME}/.config/user-tmpfiles.d"
TMPFILES_CONF="${TMPFILES_DIR}/mem-watchdog-scratch.conf"
if ! $DRY_RUN; then
  mkdir -p "$TMPFILES_DIR"
  cat > "$TMPFILES_CONF" << EOF
# mem-watchdog scratch/ cleanup backstop
# 'e' adjusts existing directory: removes files older than the specified age.
# 'm:30d' = modification-time-only (reads don't reset the clock).
# systemd-tmpfiles-clean.service runs this daily.
e ${SCRIPT_DIR}/scratch - - - m:30d -
EOF
  # Trigger immediately for the first run
  systemd-tmpfiles --user --clean "$TMPFILES_CONF" 2>/dev/null || true
  info "tmpfiles.d backstop installed → ${TMPFILES_CONF}"
fi
if ! $DRY_RUN; then
  sleep 1
  if systemctl --user is-active --quiet mem-watchdog; then
    info "Service is running ✓"
    MAIN_PID=$(systemctl --user show mem-watchdog --property=MainPID --value 2>/dev/null || echo "?")
    echo "     PID: ${MAIN_PID}"
  else
    warning "Service did not start — check: journalctl --user -u mem-watchdog -n 20"
  fi
fi

# ── Step 4: VS Code extension (optional) ──────────────────────────────────────
echo "Step 4/4 — VS Code extension"
if $SKIP_EXTENSION; then
  echo "     Skipped (--no-extension)"
elif ! command -v code &>/dev/null; then
  warning "VS Code ('code') not found in PATH — skipping extension install"
  warning "To install manually: code --install-extension vscode-extension/mem-watchdog-status-0.0.1.vsix"
else
  VSIX="${SCRIPT_DIR}/vscode-extension/mem-watchdog-status-0.0.1.vsix"
  if [[ -f "${VSIX}" ]]; then
    run "code --install-extension '${VSIX}'"
    info "Extension installed — reload VS Code window to activate"
  else
    warning ".vsix not found at ${VSIX}"
    warning "Build it: cd vscode-extension && npm install -g @vscode/vsce && vsce package"
  fi
fi

echo ""
echo "┌─────────────────────────────────────────────────────┐"
echo "│                  Installation complete              │"
echo "└─────────────────────────────────────────────────────┘"
echo ""
echo "  Monitor:   systemctl --user status mem-watchdog"
echo "  Live log:  journalctl --user -u mem-watchdog -f"
echo "  Validate:  bash test-watchdog.sh"
echo ""
