#!/usr/bin/env bash
# docs-integrity-check.sh — Verify documentation stays in sync with code.
#
# Exits 0 if all checks pass, 1 if any drift is detected.
# Designed to run in CI (ci.yml) and as a git pre-push hook.
#
# Checks:
#   1. README.md JS test badge matches actual test count
#   2. .github/copilot-instructions.md test count matches actual
#   3. CHANGELOG.md has an entry for the current package.json version
#   4. ci.yml test count comment matches actual
#   5. installer MIN_SAFE_DAEMON_VERSION matches daemon WATCHDOG_VERSION
#
# Usage:
#   bash scripts/docs-integrity-check.sh          # from repo root
#   bash scripts/docs-integrity-check.sh --ci     # in CI (uses npm test output)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

pass=0
fail=0
errors=()

PASS() { ((++pass)); echo "  ✓ $1"; }
FAIL() { ((++fail)); errors+=("$1"); echo "  ✗ $1"; }

# ── Get actual JS test count ─────────────────────────────────────────────────
# Run npm test and capture the summary line: "# tests 75"
actual_js_count=""
if [[ -f vscode-extension/package.json ]]; then
    test_output="$(cd vscode-extension && npm test 2>&1)" || true
    # node:test outputs "ℹ tests N" (Unicode info symbol) or "# tests N" (TAP)
    actual_js_count="$(echo "$test_output" | grep -oP '(ℹ|#) tests \K[0-9]+' | tail -1)"
fi

if [[ -z "$actual_js_count" ]]; then
    FAIL "Could not determine actual JS test count from npm test"
else
    echo "Actual JS test count: $actual_js_count"

    # ── Check 1: README.md badge ─────────────────────────────────────────────
    readme_count="$(grep -oP 'badge/js-\K[0-9]+(?=%2F[0-9])' README.md 2>/dev/null || true)"
    if [[ -z "$readme_count" ]]; then
        FAIL "README.md: JS test badge not found"
    elif [[ "$readme_count" != "$actual_js_count" ]]; then
        FAIL "README.md: JS badge says $readme_count tests, actual is $actual_js_count"
    else
        PASS "README.md: JS badge ($readme_count/$readme_count) matches actual"
    fi

    # Verify the denominator matches too (X/X format)
    readme_denom="$(grep -oP 'badge/js-[0-9]+%2F\K[0-9]+' README.md 2>/dev/null || true)"
    if [[ -n "$readme_denom" && "$readme_denom" != "$actual_js_count" ]]; then
        FAIL "README.md: JS badge denominator is $readme_denom, actual is $actual_js_count"
    fi

    # ── Check 2: copilot-instructions.md test count ──────────────────────────
    instructions_count="$(grep -oP '# \K[0-9]+(?= unit tests via node:test)' \
        .github/copilot-instructions.md 2>/dev/null || true)"
    if [[ -z "$instructions_count" ]]; then
        FAIL "copilot-instructions.md: test count line not found"
    elif [[ "$instructions_count" != "$actual_js_count" ]]; then
        FAIL "copilot-instructions.md: says $instructions_count tests, actual is $actual_js_count"
    else
        PASS "copilot-instructions.md: test count ($instructions_count) matches actual"
    fi

    # ── Check 4: ci.yml test count comment ───────────────────────────────────
    ci_count="$(grep -oP '\(\K[0-9]+(?= unit tests\))' .github/workflows/ci.yml 2>/dev/null || true)"
    if [[ -z "$ci_count" ]]; then
        # Not fatal — comment may not exist
        PASS "ci.yml: no test count comment to check"
    elif [[ "$ci_count" != "$actual_js_count" ]]; then
        FAIL "ci.yml: comment says $ci_count tests, actual is $actual_js_count"
    else
        PASS "ci.yml: test count comment ($ci_count) matches actual"
    fi
fi

# ── Check 3: CHANGELOG has current version ───────────────────────────────────
if [[ -f vscode-extension/package.json && -f vscode-extension/CHANGELOG.md ]]; then
    pkg_version="$(node -e "process.stdout.write(require('./vscode-extension/package.json').version)")"
    if grep -qF "[$pkg_version]" vscode-extension/CHANGELOG.md; then
        PASS "CHANGELOG.md: has entry for v$pkg_version"
    else
        FAIL "CHANGELOG.md: no entry for v$pkg_version (current package.json version)"
    fi
fi

# ── Check 5: MIN_SAFE_DAEMON_VERSION matches daemon WATCHDOG_VERSION ───────
daemon_version="$(grep -m1 -oP '^(?:export\s+)?WATCHDOG_VERSION=\K[0-9]+(?:\.[0-9]+)?' mem-watchdog.sh 2>/dev/null || true)"
min_safe_version="$(grep -m1 -oP "MIN_SAFE_DAEMON_VERSION = '\K[^']+" vscode-extension/installer.js 2>/dev/null || true)"

if [[ -z "$daemon_version" ]]; then
    FAIL "mem-watchdog.sh: WATCHDOG_VERSION not found"
elif [[ -z "$min_safe_version" ]]; then
    FAIL "installer.js: MIN_SAFE_DAEMON_VERSION not found"
elif [[ "$daemon_version" != "$min_safe_version" ]]; then
    FAIL "installer.js: MIN_SAFE_DAEMON_VERSION=$min_safe_version does not match daemon WATCHDOG_VERSION=$daemon_version"
else
    PASS "installer.js: MIN_SAFE_DAEMON_VERSION matches daemon WATCHDOG_VERSION ($daemon_version)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "docs-integrity: $pass passed, $fail failed"
if ((fail > 0)); then
    echo ""
    echo "Failures:"
    for e in "${errors[@]}"; do
        echo "  → $e"
    done
    exit 1
fi
exit 0
