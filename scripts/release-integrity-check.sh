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
INFO() { echo "  • $1"; }

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
    market_ver_npx=""
    market_ver_web=""
    if command -v npx >/dev/null 2>&1; then
        market_ver_npx="$(
            (
                cd vscode-extension || exit 1
                npx vsce show CurtisFranks.mem-watchdog-status --json 2>/dev/null
            ) | grep -m1 -o '"version": "[^"]*"' | cut -d'"' -f4 || true
        )"
    fi
    market_ver_web="$(curl -s "https://marketplace.visualstudio.com/items?itemName=CurtisFranks.mem-watchdog-status" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

    # Prefer a source that confirms the target version. `vsce show` can lag
    # behind the marketplace page immediately after publish.
    if [[ "$market_ver_npx" == "$pkg_version" ]]; then
        market_ver="$market_ver_npx"
    elif [[ "$market_ver_web" == "$pkg_version" ]]; then
        market_ver="$market_ver_web"
    elif [[ -n "$market_ver_npx" ]]; then
        market_ver="$market_ver_npx"
    else
        market_ver="$market_ver_web"
    fi
    if [[ -n "$market_ver" && "$market_ver" == "$pkg_version" ]]; then
        PASS "Marketplace version matches package.json ($market_ver)"
    else
        FAIL "Marketplace version ($market_ver) != package.json ($pkg_version)"
    fi

    # Signature/package consistency gate: validate the CDN VSIX byte hash against
    # the signed .signature.manifest package digest for the exact published version.
    # `/latest` can lag after publish, so it is informational only.
    tmp_dir="$(mktemp -d)"
    latest_json="$tmp_dir/latest.json"
    query_json="$tmp_dir/extensionquery.json"
    sig_zip="$tmp_dir/sig.zip"
    package_file="$tmp_dir/package.vsix"
    sig_manifest="$tmp_dir/.signature.manifest"

    if curl -fsSL \
        -H 'Accept: application/json;api-version=7.2-preview' \
        -H 'User-Agent: VSCode 1.108.0 (Code)' \
        -H 'X-Market-Client-Id: VSCode 1.108.0' \
        "https://marketplace.visualstudio.com/_apis/public/gallery/vscode/CurtisFranks/mem-watchdog-status/latest" \
        >"$latest_json"; then
        latest_version="$(python3 - "$latest_json" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
vers = (obj.get('versions') or [])
print(str(vers[0].get('version', '')) if vers else '')
PY
)"
        if [[ "$latest_version" == "$pkg_version" ]]; then
            PASS "Latest metadata version matches package.json ($latest_version)"
        else
            INFO "Latest metadata version is $latest_version while target is $pkg_version (allowed lag)"
        fi
    else
        INFO "Could not fetch Marketplace latest metadata payload (continuing with target-version query)"
    fi

    if curl -fsSL \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json;api-version=7.2-preview.1' \
        --data '{"filters":[{"criteria":[{"filterType":7,"value":"CurtisFranks.mem-watchdog-status"}]}],"flags":8067}' \
        "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
        >"$query_json"; then
        PASS "Fetched Marketplace extensionquery metadata"
    else
        FAIL "Could not fetch Marketplace extensionquery metadata"
    fi

    target_version=""
    package_url=""
    signature_url=""
    while IFS=$'\t' read -r _key _value; do
        case "$_key" in
            target_version) target_version="$_value" ;;
            package_url) package_url="$_value" ;;
            signature_url) signature_url="$_value" ;;
        esac
    done < <(
        python3 - "$query_json" "$pkg_version" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
target = sys.argv[2]
results = obj.get('results') or []
extensions = (results[0].get('extensions') if results else []) or []
if not extensions:
    sys.exit(0)
versions = extensions[0].get('versions') or []
for v in versions:
    if str(v.get('version', '')) == target:
        print('target_version\t' + str(v.get('version', '')))
        for file_obj in v.get('files', []):
            t = str(file_obj.get('assetType', ''))
            s = str(file_obj.get('source', ''))
            if t == 'Microsoft.VisualStudio.Services.VSIXPackage':
                print('package_url\t' + s)
            elif t == 'Microsoft.VisualStudio.Services.VsixSignature':
                print('signature_url\t' + s)
        break
PY
    )

    if [[ "$target_version" == "$pkg_version" ]]; then
        PASS "Target version metadata found in extensionquery ($target_version)"
    else
        FAIL "Target version $pkg_version not found in extensionquery"
    fi

    if [[ -n "$package_url" && -n "$signature_url" ]]; then
        PASS "Located VSIX package and signature URLs for target version"
    else
        FAIL "Missing VSIX package/signature URLs for target version"
    fi

    if curl -fsSL "$package_url" -o "$package_file"; then
        PASS "Downloaded CDN VSIX package"
    else
        FAIL "Could not download CDN VSIX package"
    fi

    if curl -fsSL "$signature_url" -o "$sig_zip"; then
        PASS "Downloaded VSIX signature archive"
    else
        FAIL "Could not download VSIX signature archive"
    fi

    if unzip -p "$sig_zip" .signature.manifest >"$sig_manifest" 2>/dev/null; then
        PASS "Extracted .signature.manifest"
    else
        FAIL "Could not extract .signature.manifest"
    fi

    pkg_hash_actual=""
    pkg_size_actual=""
    read -r pkg_hash_actual pkg_size_actual < <(
        python3 - "$package_file" <<'PY'
import base64, hashlib, os, sys
path = sys.argv[1]
with open(path, 'rb') as f:
    b = f.read()
print(base64.b64encode(hashlib.sha256(b).digest()).decode(), os.path.getsize(path))
PY
    )

    pkg_hash_expected=""
    pkg_size_expected=""
    read -r pkg_hash_expected pkg_size_expected < <(
        python3 - "$sig_manifest" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
pkg = obj.get('package', {})
print(pkg.get('digests', {}).get('sha256', ''), pkg.get('size', ''))
PY
    )

    if [[ -n "$pkg_hash_expected" && "$pkg_hash_actual" == "$pkg_hash_expected" ]]; then
        PASS "CDN VSIX hash matches signed manifest"
    else
        FAIL "CDN VSIX hash mismatch vs signed manifest (actual=$pkg_hash_actual expected=$pkg_hash_expected)"
    fi

    if [[ -n "$pkg_size_expected" && "$pkg_size_actual" == "$pkg_size_expected" ]]; then
        PASS "CDN VSIX size matches signed manifest ($pkg_size_actual bytes)"
    else
        FAIL "CDN VSIX size mismatch vs signed manifest (actual=$pkg_size_actual expected=$pkg_size_expected)"
    fi

    rm -rf "$tmp_dir"
fi

echo ""
echo "release-integrity: $pass passed, $fail failed"
(( fail == 0 ))
