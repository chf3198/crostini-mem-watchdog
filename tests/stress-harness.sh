#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# stress-harness.sh — Watchdog stress test with Playwright memory telemetry
#
# Runs Playwright automation against frankspressurewashing.com for a sustained
# period while recording memory telemetry every 5 seconds.  The gate for
# v1.0.0 release: no OOM kill during 60-min long scenario.
#
# REQUIREMENTS:
#   - mem-watchdog service must be running
#   - Playwright must be installed (checks frankspressurewashing/node_modules)
#   - python3 available (for TSV summary statistics)
#
# Usage:
#   bash tests/stress-harness.sh short          # 5 min, 1 tab
#   bash tests/stress-harness.sh medium         # 20 min, 2 tabs + screenshots
#   bash tests/stress-harness.sh long           # 60 min, 3 tabs + form fill
#   bash tests/stress-harness.sh short --dry-run  # preflight only, no browser
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIO="${1:-short}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

# ── Colour codes ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; CYN='\033[0;36m'; RST='\033[0m'

# ── Validate scenario ───────────────────────────────────────────────────────
case "$SCENARIO" in
  short|medium|long) ;;
  *) echo -e "${RED}ERROR: Unknown scenario '$SCENARIO'. Use short|medium|long.${RST}"; exit 1 ;;
esac

# ── Scenario parameters ─────────────────────────────────────────────────────
case "$SCENARIO" in
  short)  DURATION_S=300;  TABS_COUNT=1; DESC="5 min, 1 tab" ;;
  medium) DURATION_S=1200; TABS_COUNT=2; DESC="20 min, 2 tabs + screenshots" ;;
  long)   DURATION_S=3600; TABS_COUNT=3; DESC="60 min, 3 tabs + form fill" ;;
esac

# ── Output paths ─────────────────────────────────────────────────────────────
RESULTS_DIR="$REPO/test-results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date '+%Y-%m-%d-%H%M')
TSV_FILE="$RESULTS_DIR/stress-${SCENARIO}-${TIMESTAMP}.tsv"
SCREENSHOT_DIR="$RESULTS_DIR/screenshots-${SCENARIO}-${TIMESTAMP}"
LOG_FILE="$RESULTS_DIR/stress-${SCENARIO}-${TIMESTAMP}.log"

echo -e "${CYN}════════════════════════════════════════════════════════════════${RST}" | tee "$LOG_FILE"
echo -e "${CYN}Watchdog Stress Harness — ${SCENARIO} (${DESC})${RST}" | tee -a "$LOG_FILE"
echo -e "${CYN}$(date '+%Y-%m-%d %H:%M:%S')${RST}" | tee -a "$LOG_FILE"
echo -e "${CYN}════════════════════════════════════════════════════════════════${RST}" | tee -a "$LOG_FILE"
echo "  TSV:         $TSV_FILE" | tee -a "$LOG_FILE"
echo "  Screenshots: $SCREENSHOT_DIR" | tee -a "$LOG_FILE"
echo "  Log:         $LOG_FILE" | tee -a "$LOG_FILE"

# ── Preflight checks ────────────────────────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "── Preflight" | tee -a "$LOG_FILE"

# Watchdog must be running
if ! systemctl --user is-active --quiet mem-watchdog; then
  echo -e "  ${RED}✗ mem-watchdog service is not active${RST}" | tee -a "$LOG_FILE"
  exit 1
fi
echo "  ✓ mem-watchdog service is active" | tee -a "$LOG_FILE"

# Find Playwright — check frankspressurewashing repo first, then PATH
FRANKS_REPO="${FRANKS_REPO:-$HOME/frankspressurewashing}"
PW_NODE_MODULES=""
if [[ -d "$FRANKS_REPO/node_modules/playwright" ]]; then
  PW_NODE_MODULES="$FRANKS_REPO/node_modules"
  echo "  ✓ Playwright found at $FRANKS_REPO/node_modules/playwright" | tee -a "$LOG_FILE"
elif [[ -d "$REPO/node_modules/playwright" ]]; then
  PW_NODE_MODULES="$REPO/node_modules"
  echo "  ✓ Playwright found at $REPO/node_modules/playwright" | tee -a "$LOG_FILE"
else
  echo -e "  ${RED}✗ Playwright not found. Install in frankspressurewashing or set FRANKS_REPO.${RST}" | tee -a "$LOG_FILE"
  exit 1
