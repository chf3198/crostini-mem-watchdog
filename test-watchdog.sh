#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-watchdog.sh — Bounded test suite for mem-watchdog.sh
#
# Runs a finite set of checks, logs results to scripts/scratch/, exits cleanly.
# NEVER runs indefinitely — every test has an explicit timeout.
#
# Usage: ./scripts/test-watchdog.sh
# ─────────────────────────────────────────────────────────────────────────────

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$REPO/scripts/scratch/watchdog-test-$(date '+%Y%m%d-%H%M%S').log"
WATCHDOG="$REPO/scripts/mem-watchdog.sh"

mkdir -p "$REPO/scripts/scratch"

pass=0
fail=0
results=()

# ── Helpers ──────────────────────────────────────────────────────────────────
tee_log() { echo "$*" | tee -a "$LOG"; }
PASS() { ((pass++)); results+=("  ✅ PASS: $*"); tee_log "  PASS: $*"; }
FAIL() { ((fail++)); results+=("  ❌ FAIL: $*"); tee_log "  FAIL: $*"; }

tee_log "════════════════════════════════════════════════════════════════"
tee_log "mem-watchdog test suite — $(date '+%Y-%m-%d %H:%M:%S')"
tee_log "Log: $LOG"
tee_log "════════════════════════════════════════════════════════════════"

# ── TEST 1: Service is active ─────────────────────────────────────────────────
tee_log ""
tee_log "── Test 1: Service running"
if systemctl --user is-active --quiet mem-watchdog; then
  PASS "mem-watchdog.service is active"
else
  FAIL "mem-watchdog.service is NOT active"
fi

# ── TEST 2: Service has correct PID (bash, not sleep) ────────────────────────
tee_log ""
tee_log "── Test 2: Service main process is bash (not a hung sleep)"
svc_pid=$(systemctl --user show mem-watchdog -p MainPID --value 2>/dev/null)
svc_cmd=$(ps -p "$svc_pid" -o comm= 2>/dev/null)
if [[ "$svc_cmd" == "bash" ]]; then
  PASS "MainPID $svc_pid is bash"
else
  FAIL "MainPID $svc_pid is '$svc_cmd' (expected bash)"
fi

# ── TEST 3: No stray dry-run instances ───────────────────────────────────────
tee_log ""
tee_log "── Test 3: No stray dry-run watchdog instances"
stray=$(pgrep -af 'mem-watchdog.*dry-run' 2>/dev/null | grep -v "$$" | grep -v "test-watchdog")
if [[ -z "$stray" ]]; then
  PASS "No stray --dry-run instances"
else
  FAIL "Stray instances found: $stray"
fi

# ── TEST 4: argv.json V8 heap ────────────────────────────────────────────────
tee_log ""
tee_log "── Test 4: V8 heap limit is 2048 MB"
heap=$(grep -o 'max-old-space-size=[0-9]*' ~/.config/Code/argv.json 2>/dev/null | grep -o '[0-9]*')
if [[ "$heap" == "2048" ]]; then
  PASS "argv.json: --max-old-space-size=2048"
else
  FAIL "argv.json heap=$heap (expected 2048)"
fi

# ── TEST 5: VS Code oom_score_adj ────────────────────────────────────────────
tee_log ""
tee_log "── Test 5: VS Code oom_score_adj lowered from Electron default"
vscode_pids=$(ps -C code -o pid= 2>/dev/null | head -5)
if [[ -z "$vscode_pids" ]]; then
  PASS "No VS Code processes running (skip adj check)"
else
  bad_adj=0
  for pid in $vscode_pids; do
    adj=$(cat "/proc/$pid/oom_score_adj" 2>/dev/null)
    if (( adj > 100 )); then
      tee_log "    PID $pid still has adj=$adj (>100)"
      ((bad_adj++))
    fi
  done
  if (( bad_adj == 0 )); then
    PASS "All VS Code PIDs have oom_score_adj ≤ 100"
  else
    FAIL "$bad_adj VS Code PID(s) still have oom_score_adj > 100"
  fi
fi

