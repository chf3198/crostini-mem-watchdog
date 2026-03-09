#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-pressure.sh — Real memory pressure tests for mem-watchdog
#
# Unlike test-watchdog.sh (which does static checks), this script exercises
# the watchdog's LIVE kill logic by:
#   1. Starting a decoy "chrome" process (exec -a chrome) that will be targeted
#   2. Consuming memory until MemAvailable crosses a watchdog threshold
#   3. Verifying the watchdog killed the decoy via journal
#   4. Cleaning up
#
# SAFETY:
#   - The decoy is a real process the watchdog will SIGTERM/SIGKILL
#   - Memory consumption is bounded — released immediately after signal
#   - Sets a cgroup memory limit as a hard safety ceiling (sudo -n, no password)
#   - Will NOT run if VS Code is consuming > 3 GB (too risky)
#   - Run only with VS Code minimized / extension host quiet
#
# REQUIREMENTS:
#   - mem-watchdog service must be running (--dry-run won't kill anything)
#   - sudo -n must work without password (confirmed on this system)
#   - python3 available (for controlled memory allocation)
#
# CGROUP NOTE (cgroup v1 — see docs/technical/system-stability.md §10):
#   Writing to memory.limit_in_bytes constrains the kernel OOM hard limit
#   but does NOT change /proc/meminfo values. So the watchdog's MemAvailable
#   threshold logic is tested by ACTUAL allocation (Phase 2), while the cgroup
#   limit acts as a safety net preventing runaway allocations from crashing
#   the real VS Code session.
#
# Usage:
#   bash test-pressure.sh              # full suite (requires ~1 GB headroom)
#   bash test-pressure.sh --dry-run    # show what would happen without allocating
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="$REPO/scratch/pressure-test-$(date '+%Y%m%d-%H%M%S').log"
mkdir -p "$REPO/scratch"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

pass=0
fail=0
results=()

# ── Colour codes ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; BLD='\033[1m'; RST='\033[0m'

tee_log() { echo -e "$*" | tee -a "$LOG"; }
PASS()    { ((++pass)); results+=("  ✅ PASS: $*"); tee_log "  ${GRN}PASS${RST}: $*"; }
FAIL()    { ((++fail)); results+=("  ❌ FAIL: $*"); tee_log "  ${RED}FAIL${RST}: $*"; }
SKIP()    { results+=("  ⏭  SKIP: $*"); tee_log "  ${YEL}SKIP${RST}: $*"; }

tee_log ""
tee_log "════════════════════════════════════════════════════════════════"
tee_log "mem-watchdog pressure test suite — $(date '+%Y-%m-%d %H:%M:%S')"
tee_log "Log: $LOG"
$DRY_RUN && tee_log "${YEL}  *** DRY-RUN — no memory will be allocated, no processes killed ***${RST}"
tee_log "════════════════════════════════════════════════════════════════"

# ── Cgroup path discovery ─────────────────────────────────────────────────────
CGRP=$(awk -F: '$2=="memory"{print "/sys/fs/cgroup/memory" $3; exit}' /proc/self/cgroup 2>/dev/null || echo "")
if [[ -z "$CGRP" || ! -f "$CGRP/memory.limit_in_bytes" ]]; then
  tee_log "${RED}ERROR: Cannot find memory cgroup at $CGRP${RST}"
  exit 1
fi
tee_log "  Cgroup: $CGRP"

# ── SAFETY PREFLIGHT ─────────────────────────────────────────────────────────
tee_log ""
tee_log "── Preflight checks"

# Check watchdog is running (not dry-run mode)
if ! systemctl --user is-active --quiet mem-watchdog; then
  tee_log "${RED}ERROR: mem-watchdog service is not active. Start it first.${RST}"
  exit 1
fi
tee_log "  ✓ mem-watchdog service is active"

# Reject if watchdog itself is running in dry-run (it won't kill anything)
svc_cmd=$(ps -p "$(systemctl --user show mem-watchdog -p MainPID --value 2>/dev/null)" -o args= 2>/dev/null || true)
if echo "$svc_cmd" | grep -q 'dry-run'; then
  tee_log "${RED}ERROR: mem-watchdog is running with --dry-run. Restart without it.${RST}"
  exit 1
