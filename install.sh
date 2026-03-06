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
