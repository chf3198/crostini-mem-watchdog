#!/usr/bin/env bash
set -euo pipefail

# Extension Footprint Advisor (prototype)
# Usage:
#   bash extension-footprint-advisor.sh [workspace_path]
#
# Produces a lightweight recommendation report using:
# - code helper process RSS by extension/tooling family
# - workspace file-type/config signals (if workspace path is provided)

WORKSPACE="${1:-$PWD}"

if ! command -v code >/dev/null 2>&1; then
  echo "[advisor] VS Code CLI not found (command: code)."
  exit 1
fi

echo "[advisor] Workspace: $WORKSPACE"
echo "[advisor] Time: $(date '+%F %T')"

tmp_ps="$(mktemp)"
trap 'rm -f "$tmp_ps"' EXIT

ps -C code -o rss=,args= 2>/dev/null > "$tmp_ps" || true

sum_total_mb="$(awk '{s+=$1} END{printf "%.0f", s/1024}' "$tmp_ps")"
code_count="$(wc -l < "$tmp_ps" | tr -d ' ')"

echo "[advisor] Active code processes: $code_count"
echo "[advisor] Total code RSS: ${sum_total_mb} MB"

echo

echo "[advisor] Top helper families by RSS:"
awk '
  {
    rss=$1; $1=""; line=tolower($0);
    fam="other";
    if (line ~ /pylance|ms-python\.python|python-env|debugpy|pyright/) fam="python-stack";
    else if (line ~ /eslint/) fam="eslint";
    else if (line ~ /github\.vscode-github-actions|actions.*server-node\.js/) fam="github-actions";
    else if (line ~ /copilot/) fam="copilot";
    else if (line ~ /typescript\/lib\/tsserver\.js|tsserver/) fam="typescript";
    else if (line ~ /htmlservermain/) fam="html-language";
    else if (line ~ /cssservermain/) fam="css-language";
    else if (line ~ /jsonservermain/) fam="json-language";
    else if (line ~ /markdown-language-features/) fam="markdown-language";

    fam_rss[fam]+=rss;
  }
  END {
    for (f in fam_rss) {
      printf "%10.0f MB  %s\n", fam_rss[f]/1024, f;
    }
  }
' "$tmp_ps" | sort -nr

echo

echo "[advisor] Workspace signals:"
if [[ -d "$WORKSPACE" ]]; then
  py_count=$(find "$WORKSPACE" -path '*/.git' -prune -o -path '*/node_modules' -prune -o -type f -name '*.py' -print 2>/dev/null | wc -l | tr -d ' ')
  js_count=$(find "$WORKSPACE" -path '*/.git' -prune -o -path '*/node_modules' -prune -o -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print 2>/dev/null | wc -l | tr -d ' ')
  has_eslint=0
  find "$WORKSPACE" -path '*/.git' -prune -o -type f \( -name '.eslintrc*' -o -name 'eslint.config.*' \) -print -quit 2>/dev/null | grep -q . && has_eslint=1 || true
  has_actions=0
  [[ -d "$WORKSPACE/.github/workflows" ]] && has_actions=1

  echo "  python_files=$py_count"
  echo "  js_files=$js_count"
  echo "  eslint_config_present=$has_eslint"
  echo "  github_actions_workflows_present=$has_actions"
else
  echo "  workspace path not found; skipping workspace-specific signals"
  py_count=0; js_count=0; has_eslint=0; has_actions=0
fi

echo

echo "[advisor] Recommendations (prototype):"

if (( py_count == 0 )); then
  echo "  - Python stack: likely workspace-disable (ms-python.python, pylance, debugpy, python-envs)."
fi

if (( js_count > 0 )) && (( has_eslint == 0 )); then
  echo "  - ESLint: likely workspace-disable (no eslint config detected)."
fi

if (( has_actions == 0 )); then
  echo "  - GitHub Actions extension: likely workspace-disable (no .github/workflows)."
fi

echo "  - Keep Copilot/Copilot Chat if actively used."
echo "  - Keep Prettier for HTML/CSS/JS formatting workflows."
echo "  - Apply changes in staged order: disable in workspace -> run for 1 day -> uninstall if no regressions."

echo

echo "[advisor] Done."