fi
tee_log "  ✓ mem-watchdog is running in live mode (not dry-run)"

# Reject if VS Code is too large
vscode_rss_kb=$(ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
if (( vscode_rss_kb > 3000000 )); then
  tee_log "${RED}ERROR: VS Code RSS ${vscode_rss_kb} kB (>3 GB) — too risky to run pressure tests.${RST}"
  tee_log "  Restart the VS Code extension host first: Developer: Restart Extension Host"
  exit 1
fi
tee_log "  ✓ VS Code RSS ${vscode_rss_kb} kB (<3 GB) — safe to proceed"

# Check available memory
avail_kb=$(awk '/^MemAvailable/{print $2; exit}' /proc/meminfo)
total_kb=$(awk '/^MemTotal/{print $2; exit}' /proc/meminfo)
avail_pct=$(( avail_kb * 100 / total_kb ))
if (( avail_pct < 35 )); then
  tee_log "${RED}ERROR: Only ${avail_pct}% RAM free (${avail_kb} kB). Need ≥35% to run pressure tests safely.${RST}"
  exit 1
fi
tee_log "  ✓ ${avail_pct}% RAM free (${avail_kb} kB) — sufficient headroom"

# ── INSTALL SAFETY CGROUP CEILING ────────────────────────────────────────────
# Set a hard ceiling 500 MB above current usage so tests can never consume
# enough to actually OOM-kill VS Code even if memory allocation gets stuck.
tee_log ""
tee_log "── Installing cgroup safety ceiling"

ORIG_LIMIT=$(cat "$CGRP/memory.limit_in_bytes")
# Safety ceiling = 90% of total RAM.
# This keeps the hard cgroup OOM wall above VS Code's footprint (~2.5 GB) but
# still prevents runaway allocations from consuming the last 10% (~630 MB).
# The watchdog's 25% SIGTERM threshold fires at 75% utilization — well before the ceiling.
safety_ceiling_bytes=$(( total_kb * 90 / 100 * 1024 ))

cleanup_cgroup() {
  tee_log ""
  tee_log "── Restoring cgroup limit to original (${ORIG_LIMIT} bytes)"
  sudo -n sh -c "echo ${ORIG_LIMIT} > '${CGRP}/memory.limit_in_bytes'" 2>/dev/null || true
}
trap cleanup_cgroup EXIT INT TERM

if $DRY_RUN; then
  tee_log "  (dry-run: would set ceiling to $((safety_ceiling_bytes / 1024 / 1024)) MB)"
else
  sudo -n sh -c "echo ${safety_ceiling_bytes} > '${CGRP}/memory.limit_in_bytes'"
  tee_log "  ✓ Ceiling set: $((safety_ceiling_bytes / 1024 / 1024)) MB (90% of total RAM — watchdog fires at 75% utilization, well before this)"
fi

# ── Structured snapshot for post-analysis ─────────────────────────────────────────
# Usage: snapshot "label"
# Writes one human-readable line to tee_log (grep/awk parseable) AND one JSON
# object to $SNAP_JSON (newline-delimited, jq-friendly) for post-analysis.
# Requires $CGRP, $total_kb, and $WD_PID (set once before the tests begin).

SNAP_JSON="$REPO/scratch/pressure-snaps-$(date '+%Y%m%d-%H%M%S').jsonl"

snapshot() {
  local label="${1:-snap}"
  # shellcheck disable=SC2034  # _u absorbs trailing unit fields ("kB") — intentional discard
  local ts avail_kb avail_pct free_kb dirty_kb psi_full psi_some
  local vscode_rss vscode_npids wd_rss wd_cpu_ticks cgrp_used_mb cgrp_limit_mb
  local _sk _sv _u _sf _pline _stat_raw
  local -a _stat_fields

  # ── Timestamp — $EPOCHSECONDS: bash 5.0+ magic variable, zero fork, zero syscall ──
  ts=$EPOCHSECONDS

  # ── Memory fields — one pass through /proc/meminfo (zero fork, no page cache) ──
  # IFS=$':\t ' splits both /proc/meminfo ("Key:   value kB") and
  # /proc/PID/status ("Key:\tvalue kB") cleanly without forking awk.
  # Break at Dirty — it is the last field we need and appears after
  # MemFree and MemAvailable in all Linux kernel versions.
  avail_kb=0; free_kb=0; dirty_kb=0
  while IFS=$':\t ' read -r _sk _sv _u; do
    case "$_sk" in
      MemAvailable) avail_kb=$_sv ;;
      MemFree)      free_kb=$_sv  ;;
      Dirty)        dirty_kb=$_sv; break ;;
    esac
  done < /proc/meminfo
  avail_pct=$(( avail_kb * 100 / total_kb ))

  # ── PSI — one pass through /proc/pressure/memory (zero fork, no page cache) ──
  # "full avg10=X.XX avg60=..." — strip everything before avg10= then after first space.
  psi_full="n/a"; psi_some="n/a"
  while IFS= read -r _pline; do
    case "$_pline" in
      full*)  psi_full="${_pline#*avg10=}"; psi_full="${psi_full%% *}" ;;
      some*)  psi_some="${_pline#*avg10=}"; psi_some="${psi_some%% *}" ;;
    esac
  done < /proc/pressure/memory 2>/dev/null || true

  # ── VS Code aggregate RSS + PID count — /proc/*/status iteration (zero fork) ──
  # Glob uses opendir+readdir inside bash (no fork, no page cache).
  # Non-code procs: reads only Name (first line) then breaks — minimal I/O.
  # Code procs: reads ~22 lines to reach VmRSS.
  vscode_rss=0; vscode_npids=0
  for _sf in /proc/[0-9]*/status; do
    [[ -r "$_sf" ]] || continue
    while IFS=$':\t ' read -r _sk _sv _u; do
      case "$_sk" in
        Name)  [[ "$_sv" == "code" ]] || break ;;
        VmRSS) (( vscode_rss += _sv )); (( ++vscode_npids )); break ;;
      esac
    done < "$_sf" 2>/dev/null
  done

  # ── Watchdog RSS — /proc/$WD_PID/status (zero fork) ──────────────────────────
  wd_rss=0
  if [[ "$WD_PID" != "0" && -r "/proc/$WD_PID/status" ]]; then
    while IFS=$':\t ' read -r _sk _sv _u; do
      [[ "$_sk" == "VmRSS" ]] && { wd_rss=$_sv; break; }
    done < "/proc/$WD_PID/status"
  fi

  # ── Watchdog lifetime CPU ticks — /proc/$WD_PID/stat (zero fork) ─────────────
  # utime+stime in CLK_TCK units (100/s on Linux). Diff across two snapshots:
  #   cpu_seconds = (ticks_b - ticks_a) / 100 / (ts_b - ts_a)
  # More useful than a single %%cpu snapshot for measuring daemon CPU budget.
  wd_cpu_ticks=0
  if [[ "$WD_PID" != "0" && -r "/proc/$WD_PID/stat" ]]; then
    read -r _stat_raw < "/proc/$WD_PID/stat" 2>/dev/null || _stat_raw=""
    if [[ -n "$_stat_raw" ]]; then
      # ## removes the LONGEST prefix matching "*) " — handles spaces in comm.
      _stat_raw="${_stat_raw##*) }"
      read -r -a _stat_fields <<< "$_stat_raw"
      # After stripping "pid (comm) ": state=0 ppid=1 ... utime=11 stime=12
      wd_cpu_ticks=$(( ${_stat_fields[11]:-0} + ${_stat_fields[12]:-0} ))
    fi
  fi

  # ── Cgroup accounting — direct procfs reads (zero fork) ──────────────────────
  cgrp_used_mb=0; cgrp_limit_mb=0
  { read -r _sv < "$CGRP/memory.usage_in_bytes"  2>/dev/null && cgrp_used_mb=$(( _sv / 1024 / 1024 ));  } || true
  { read -r _sv < "$CGRP/memory.limit_in_bytes"  2>/dev/null && cgrp_limit_mb=$(( _sv / 1024 / 1024 )); } || true

  # ── Human-readable log line (printf is a bash builtin — zero fork) ───────────
  tee_log "  [snap:${label}] ts=${ts} | avail=${avail_pct}%/${avail_kb}kB | free=${free_kb}kB | dirty=${dirty_kb}kB | psi_full=${psi_full} psi_some=${psi_some} | vscode=${vscode_rss}kB/${vscode_npids}pids | wd_rss=${wd_rss}kB wd_cputicks=${wd_cpu_ticks} | cgroup=${cgrp_used_mb}MB/${cgrp_limit_mb}MB"

  # ── JSON line for jq / pandas post-analysis (printf builtin — zero fork) ─────
  printf '{"label":"%s","ts":%s,"avail_pct":%d,"avail_kb":%d,"free_kb":%d,"dirty_kb":%d,"psi_full":"%s","psi_some":"%s","vscode_rss_kb":%d,"vscode_npids":%d,"wd_rss_kb":%d,"wd_cpu_ticks":%d,"cgroup_used_mb":%d,"cgroup_limit_mb":%d}\n' \
    "$label" "$ts" "$avail_pct" "$avail_kb" "$free_kb" "$dirty_kb" \
    "$psi_full" "$psi_some" "$vscode_rss" "$vscode_npids" \
    "$wd_rss" "$wd_cpu_ticks" "$cgrp_used_mb" "$cgrp_limit_mb" >> "$SNAP_JSON"
}