fi

# Memory headroom check
_avail_kb=0
while IFS=$':\t ' read -r _k _v _; do
  [[ "$_k" == "MemAvailable" ]] && { _avail_kb=$_v; break; }
done < /proc/meminfo
_total_kb=0
while IFS=$':\t ' read -r _k _v _; do
  [[ "$_k" == "MemTotal" ]] && { _total_kb=$_v; break; }
done < /proc/meminfo
_avail_pct=$(( _avail_kb * 100 / _total_kb ))
if (( _avail_pct < 35 )); then
  echo -e "  ${RED}✗ Only ${_avail_pct}% RAM free — need ≥35% for stress test${RST}" | tee -a "$LOG_FILE"
  exit 1
fi
echo "  ✓ ${_avail_pct}% RAM free (${_avail_kb} kB) — sufficient" | tee -a "$LOG_FILE"

# VS Code RSS check
_vscode_rss_kb=$(ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
echo "  ✓ VS Code RSS: $(( _vscode_rss_kb / 1024 )) MB" | tee -a "$LOG_FILE"

if $DRY_RUN; then
  echo -e "\n${YEL}DRY-RUN — preflight passed, exiting without starting browser.${RST}" | tee -a "$LOG_FILE"
  exit 0
fi

# ── Temporarily raise Chrome PID cap ────────────────────────────────────────
# Playwright's headless Chromium spawns ~7 sub-processes per browser.  The
# daemon's default CHROME_COUNT_MAX=3 would SIGKILL most of them.  Temporarily
# raise the cap for the stress test; the daemon's memory-based kill thresholds
# still protect against actual OOM.
WD_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/mem-watchdog/config.sh"
_ORIGINAL_CAP=""
if [[ -f "$WD_CONFIG" ]]; then
  _ORIGINAL_CAP=$(grep '^CHROME_COUNT_MAX=' "$WD_CONFIG" 2>/dev/null || true)
fi
_CHROME_CAP_NEEDED=$(( 7 * TABS_COUNT + 3 ))  # ~7 PIDs per tab + headroom
if [[ -f "$WD_CONFIG" ]] && grep -q '^CHROME_COUNT_MAX=' "$WD_CONFIG"; then
  sed -i "s/^CHROME_COUNT_MAX=.*/CHROME_COUNT_MAX=${_CHROME_CAP_NEEDED}/" "$WD_CONFIG"
else
  mkdir -p "$(dirname "$WD_CONFIG")"
  echo "CHROME_COUNT_MAX=${_CHROME_CAP_NEEDED}" >> "$WD_CONFIG"
fi
systemctl --user restart mem-watchdog 2>/dev/null
sleep 1
echo "  ✓ Daemon restarted with CHROME_COUNT_MAX=${_CHROME_CAP_NEEDED}" | tee -a "$LOG_FILE"

# ── Create screenshot directory for medium/long ─────────────────────────────
if [[ "$SCENARIO" != "short" ]]; then
  mkdir -p "$SCREENSHOT_DIR"
fi

# ── TSV header ───────────────────────────────────────────────────────────────
printf 'timestamp\tMemAvailable_kb\tPSI_some_avg10\tPSI_full_avg10\tvscode_rss_mb\tchrome_rss_mb\twatchdog_stage\n' > "$TSV_FILE"

# ── Telemetry sampler (background) ──────────────────────────────────────────
# Runs every 5 seconds, appending one TSV row per sample.
# Uses zero-fork /proc reads for MemAvailable and PSI (same patterns as
# test-pressure.sh snapshot()).  Chrome and VS Code RSS require /proc/*/status
# iteration — more expensive but only every 5s.

telemetry_sample() {
  local ts avail_kb psi_some psi_full vscode_rss chrome_rss wd_stage
  local _k _v _ _pline _sf _name _rss

  ts=$EPOCHSECONDS

  # MemAvailable
  avail_kb=0
  while IFS=$':\t ' read -r _k _v _; do
    [[ "$_k" == "MemAvailable" ]] && { avail_kb=$_v; break; }
  done < /proc/meminfo

  # PSI
  psi_some="0.00"; psi_full="0.00"
  while IFS= read -r _pline; do
    case "$_pline" in
      full*)  psi_full="${_pline#*avg10=}"; psi_full="${psi_full%% *}" ;;
      some*)  psi_some="${_pline#*avg10=}"; psi_some="${psi_some%% *}" ;;
    esac
  done < /proc/pressure/memory 2>/dev/null || true

  # VS Code aggregate RSS (kB → MB)
  vscode_rss=0
  for _sf in /proc/[0-9]*/status; do
    [[ -r "$_sf" ]] || continue
    while IFS=$':\t ' read -r _k _v _; do
      case "$_k" in
        Name)  [[ "$_v" == "code" ]] || break ;;
        VmRSS) (( vscode_rss += _v )); break ;;
      esac
    done < "$_sf" 2>/dev/null
  done
  vscode_rss=$(( vscode_rss / 1024 ))

  # Chrome aggregate RSS (kB → MB)
  chrome_rss=0
  for _sf in /proc/[0-9]*/status; do
    [[ -r "$_sf" ]] || continue
    _name=""
    _rss=0
    while IFS=$':\t ' read -r _k _v _; do
      case "$_k" in
        Name)  _name="$_v" ;;
        VmRSS) _rss=$_v; break ;;
      esac
    done < "$_sf" 2>/dev/null
    if [[ "$_name" == chrome* || "$_name" == chromium* ]]; then
      (( chrome_rss += _rss ))
    fi
  done
  chrome_rss=$(( chrome_rss / 1024 ))

  # Watchdog stage (from last journal line matching "stage=")
  wd_stage=$(journalctl --user -u mem-watchdog --since "10 seconds ago" --no-pager -q 2>/dev/null \
    | grep -oP 'stage=\K[0-9]+' | tail -1 || echo "0")
  [[ -z "$wd_stage" ]] && wd_stage=0

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ts" "$avail_kb" "$psi_some" "$psi_full" "$vscode_rss" "$chrome_rss" "$wd_stage" >> "$TSV_FILE"
}