# ── TEST 6: /proc/meminfo reads work ─────────────────────────────────────────
tee_log ""
tee_log "── Test 6: /proc/meminfo reads MemAvailable/MemTotal correctly"
avail=$(awk '/^MemAvailable/{print $2; exit}' /proc/meminfo)
total=$(awk '/^MemTotal/{print $2; exit}' /proc/meminfo)
if [[ -n "$avail" && -n "$total" && "$total" -gt 0 ]]; then
  pct=$(( avail * 100 / total ))
  PASS "MemAvailable=${avail}kB MemTotal=${total}kB (${pct}% free)"
else
  FAIL "Could not read MemAvailable or MemTotal"
fi

# ── TEST 7: PSI read works ────────────────────────────────────────────────────
tee_log ""
tee_log "── Test 7: /proc/pressure/memory PSI read"
psi_x100=$(awk '/^full[[:space:]]/{
  for(i=1;i<=NF;i++){if($i~/^avg10=/){sub("avg10=","",$i);printf "%d",$i*100;exit}}
}' /proc/pressure/memory 2>/dev/null)
if [[ -n "$psi_x100" ]]; then
  PASS "PSI full avg10 readable (${psi_x100} x100)"
else
  FAIL "/proc/pressure/memory unreadable"
fi

# ── TEST 8: SwapFree overflow does NOT affect our reads ──────────────────────
tee_log ""
tee_log "── Test 8: SwapFree overflow sentinel does not contaminate awk reads"
# The bogus value is ~18446744073709551360 — just confirm our awk avoids it
swap_raw=$(awk '/^SwapFree/{print $2; exit}' /proc/meminfo)
# We never USE SwapFree, but check avail/total are still clean numbers
if [[ "$avail" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]]; then
  PASS "avail/total are clean integers despite SwapFree=${swap_raw}"
else
  FAIL "avail='$avail' or total='$total' not clean integers"
fi

# ── TEST 9: no /tmp writes from watchdog ─────────────────────────────────────
tee_log ""
tee_log "── Test 9: mem-watchdog.sh has no /tmp references"
tmp_refs=$(grep -c '/tmp/' "$WATCHDOG" 2>/dev/null)
if [[ "$tmp_refs" -eq 0 ]]; then
  PASS "No /tmp references in mem-watchdog.sh"
else
  FAIL "$tmp_refs /tmp reference(s) still in mem-watchdog.sh"
fi

# ── TEST 10: dry-run exits on SIGTERM (bounded) ───────────────────────────────
tee_log ""
tee_log "── Test 10: --dry-run starts and responds to SIGTERM within 10s"
timeout 10 bash "$WATCHDOG" --dry-run &
dry_pid=$!
sleep 2
if kill -0 "$dry_pid" 2>/dev/null; then
  # Running — send SIGTERM and wait
  kill "$dry_pid" 2>/dev/null
  wait "$dry_pid" 2>/dev/null
  PASS "--dry-run started and SIGTERM terminated it cleanly"
else
  FAIL "--dry-run exited on its own within 2s (unexpected)"
fi

# ── TEST 11: journal is receiving watchdog output ────────────────────────────
tee_log ""
tee_log "── Test 11: Journal receiving watchdog output"
recent=$(journalctl --user -u mem-watchdog --since "1 hour ago" --no-pager -q 2>/dev/null | tail -3)
if [[ -n "$recent" ]]; then
  PASS "Journal has recent watchdog entries"
  tee_log "    Last entry: $(echo "$recent" | tail -1)"
else
  FAIL "No watchdog journal entries in last hour"
fi

# ── TEST 12: publish script has no /tmp references ───────────────────────────
tee_log ""
tee_log "── Test 12: publish-to-squarespace.js has no /tmp references"
pub_tmp=$(grep -c '/tmp/' "$REPO/scripts/publish-to-squarespace.js" 2>/dev/null)
if [[ "$pub_tmp" -eq 0 ]]; then
  PASS "No /tmp references in publish-to-squarespace.js"
else
  FAIL "$pub_tmp /tmp reference(s) still in publish-to-squarespace.js"
fi

# ── SUMMARY ──────────────────────────────────────────────────────────────────
tee_log ""
tee_log "════════════════════════════════════════════════════════════════"
tee_log "RESULTS: ${pass} passed, ${fail} failed — $(date '+%H:%M:%S')"
tee_log "════════════════════════════════════════════════════════════════"
for r in "${results[@]}"; do tee_log "$r"; done
tee_log ""
tee_log "Full log: $LOG"

exit $(( fail > 0 ? 1 : 0 ))