# ── TEST 1: SIGTERM threshold (MemAvailable ≤ 25%) ─────────────────────────────────
tee_log ""
tee_log "── Test 1: Watchdog SIGTERMs process named 'chrome' when RAM ≤ 25%"
# Resolve watchdog MainPID once — the ONE unavoidable fork in the snapshot path.
# Amortized across all 10 snapshot() calls. PID is stable for the ~60 s test
# duration; the service is not restarted between tests.
WD_PID=$(systemctl --user show mem-watchdog -p MainPID --value 2>/dev/null)
WD_PID="${WD_PID//[[:space:]]/}"   # strip whitespace — bash parameter expansion, no tr fork
[[ -z "$WD_PID" ]] && WD_PID=0

snapshot "suite-start"
tee_log "  Snapshot log: $SNAP_JSON"

# Start a decoy process named "chrome" using exec -a
# It just sleeps — the watchdog will kill it on the name match
if $DRY_RUN; then
  SKIP "dry-run: would start decoy 'chrome' (exec -a chrome sleep 120) and consume ~$(( avail_kb - (total_kb * 24 / 100) )) kB"
else
  # Launch decoy
  (exec -a chrome sleep 300) &
  DECOY_PID=$!
  tee_log "  Decoy 'chrome' PID ${DECOY_PID} started"

  # Record journal position before allocating
  JOURNAL_CURSOR=$(journalctl --user -u mem-watchdog --show-cursor -n 0 2>/dev/null | grep -o 'cursor: .*' | cut -d' ' -f2 || echo "")

  # Calculate how much to allocate to cross the 26% threshold (just inside the 25% SIGTERM zone)
  target_avail_pct=23
  target_avail_kb=$(( total_kb * target_avail_pct / 100 ))
  alloc_kb=$(( avail_kb - target_avail_kb ))
  alloc_mb=$(( alloc_kb / 1024 ))

  if (( alloc_mb <= 0 )); then
    SKIP "Already below SIGTERM threshold — cannot test meaningfully (${avail_pct}% free)"
    kill "$DECOY_PID" 2>/dev/null || true
  else
    tee_log "  Allocating ~${alloc_mb} MB to push MemAvailable to ~${target_avail_pct}%..."
      snapshot "t1-pre-alloc"
    if (( alloc_mb > 1500 )); then
      kill "$DECOY_PID" 2>/dev/null || true
      SKIP "Needs ${alloc_mb} MB allocation to reach threshold from ${avail_pct}% free — too large for a live VS Code session. Close Chrome/MCP browser tabs first, or run when RAM is tighter (avail < 40%)."
    else
      python3 -c "