sampler_loop() {
  while true; do
    telemetry_sample
    sleep 5 || break
  done
}

sampler_loop &
SAMPLER_PID=$!

# ── Cleanup trap ─────────────────────────────────────────────────────────────
cleanup() {
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  # Kill any remaining Playwright chrome
  pkill -f 'mem-watchdog-stress-test' 2>/dev/null || true
  # Restore daemon Chrome PID cap
  if [[ -n "$_ORIGINAL_CAP" ]]; then
    sed -i "s/^CHROME_COUNT_MAX=.*/$_ORIGINAL_CAP/" "$WD_CONFIG" 2>/dev/null
  else
    sed -i '/^CHROME_COUNT_MAX=/d' "$WD_CONFIG" 2>/dev/null
  fi
  systemctl --user restart mem-watchdog 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Run Playwright ───────────────────────────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "── Starting Playwright ($SCENARIO: ${DESC})" | tee -a "$LOG_FILE"
echo "   Target: https://www.frankspressurewashing.com" | tee -a "$LOG_FILE"
echo "   Duration: ${DURATION_S}s" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

PW_ARGS=("--scenario=$SCENARIO")
if [[ "$SCENARIO" != "short" ]]; then
  PW_ARGS+=("--screenshot-dir=$SCREENSHOT_DIR")
fi

# Journal cursor for kill detection
JOURNAL_CURSOR=$(journalctl --user -u mem-watchdog --show-cursor -n 0 2>/dev/null \
  | grep -o 'cursor: .*' | cut -d' ' -f2 || echo "")

PW_START=$EPOCHSECONDS
NODE_PATH="$PW_NODE_MODULES" node "$REPO/tests/stress-playwright.js" "${PW_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE" &
PW_PID=$!

# Wait for Playwright to finish or duration to expire
_elapsed=0
while kill -0 "$PW_PID" 2>/dev/null && (( _elapsed < DURATION_S + 30 )); do
  sleep 5
  _elapsed=$(( EPOCHSECONDS - PW_START ))
done

# If Playwright is still running after duration + grace, kill it
if kill -0 "$PW_PID" 2>/dev/null; then
  echo "  Sending SIGTERM to Playwright (duration exceeded)" | tee -a "$LOG_FILE"
  kill "$PW_PID" 2>/dev/null || true
  sleep 3
  kill -9 "$PW_PID" 2>/dev/null || true
fi
wait "$PW_PID" 2>/dev/null || true

# Stop telemetry sampler
kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true

# Final telemetry sample
telemetry_sample

# ── Check for OOM kills during the run ───────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
echo "── Results" | tee -a "$LOG_FILE"

oom_kills=0
if [[ -n "$JOURNAL_CURSOR" ]]; then
  oom_kills=$(journalctl --user -u mem-watchdog --after-cursor="$JOURNAL_CURSOR" --no-pager -q 2>/dev/null \
    | grep -c 'ACTION(SIGKILL)\|kill_vscode_main\|oom-killer' || true)
else
  oom_kills=$(journalctl --user -u mem-watchdog --since "${DURATION_S} seconds ago" --no-pager -q 2>/dev/null \
    | grep -c 'ACTION(SIGKILL)\|kill_vscode_main\|oom-killer' || true)
fi

sigterm_count=0
if [[ -n "$JOURNAL_CURSOR" ]]; then
  sigterm_count=$(journalctl --user -u mem-watchdog --after-cursor="$JOURNAL_CURSOR" --no-pager -q 2>/dev/null \
    | grep -c 'ACTION(SIGTERM)' || true)
fi

# ── Summary statistics from TSV ──────────────────────────────────────────────
sample_count=$(( $(wc -l < "$TSV_FILE") - 1 ))  # subtract header

if (( sample_count > 0 )); then
  python3 -c "
import sys, statistics

rows = []
with open('$TSV_FILE') as f:
    header = f.readline().strip().split('\t')
    for line in f:
        parts = line.strip().split('\t')
        if len(parts) == len(header):
            rows.append({h: parts[i] for i, h in enumerate(header)})

if not rows:
    print('  No telemetry data collected.')
    sys.exit(0)

avail = [int(r['MemAvailable_kb']) for r in rows]
vscode = [int(r['vscode_rss_mb']) for r in rows]
chrome = [int(r['chrome_rss_mb']) for r in rows]
stages = [int(r['watchdog_stage']) for r in rows]

print(f'  Samples:           {len(rows)}')
print(f'  Duration:          {int(rows[-1][\"timestamp\"]) - int(rows[0][\"timestamp\"])}s')
print()
print(f'  MemAvailable (kB): min={min(avail):,}  max={max(avail):,}  mean={int(statistics.mean(avail)):,}')
print(f'  VS Code RSS (MB):  min={min(vscode)}  max={max(vscode)}  mean={int(statistics.mean(vscode))}')
print(f'  Chrome RSS (MB):   min={min(chrome)}  max={max(chrome)}  mean={int(statistics.mean(chrome))}')
print()
print(f'  Watchdog stages:   {dict((s, stages.count(s)) for s in sorted(set(stages)))}')
max_stage = max(stages)
print(f'  Max stage reached: {max_stage}')
" 2>&1 | tee -a "$LOG_FILE"
else
  echo "  No telemetry samples collected." | tee -a "$LOG_FILE"
fi

echo "" | tee -a "$LOG_FILE"
echo "  SIGTERM actions:   ${sigterm_count}" | tee -a "$LOG_FILE"
echo "  OOM/SIGKILL kills: ${oom_kills}" | tee -a "$LOG_FILE"
echo "  TSV file:          ${TSV_FILE}" | tee -a "$LOG_FILE"

# ── Pass/Fail verdict ───────────────────────────────────────────────────────
echo "" | tee -a "$LOG_FILE"
if (( oom_kills > 0 )); then
  echo -e "${RED}FAIL: ${oom_kills} OOM/SIGKILL event(s) during ${SCENARIO} scenario${RST}" | tee -a "$LOG_FILE"
  exit 1
fi

# Medium scenario gate: stage must never reach 4
if [[ "$SCENARIO" == "medium" || "$SCENARIO" == "long" ]]; then
  max_stage=$(python3 -c "
with open('$TSV_FILE') as f:
    f.readline()  # skip header
    print(max((int(line.strip().split('\t')[6]) for line in f if line.strip()), default=0))
" 2>/dev/null || echo 0)
  if (( max_stage >= 4 )); then
    echo -e "${RED}FAIL: Watchdog reached stage ${max_stage} during ${SCENARIO} (gate: <4)${RST}" | tee -a "$LOG_FILE"
    exit 1
  fi
fi

echo -e "${GRN}PASS: ${SCENARIO} scenario completed — no OOM kills, watchdog stable${RST}" | tee -a "$LOG_FILE"
echo -e "${CYN}════════════════════════════════════════════════════════════════${RST}" | tee -a "$LOG_FILE"
exit 0
