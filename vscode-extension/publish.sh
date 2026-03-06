#!/usr/bin/env bash
# vscode-extension/publish.sh
# ─────────────────────────────────────────────────────────────────────────────
# Publishes (or version-bumps + publishes) the Mem Watchdog extension.
#
# The publisher is read from package.json "publisher" field automatically by
# vsce — do not pass it on the command line.
#
# Usage:
#   ./publish.sh              # publish current version as-is
#   ./publish.sh patch        # bump patch (0.2.0 → 0.2.1), then publish
#   ./publish.sh minor        # bump minor (0.2.0 → 0.3.0), then publish
#   ./publish.sh major        # bump major (0.2.0 → 1.0.0), then publish
#
# NOTE: vsce publish <bump> also commits a version tag in git. To suppress
# that behaviour, add --no-git-tag-version.
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

# Publisher comes from package.json — just confirm it for the operator.
PUBLISHER=$(node -e "process.stdout.write(require('./package.json').publisher)")
echo "[publish] Publisher: $PUBLISHER (from package.json)"

# ── Build resources/ ─────────────────────────────────────────────────────────
echo "[publish] Running npm run build..."
cd "$SCRIPT_DIR"
npm run build

# ── Publish ───────────────────────────────────────────────────────────────────
BUMP="${1:-}"
if [[ -n "$BUMP" ]]; then
  echo "[publish] Bumping version: $BUMP"
  vsce publish "$BUMP" \
    --pat "$VSCE_PAT" \
    --githubBranch main
else
  vsce publish \
    --pat "$VSCE_PAT" \
    --githubBranch main
fi

echo "[publish] Done."