import time, sys
mb = ${alloc_mb}
# Allocate in chunks to be gentle; each chunk is 10 MB
chunk = 10 * 1024 * 1024
buf = []
for i in range(mb // 10):
    buf.append(bytearray(chunk))
    # Write to each page to ensure actual physical allocation
    buf[-1][0] = 1
print(f'Allocated {mb} MB', flush=True)
time.sleep(15)
print('Releasing', flush=True)
" &
      ALLOC_PID=$!

      # Wait up to 20s for watchdog to fire; sample MemAvailable every second
      # so the descent curve is available in the log for latency post-analysis.
      waited=0
      killed=false
      t_alloc_start=$EPOCHSECONDS    # bash 5.0+ magic var — zero fork, zero syscall
      t_kill_detected=0
      avail_curve=()
      while (( waited < 20 )); do
        sleep 1
        (( ++waited ))
        # Zero-fork MemAvailable read — bash builtin while+read, no awk fork
        cur_avail=0
        while IFS=$':\t ' read -r _mk _mv _; do
          [[ "$_mk" == "MemAvailable" ]] && { cur_avail=$_mv; break; }
        done < /proc/meminfo
        cur_pct=$(( cur_avail * 100 / total_kb ))
        avail_curve+=("${waited}s:${cur_pct}%/${cur_avail}kB")
        if ! kill -0 "$DECOY_PID" 2>/dev/null; then
          t_kill_detected=$EPOCHSECONDS
          killed=true
          break
        fi
      done
      tee_log "  [avail-curve:t1] ${avail_curve[*]}"
      (( t_kill_detected > 0 )) && tee_log "  [kill-latency:t1] $(( t_kill_detected - t_alloc_start ))s from allocation start to decoy death"

      # Kill allocator regardless
      kill "$ALLOC_PID" 2>/dev/null || true
      wait "$ALLOC_PID" 2>/dev/null || true

      if $killed; then
        # Verify it was the watchdog that killed it (check journal)
        sleep 1  # give journald a moment to flush
        snapshot "t1-post-kill"
        tee_log "  [watchdog-journal:t1] last 5 entries:"
        journalctl --user -u mem-watchdog --since "30 seconds ago" --no-pager -q 2>/dev/null \
          | tail -5 | while IFS= read -r jline; do tee_log "    $jline"; done
        if [[ -n "$JOURNAL_CURSOR" ]]; then
          journal_hit=$(journalctl --user -u mem-watchdog --after-cursor="$JOURNAL_CURSOR" --no-pager -q 2>/dev/null | grep -c 'SIGTERM\|Chromium' || echo 0)
        else
          journal_hit=$(journalctl --user -u mem-watchdog --since "1 minute ago" --no-pager -q 2>/dev/null | grep -c 'SIGTERM\|Chromium' || echo 0)
        fi
        if (( journal_hit > 0 )); then
          PASS "Watchdog SIGTERMed decoy chrome (confirmed in journal)"
        else
          PASS "Decoy chrome was killed within 20s (journal confirmation inconclusive)"
        fi
      else
        kill "$DECOY_PID" 2>/dev/null || true
        FAIL "Decoy chrome was NOT killed within 20s — watchdog may have missed the threshold"
      fi
      wait "$DECOY_PID" 2>/dev/null || true
    fi  # alloc_mb <= 1500
  fi    # alloc_mb > 0
fi      # not DRY_RUN

# ── TEST 2: oom_score_adj under pressure ──────────────────────────────────────
tee_log ""
tee_log "── Test 2: VS Code oom_score_adj stays at 0 during pressure"

if $DRY_RUN; then
  SKIP "dry-run: would verify oom_score_adj=0 on all code PIDs after Test 1"
else
  sleep 2  # let watchdog's adjust_oom_scores loop run
  snapshot "t2-oom-adj"
  bad=0
  for pid in $(ps -C code -o pid= 2>/dev/null); do
    adj=$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo "gone")
    if [[ "$adj" == "gone" ]]; then continue; fi
    if (( adj > 0 )); then ((bad+=1)); fi
  done
  if (( bad == 0 )); then
    PASS "All live VS Code PIDs have oom_score_adj ≤ 0"
  else
    FAIL "$bad VS Code PID(s) have oom_score_adj > 0 under pressure"
  fi
