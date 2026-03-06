#!/usr/bin/env bash
# vscode-extension/publish.sh
# ─────────────────────────────────────────────────────────────────────────────
# Publishes (or version-bumps + publishes) the Mem Watchdog extension.
#
# Usage:
#   ./publish.sh              # publish current version
#   ./publish.sh patch        # bump patch (0.1.0 → 0.1.1), then publish
#   ./publish.sh minor        # bump minor (0.1.0 → 0.2.0), then publish
#   ./publish.sh major        # bump major (0.1.0 → 1.0.0), then publish
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/.env"

# ── Load credentials ──────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Create it from the .env template." >&2
  exit 1
fi

set -a
# shellcheck source=../.env
source "$ENV_FILE"
set +a

if [[ -z "${VSCE_PAT:-}" ]]; then
  echo "ERROR: VSCE_PAT is empty in $ENV_FILE. Paste your Azure DevOps PAT there." >&2
  exit 1
fi

# ── Confirm publisher ─────────────────────────────────────────────────────────
PUBLISHER="${VSCE_PUBLISHER:-chf3198}"
echo "[publish] Publisher: $PUBLISHER"

# ── Build resources/ ─────────────────────────────────────────────────────────
echo "[publish] Running npm run build..."
cd "$SCRIPT_DIR"
npm run build

# ── Login ─────────────────────────────────────────────────────────────────────
echo "[publish] Logging in as $PUBLISHER..."
echo "$VSCE_PAT" | vsce login "$PUBLISHER" --pat "$VSCE_PAT"

# ── Publish ───────────────────────────────────────────────────────────────────
BUMP="${1:-}"
if [[ -n "$BUMP" ]]; then
  echo "[publish] Bumping version: $BUMP"
  vsce publish "$BUMP"
else
  vsce publish
fi

echo "[publish] Done."
