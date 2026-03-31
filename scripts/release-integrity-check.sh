#!/usr/bin/env bash
# release-integrity-check.sh — enforce release metadata integrity.
#
# Modes:
#   default        Pre-publish checks (local repo state)
#   --post-publish Includes remote checks (tag/release/Marketplace)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

POST_PUBLISH=0
if [[ "${1:-}" == "--post-publish" ]]; then
    POST_PUBLISH=1
fi

pass=0
fail=0

PASS() { ((++pass)); echo "  ✓ $1"; }
FAIL() { ((++fail)); echo "  ✗ $1"; }

pkg_version="$(node -e "process.stdout.write(require('./vscode-extension/package.json').version)")"
root_daemon_version="$(grep -m1 -oP '^(?:export\s+)?WATCHDOG_VERSION=\K[0-9]+(?:\.[0-9]+)?' mem-watchdog.sh || true)"
min_safe_version="$(grep -m1 -oP "MIN_SAFE_DAEMON_VERSION = '\K[^']+" vscode-extension/installer.js || true)"

if [[ -n "$pkg_version" ]]; then
    PASS "package.json version: $pkg_version"
else
    FAIL "Could not read vscode-extension/package.json version"
fi

if grep -qF "[$pkg_version]" vscode-extension/CHANGELOG.md; then
    PASS "CHANGELOG has entry for v$pkg_version"
else
    FAIL "CHANGELOG missing entry for v$pkg_version"
fi

if [[ -n "$root_daemon_version" && -n "$min_safe_version" && "$root_daemon_version" == "$min_safe_version" ]]; then
    PASS "MIN_SAFE_DAEMON_VERSION matches daemon WATCHDOG_VERSION ($root_daemon_version)"
else
    FAIL "MIN_SAFE_DAEMON_VERSION ($min_safe_version) != daemon WATCHDOG_VERSION ($root_daemon_version)"
fi

if [[ $POST_PUBLISH -eq 1 ]]; then
    tag="v$pkg_version"

    if git rev-parse "$tag" >/dev/null 2>&1; then
        PASS "Git tag exists: $tag"
    else
        FAIL "Git tag missing: $tag"
    fi

    if gh release view "$tag" >/dev/null 2>&1; then
        PASS "GitHub release exists: $tag"
    else
        FAIL "GitHub release missing: $tag"
    fi

    market_ver=""
    if command -v npx >/dev/null 2>&1; then
        market_ver="$(
            (
                cd vscode-extension || exit 1
                npx vsce show CurtisFranks.mem-watchdog-status --json 2>/dev/null
            ) | grep -m1 -o '"version": "[^"]*"' | cut -d'"' -f4 || true
        )"
    fi
    if [[ -z "$market_ver" ]]; then
        market_ver="$(curl -s "https://marketplace.visualstudio.com/items?itemName=CurtisFranks.mem-watchdog-status" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    fi
    if [[ -n "$market_ver" && "$market_ver" == "$pkg_version" ]]; then
        PASS "Marketplace version matches package.json ($market_ver)"
    else
        FAIL "Marketplace version ($market_ver) != package.json ($pkg_version)"
    fi
fi

echo ""
echo "release-integrity: $pass passed, $fail failed"
(( fail == 0 ))