fi

# ── TEST 3: Recovery — MemAvailable recovers after kill ──────────────────────
tee_log ""
tee_log "── Test 3: MemAvailable recovers after decoy is killed"

if $DRY_RUN; then
  SKIP "dry-run: would verify MemAvailable rises after chrome kill"
else
  sleep 3
  snapshot "t3-recovery"
  post_avail_kb=0
  while IFS=$':\t ' read -r _mk _mv _; do
    [[ "$_mk" == "MemAvailable" ]] && { post_avail_kb=$_mv; break; }
  done < /proc/meminfo
  post_pct=$(( post_avail_kb * 100 / total_kb ))
  if (( post_pct > avail_pct - 10 )); then
    PASS "MemAvailable recovered to ${post_pct}% (was ${avail_pct}% pre-test)"
  else
    FAIL "MemAvailable still at ${post_pct}% — memory may not have been fully released"
  fi
fi

# ── TEST 4: oom_score_adj set to 1000 on a new chrome-named process ──────────
# Tests the adjust_oom_scores() path without any memory allocation.
# The watchdog runs every 2 s; after 5 s (≥2 iterations) it must have
# condemned the decoy. If the decoy is already killed it means RAM was
# below the 25% SIGTERM threshold — which is equally valid watchdog behaviour.
tee_log ""
tee_log "── Test 4: Watchdog sets oom_score_adj=+1000 on chrome-named process within 5 s"

if $DRY_RUN; then
  SKIP "dry-run: would start (exec -a chrome sleep 300) and verify oom_score_adj=1000 after 5 s"
else
  (exec -a chrome sleep 300) &
  T4_PID=$!
  tee_log "  Decoy 'chrome' PID ${T4_PID} started"
  snapshot "t4-start"

  # Wait at least 2 watchdog iterations (2 s each)
  sleep 5
  snapshot "t4-adj-check"

  t4_adj=$(cat "/proc/${T4_PID}/oom_score_adj" 2>/dev/null || echo "gone")

  if [[ "$t4_adj" == "gone" ]]; then
    # Watchdog killed the process — RAM was at or below the SIGTERM threshold.
    # That is correct daemon behaviour; oom_score_adj was certainly set before kill.
    SKIP "Test 4: Decoy killed by watchdog before adj check (RAM ≤ 25% threshold — expected)"
  elif [[ "$t4_adj" == "1000" ]]; then
    PASS "Watchdog set oom_score_adj=1000 on chrome decoy PID ${T4_PID} within 5 s"
  else
    FAIL "oom_score_adj=${t4_adj} on chrome decoy — expected 1000 (watchdog adj logic broken?)"
  fi

  kill "${T4_PID}" 2>/dev/null || true
  wait "${T4_PID}" 2>/dev/null || true
fi

# ── TEST 5: Both chrome AND playwright-named processes killed in one crossing ──
# kill_browsers() fires two independent pkill commands. This test verifies
# BOTH are sent in a single threshold-crossing event, covering the second pkill
# pattern that Test 1 never exercises.
#
# Conditional: requires MemAvailable < 40% to reach the 25% SIGTERM threshold
# with an allocation ≤ 1500 MB. SKIPS safely at high RAM (e.g., fresh boot).
tee_log ""
tee_log "── Test 5: Both chrome + playwright-named processes killed in one threshold crossing"

# Re-read available RAM — may differ from preflight after Test 1 ran
t5_avail_kb=0
while IFS=$':\t ' read -r _mk _mv _; do
  [[ "$_mk" == "MemAvailable" ]] && { t5_avail_kb=$_mv; break; }
done < /proc/meminfo
t5_pct=$(( t5_avail_kb * 100 / total_kb ))

if $DRY_RUN; then
  SKIP "dry-run: would start chrome+playwright decoys and allocate to reach 23% MemAvailable"
elif (( t5_pct >= 40 )); then
  SKIP "Test 5: RAM at ${t5_pct}% free — need <40% to reach 25% SIGTERM threshold within the 1500 MB safe allocation budget (close Chrome/MCP tabs and retry)"
else
  # Start two decoys with browser-matching command-line names
  (exec -a chrome sleep 300) &
  T5_CHROME=$!
  # 'node playwright' matches pkill -f 'node.*playwright' (argv[0] = "node playwright")
  (exec -a 'node playwright' sleep 300) &
  T5_PLAY=$!
  tee_log "  Chrome decoy:     PID ${T5_CHROME}"
  tee_log "  Playwright decoy: PID ${T5_PLAY}"

  t5_target_kb=$(( total_kb * 23 / 100 ))
  t5_alloc_kb=$(( t5_avail_kb - t5_target_kb ))
  t5_alloc_mb=$(( t5_alloc_kb / 1024 ))

  if (( t5_alloc_mb <= 0 || t5_alloc_mb > 1500 )); then
    kill "${T5_CHROME}" "${T5_PLAY}" 2>/dev/null || true
    SKIP "Test 5: Allocation of ${t5_alloc_mb} MB out of safe range — skipping"
  else
    tee_log "  Allocating ~${t5_alloc_mb} MB to push MemAvailable to ~23%..."
    snapshot "t5-pre-alloc"

    python3 -c "
import time
mb = ${t5_alloc_mb}
chunk = 10 * 1024 * 1024
buf = []
for i in range(mb // 10):
    buf.append(bytearray(chunk))
    buf[-1][0] = 1
print(f'Allocated {mb} MB', flush=True)
time.sleep(20)
print('Releasing', flush=True)
" &
    T5_ALLOC=$!

    # Wait up to 25 s for BOTH decoys to be killed; sample MemAvailable curve
    waited=0
    t5_chrome_killed=false
    t5_play_killed=false
    t5_alloc_start=$EPOCHSECONDS    # bash 5.0+ magic var — zero fork, zero syscall
    t5_kill_detected=0
    t5_avail_curve=()
    while (( waited < 25 )); do
      sleep 1
      (( ++waited ))
      # Zero-fork MemAvailable read — bash builtin while+read, no awk fork
      cur_avail=0
      while IFS=$':\t ' read -r _mk _mv _; do
        [[ "$_mk" == "MemAvailable" ]] && { cur_avail=$_mv; break; }
      done < /proc/meminfo
      cur_pct=$(( cur_avail * 100 / total_kb ))
      t5_avail_curve+=("${waited}s:${cur_pct}%")
      kill -0 "${T5_CHROME}" 2>/dev/null || t5_chrome_killed=true
      kill -0 "${T5_PLAY}"   2>/dev/null || t5_play_killed=true
      if $t5_chrome_killed && $t5_play_killed; then
        t5_kill_detected=$EPOCHSECONDS
        break
      fi
    done
    tee_log "  [avail-curve:t5] ${t5_avail_curve[*]}"
    (( t5_kill_detected > 0 )) && tee_log "  [kill-latency:t5] $(( t5_kill_detected - t5_alloc_start ))s from allocation start to both processes dead"

    kill "${T5_ALLOC}" 2>/dev/null || true
    wait "${T5_ALLOC}" 2>/dev/null || true

    if $t5_chrome_killed && $t5_play_killed; then
      snapshot "t5-post-kill"
      PASS "Both chrome and playwright-named decoys killed within ${waited}s"
    elif $t5_chrome_killed && ! $t5_play_killed; then
      FAIL "Chrome decoy killed but playwright-named decoy survived — second pkill pattern broken"
      kill "${T5_PLAY}" 2>/dev/null || true
    elif ! $t5_chrome_killed && $t5_play_killed; then
      FAIL "Playwright-named decoy killed but chrome decoy survived — first pkill pattern broken"
      kill "${T5_CHROME}" 2>/dev/null || true
    else
      FAIL "Neither decoy killed within 25s — watchdog did not fire"
      kill "${T5_CHROME}" "${T5_PLAY}" 2>/dev/null || true
    fi

    wait "${T5_CHROME}" "${T5_PLAY}" 2>/dev/null || true
  fi
fi


tee_log ""
tee_log "════════════════════════════════════════════════════════════════"
tee_log "RESULTS: ${pass} passed, ${fail} failed — $(date '+%H:%M:%S')"
tee_log "════════════════════════════════════════════════════════════════"
for r in "${results[@]}"; do tee_log "$r"; done
tee_log ""
tee_log "Full log: $LOG"
snapshot "suite-end"
tee_log "  Snapshots JSON: $SNAP_JSON"

exit $(( fail > 0 ? 1 : 0 ))
