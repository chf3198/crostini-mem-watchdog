#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# mem-watchdog.sh — Crostini-safe memory watchdog for VS Code / Playwright
#
# WHY THIS EXISTS (do not replace with earlyoom):
#   earlyoom v1.7 crashes immediately on this system with exit code 104.
#   Root cause: ChromeOS Crostini kernel reports a bogus uint64 overflow
#   value for SwapFree when no swap is configured:
#
#     /proc/meminfo → SwapFree: 18446744073709551360 kB
#
#   earlyoom calls C's strtol() on that value → integer overflow → fatal.
#   It has been crash-looping every 3s since installation, providing ZERO
#   protection. See docs/technical/system-stability.md for full analysis.
#
# WHAT THIS DOES:
#   - Reads ONLY MemAvailable and MemTotal — both correct on this kernel.
#   - Also reads /proc/pressure/memory (PSI) for sustained-pressure detection.
#   - Sends SIGTERM to chrome/playwright at ≤25% free RAM.
#   - Escalates to SIGKILL at ≤15% free RAM.
#   - VS Code RSS warning at 2.5 GB: SIGTERM Chrome + desktop alert + journal.
#   - VS Code RSS emergency at 3.5 GB: SIGKILL Chrome; if no Chrome, SIGTERM
#     the highest-RSS `code` process (extension host) to save the VS Code window.
#   - Sets oom_score_adj=0 on VS Code (lowers Electron's default 200-300).
#   - Sets oom_score_adj=+1000 on Chrome (kernel kills it first).
#   - Checks every 2 seconds (was 4s — confirmed too slow to catch rapid spike).
#   - STARTUP MODE: switches to 0.5s checks for 90s when new VS Code PIDs detected.
#   - STARTUP MODE: proactively SIGTERMs Chrome the moment VS Code starts loading.
#   - STARTUP MODE: uses 2.0 GB emergency threshold (vs 3.5 GB normal).
#   - Sends desktop notifications (notify-send) throttled to once per 5 min.
#   - Logs all actions via systemd journal (logger -t mem-watchdog).
#
# USAGE:
#   As a service:  systemctl --user start mem-watchdog  (see mem-watchdog.service)
#   Manual test:   ./scripts/mem-watchdog.sh --dry-run
# ─────────────────────────────────────────────────────────────────────────────

SIGTERM_THRESHOLD=25   # Kill Chrome with SIGTERM when MemAvailable < 25% (~1.6 GB)
SIGKILL_THRESHOLD=15   # Escalate to SIGKILL when MemAvailable < 15% (~945 MB)
PSI_THRESHOLD=25       # Kill on sustained memory stall: PSI full avg10 > 25%
INTERVAL=2             # Seconds between checks (was 4 — confirmed too slow in crash of 2026-03-05)
OOM_VSCODE_ADJ=0       # oom_score_adj for VS Code: lowers Electron's default 200-300
OOM_CHROME_ADJ=1000    # oom_score_adj for Chrome: maximum killable
# VS Code RSS thresholds (confirmed: extension host hit 4 GB, watchdog had no Chrome to kill)
# Lower thresholds so we can intervene BEFORE the kernel OOM fires.
VSCODE_RSS_EMERG_KB=3500000   # ~3.5 GB — SIGKILL chrome; if no chrome, SIGTERM extension host
VSCODE_RSS_WARN_KB=2500000    # ~2.5 GB — SIGTERM chrome + desktop alert to restart ext host
NOTIFY_INTERVAL=300           # seconds between desktop notifications per severity

# ── Startup mode — faster polling + tighter thresholds for 90s after VS Code starts ──
# Root cause of 2026-03-06 crash: extension host went 0→4.7 GB in <2s during startup.
# Fix: detect new VS Code PIDs, switch to 0.5s interval, drop emergency threshold to 2 GB.
STARTUP_INTERVAL=0.5          # seconds between checks during VS Code startup
STARTUP_DURATION=90           # seconds to stay in startup mode after new VS Code PIDs
STARTUP_RSS_WARN_KB=3500000   # ~3.5 GB — warn threshold in startup mode (matches steady-state; startup peaks are normal)
STARTUP_RSS_EMERG_KB=4200000  # ~4.2 GB — emergency threshold in startup mode (only intervene if truly about to OOM)
STARTUP_DEBOUNCE=300          # minimum seconds between startup mode activations
                              # VS Code language servers (TS, ESLint, GitLens workers) spawn
                              # new code PIDs throughout normal development. Without this guard
                              # the daemon triggered startup mode 567 times in a single day,
                              # keeping it at 0.5 s polling continuously.

# Repeated startup PID churn (extension-host respawn loops) can precede OOM even
# before emergency thresholds are crossed. If churn is high and RSS is already
# elevated, proactively restart the heaviest helper process to avoid full window crash.
STARTUP_BURST_WINDOW=120       # seconds in startup-churn detection window
STARTUP_BURST_COUNT=10         # total new VS Code PIDs in window to flag burst danger
STARTUP_BURST_RSS_KB=1600000   # only act if VS Code RSS is already above ~1.6 GB
HELPER_KILL_COOLDOWN=20        # min seconds between helper restarts
STATUS_INTERVAL=60            # seconds between watchdog status snapshots in journal

# ── User config override — written by the VS Code extension ────────────────────
# If the Mem Watchdog VS Code extension is installed and has custom thresholds
# configured via VS Code Settings, it writes them to this file. Sourcing it here
# overrides the defaults above. Runtime state variables (_startup_*) are set
# below and cannot be overridden via config.
# Config path respects XDG_CONFIG_HOME if set (default: ~/.config).
_WATCHDOG_CFG="${XDG_CONFIG_HOME:-${HOME}/.config}/mem-watchdog/config.sh"
# shellcheck source=/dev/null
[[ -f "$_WATCHDOG_CFG" ]] && source "$_WATCHDOG_CFG"
unset _WATCHDOG_CFG

# ── Startup mode state ───────────────────────────────────────────────────────
_startup_mode_end=0           # epoch seconds until startup mode expires
_startup_just_triggered=false # true for one iteration — skip sleep for instant re-check
_known_code_pids=""           # space-separated sorted PIDs from previous iteration
_last_startup_trigger=0       # epoch seconds of last activation (debounce state)
_startup_burst_window_start=0 # epoch seconds for startup-churn window
_startup_burst_count=0        # accumulated new VS Code PIDs in churn window
_startup_burst_danger=false   # set when churn threshold reached; acted on in main loop
_last_helper_kill=0           # epoch seconds of last helper restart
_last_status_log=0            # epoch seconds of last periodic status snapshot

# ── Runtime counters / observability ─────────────────────────────────────────
_loops=0
_startup_mode_triggers=0
_startup_debounce_skips=0
_startup_burst_events=0
_browser_term_actions=0
_browser_kill_actions=0
_browser_noop_actions=0
_helper_restart_attempts=0
_helper_restart_success=0
_helper_restart_cooldown_skips=0
_helper_restart_no_candidate=0
_helper_restart_failures=0
_rss_warn_events=0
_rss_emergency_events=0
_low_mem_term_events=0
_critical_kill_events=0
_psi_events=0

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  local msg
  msg="[watchdog] $*"
  echo "$(date '+%Y-%m-%d %H:%M:%S') ${msg}"
  logger -t mem-watchdog "$*"
}

incr_counter() {
  local name="$1"
  printf -v "$name" '%s' "$(( ${!name:-0} + 1 ))"
}

log_status_snapshot() {
  local reason="$1"
  local now avail total pct rss startup_left chrome_count
  now=$(date +%s)
  avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  total=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  rss=$(ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
  chrome_count=$(pgrep -f '(chrome|chromium)' 2>/dev/null | wc -l)
  pct=0
  if [[ -n "$avail" && -n "$total" && "$total" -gt 0 ]]; then
    pct=$(( avail * 100 / total ))
  fi
  startup_left=0
  if (( now < _startup_mode_end )); then
    startup_left=$(( _startup_mode_end - now ))
  fi
  log "STATUS(${reason}): loops=${_loops} mem_free_pct=${pct} vscode_rss_kb=${rss} chrome_pids=${chrome_count} startup_left_s=${startup_left} startup_triggers=${_startup_mode_triggers} startup_debounce_skips=${_startup_debounce_skips} startup_burst_events=${_startup_burst_events} browser_term=${_browser_term_actions} browser_kill=${_browser_kill_actions} browser_noop=${_browser_noop_actions} helper_attempts=${_helper_restart_attempts} helper_success=${_helper_restart_success} helper_cooldown_skips=${_helper_restart_cooldown_skips} helper_no_candidate=${_helper_restart_no_candidate} helper_failures=${_helper_restart_failures} rss_warn=${_rss_warn_events} rss_emerg=${_rss_emergency_events} low_mem=${_low_mem_term_events} critical_mem=${_critical_kill_events} psi_events=${_psi_events}"
  _last_status_log=$now
}

# ── Desktop notification (notify-send) with per-severity throttle ───────────────
# severity: "warn" (normal urgency) or "crit" (critical urgency)
# Throttled to once per NOTIFY_INTERVAL seconds per severity level.
_last_notify_warn=0
_last_notify_crit=0

notify_desktop() {
  local severity="$1"  # warn | crit
  local title="$2"
  local body="$3"
  local urgency="normal"
  local now
  now=$(date +%s)

  case "$severity" in
    crit)
      urgency="critical"
      (( now - _last_notify_crit < NOTIFY_INTERVAL )) && return 0
      _last_notify_crit=$now ;;
    warn)
      urgency="normal"
      (( now - _last_notify_warn < NOTIFY_INTERVAL )) && return 0
      _last_notify_warn=$now ;;
  esac

  $DRY_RUN && { log "  (dry-run: notify-send [$severity] $title: $body)"; return 0; }

  DISPLAY=:0 \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
    notify-send --urgency="$urgency" --expire-time=10000 "$title" "$body" 2>/dev/null || true
}

# ── Kill Chrome and Playwright processes ─────────────────────────────────────
kill_browsers() {
  local signal="$1"   # TERM or KILL
  local reason="$2"

  if [[ "$signal" == "TERM" ]]; then
    incr_counter _browser_term_actions
  else
    incr_counter _browser_kill_actions
  fi

  log "ACTION(SIG${signal}): ${reason}"

  if $DRY_RUN; then
    log "  (dry-run: would kill chrome/playwright/chromium)"
    return 0
  fi

  local killed=false

  if pkill "-${signal}" -f '(chrome|chromium)' 2>/dev/null; then
    log "  → Chromium SIG${signal} sent"
    killed=true
  fi
  if pkill "-${signal}" -f 'node.*playwright' 2>/dev/null; then
    log "  → Playwright node SIG${signal} sent"
    killed=true
  fi

  if ! $killed; then
    incr_counter _browser_noop_actions
    log "  (no chrome/playwright processes found to kill)"
  fi
}

# ── Restart heaviest VS Code helper (never main window process) ───────────────────
kill_top_vscode_helper() {
  local reason="$1"
  local now
  now=$(date +%s)
  incr_counter _helper_restart_attempts

  if (( now - _last_helper_kill < HELPER_KILL_COOLDOWN )); then
    incr_counter _helper_restart_cooldown_skips
    log "  Helper restart cooldown active (${HELPER_KILL_COOLDOWN}s) — skipping"
    return 1
  fi

  local line pid rss args

  # Preferred: language servers / extension workers launched with --node-ipc.
  line=$(ps -C code -o pid=,rss=,args= 2>/dev/null \
    | awk '
      {
        pid=$1; rss=$2;
        $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
        if (args ~ /^\/usr\/share\/code\/code$/) next;
        if (args ~ /--type=zygote/) next;
        if (args ~ /--type=gpu-process/) next;
        if (args ~ /--node-ipc/ || args ~ /server\.bundle\.js/ || args ~ /tsserver\.js/ || args ~ /eslintServer\.js/) {
          printf "%s %s %s\n", pid, rss, args;
        }
      }
    ' | sort -k2 -rn | head -1)

  # Fallback: any non-main, non-zygote code child.
  if [[ -z "$line" ]]; then
    line=$(ps -C code -o pid=,rss=,args= 2>/dev/null \
      | awk '
        {
          pid=$1; rss=$2;
          $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
          if (args ~ /^\/usr\/share\/code\/code$/) next;
          if (args ~ /--type=zygote/) next;
          if (args ~ /--type=gpu-process/) next;
          printf "%s %s %s\n", pid, rss, args;
        }
      ' | sort -k2 -rn | head -1)
  fi

  [[ -z "$line" ]] && { incr_counter _helper_restart_no_candidate; log "  No VS Code helper candidate found"; return 1; }

  pid=$(echo "$line" | awk '{print $1}')
  rss=$(echo "$line" | awk '{print $2}')
  args=$(echo "$line" | cut -d' ' -f3-)

  log "ACTION(SIGTERM): ${reason} — restarting helper PID ${pid} (rss=${rss} kB): ${args}"
  if $DRY_RUN; then
    log "  (dry-run: would SIGTERM helper PID ${pid})"
    _last_helper_kill=$now
    return 0
  fi

  if kill -TERM "$pid" 2>/dev/null; then
    incr_counter _helper_restart_success
    _last_helper_kill=$now
    return 0
  fi
  incr_counter _helper_restart_failures
  return 1
}

# ── OOM score adjustment ──────────────────────────────────────────────────────
# Called at startup and on every loop.
# Protect VS Code (negative adj → kernel avoids it); condemn Chrome (positive).
# Requires sudo for negative values — this system has NOPASSWD:ALL.
adjust_oom_scores() {
  # Lower VS Code processes from Electron's default adj=200-300 down to 0
  # (No root needed — owner can write non-negative values to own processes)
  for pid in $(ps -C code -o pid= 2>/dev/null); do
    local adj="/proc/$pid/oom_score_adj"
    [[ -w "$adj" ]] || continue
    [[ "$(cat "$adj" 2>/dev/null)" == "$OOM_VSCODE_ADJ" ]] && continue
    # Re-check existence — PID may have died since the -w test (race condition)
    [[ -e "$adj" ]] || continue
    if ( echo "$OOM_VSCODE_ADJ" > "$adj" ) 2>/dev/null; then
      log "  oom_score_adj=${OOM_VSCODE_ADJ} set on VS Code PID ${pid} (was Electron default 200-300)"
    fi
  done

  # Condemn Chrome/Playwright to oom_score_adj=1000 (maximum killable, no root needed)
  for pid in $(pgrep -f '(chrome|chromium)' 2>/dev/null; pgrep -f 'node.*playwright' 2>/dev/null); do
    local adj="/proc/$pid/oom_score_adj"
    [[ -w "$adj" ]] || continue
    [[ "$(cat "$adj" 2>/dev/null)" == "$OOM_CHROME_ADJ" ]] && continue
    # Re-check existence — PID may have died since the -w test (race condition)
    [[ -e "$adj" ]] || continue
    if ( echo "$OOM_CHROME_ADJ" > "$adj" ) 2>/dev/null; then
      log "  oom_score_adj=${OOM_CHROME_ADJ} set on Chrome/Playwright PID ${pid}"
    fi
  done

  # ── Detect new VS Code sessions → trigger startup mode ────────────────────
  local current_pids
  current_pids=$(ps -C code -o pid= 2>/dev/null | sort | tr '\n' ' ')
  if [[ -n "$current_pids" && "$current_pids" != "$_known_code_pids" ]]; then
    local new_count=0
    if [[ -n "$_known_code_pids" ]]; then
      new_count=$(comm -13 \
        <(echo "$_known_code_pids" | tr ' ' '\n' | grep -v '^$' | sort) \
        <(echo "$current_pids"     | tr ' ' '\n' | grep -v '^$' | sort) | wc -l)
    else
      # shellcheck disable=SC2126
      new_count=$(echo "$current_pids" | tr ' ' '\n' | grep -v '^$' | wc -l)
    fi
    if (( new_count > 0 )); then
      local now
      now=$(date +%s)

      # Track startup churn even when debounce blocks startup-mode re-activation.
      if (( _startup_burst_window_start == 0 || now - _startup_burst_window_start > STARTUP_BURST_WINDOW )); then
        _startup_burst_window_start=$now
        _startup_burst_count=0
        _startup_burst_danger=false
      fi
      _startup_burst_count=$(( _startup_burst_count + new_count ))
      if (( _startup_burst_count >= STARTUP_BURST_COUNT )) && ! $_startup_burst_danger; then
        _startup_burst_danger=true
        incr_counter _startup_burst_events
      fi

      # Debounce: only activate startup mode if STARTUP_DEBOUNCE seconds have
      # elapsed since the last trigger. VS Code language servers and extension
      # workers (TypeScript, ESLint, GitLens) spawn new `code` PIDs throughout
      # normal development. Without this guard, startup mode triggered 567 times
      # in a single day, keeping the daemon at 0.5 s polling continuously and
      # sending spurious pre-emptive Chrome SIGTERMs throughout the work session.
      if (( now - _last_startup_trigger >= STARTUP_DEBOUNCE )); then
        incr_counter _startup_mode_triggers
        _last_startup_trigger=$now
        _startup_mode_end=$(( now + STARTUP_DURATION ))
        _startup_just_triggered=true
        log "VS Code startup: ${new_count} new PIDs — startup mode active for ${STARTUP_DURATION}s (${STARTUP_INTERVAL}s interval, ${STARTUP_RSS_EMERG_KB} kB emerg threshold)"
        # Pre-emptively SIGTERM Chrome to free memory before extensions load
        if pgrep -f '(chrome|chromium)' &>/dev/null; then
          log "  Startup mode: pre-emptively SIGTERMing Chrome to free memory"
          kill_browsers "TERM" "VS Code startup: freeing memory before extension load"
        fi
      else
        incr_counter _startup_debounce_skips
      fi
    fi
    _known_code_pids="$current_pids"
  fi
}

# ── Main loop ────────────────────────────────────────────────────────────────
# ── SIGTERM / SIGINT trap ─────────────────────────────────────────────────────
# Without this, systemd's SIGTERM to the main bash process is deferred until
# the foreground `sleep` subprocess finishes (up to 2 s / 0.5 s). The `wait`
# builtin IS interruptible — signals fire immediately when using `sleep & wait`.
# Kills the pending sleep pid (if any) so it doesn't linger as an orphan.
_sleep_pid=''
trap '[[ -n "${_sleep_pid:-}" ]] && kill "$_sleep_pid" 2>/dev/null; log_status_snapshot "stop"; log "Stopping (signal received)"; exit 0' TERM INT

log "Started (SIGTERM ≤${SIGTERM_THRESHOLD}%, SIGKILL ≤${SIGKILL_THRESHOLD}%, PSI >${PSI_THRESHOLD}%, oom_adj code=${OOM_VSCODE_ADJ} chrome=+${OOM_CHROME_ADJ})"
$DRY_RUN && log "DRY-RUN mode — no processes will be killed"

# Apply OOM scores immediately at startup before the first loop iteration
adjust_oom_scores

while true; do
  incr_counter _loops

  # ── Determine effective thresholds and whether we're in startup mode ────────
  local_now=$(date +%s)
  if (( local_now < _startup_mode_end )); then
    in_startup=true
    eff_warn=$STARTUP_RSS_WARN_KB
    eff_emerg=$STARTUP_RSS_EMERG_KB
    eff_interval=$STARTUP_INTERVAL
  else
    in_startup=false
    eff_warn=$VSCODE_RSS_WARN_KB
    eff_emerg=$VSCODE_RSS_EMERG_KB
    eff_interval=$INTERVAL
  fi

  # Re-apply OOM scores every loop — catches newly spawned VS Code/Chrome PIDs
  # (also detects new VS Code sessions and triggers startup mode)
  adjust_oom_scores

  # Read MemAvailable and MemTotal.
  # IMPORTANT: Never use SwapFree — Crostini kernel reports ~18.4 exabytes
  # (uint64 overflow sentinel). Use awk to be safe against whitespace/format.
  avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo)
  total=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo)

  # Guard against empty/malformed reads
  [[ -z "$avail" || -z "$total" || "$total" -eq 0 ]] && continue

  pct=$(( avail * 100 / total ))

  # Read PSI full avg10 — percentage of time ALL tasks stalled waiting for
  # memory in the last 10 seconds. Multiply by 100 for integer comparison.
  # e.g. "full avg10=3.45 ..." → psi_x100=345
  psi_x100=$(awk '/^full[[:space:]]/{
    for(i=1;i<=NF;i++) {
      if($i ~ /^avg10=/) {
        sub("avg10=","",$i)
        printf "%d", $i * 100
        exit
      }
    }
  }' /proc/pressure/memory 2>/dev/null || echo 0)

  # ── VS Code RSS check ─────────────────────────────────────────────────────
  # CONFIRMED CRASH (2026-03-05 13:02:25): extension host PID 778 hit 4 GB
  # RSS with no Chrome running. Watchdog had nothing to kill — VS Code died.
  # Fixes: lower thresholds, 2s interval, SIGTERM ext host as last resort.
  vscode_rss=$(ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
  chrome_running=$(pgrep -f '(chrome|chromium)' 2>/dev/null | head -1)

  # Pre-emergency intervention: startup PID churn burst + elevated RSS.
  if $_startup_burst_danger && (( vscode_rss >= STARTUP_BURST_RSS_KB )); then
    log "BURST: startup PID churn=${_startup_burst_count} in ${STARTUP_BURST_WINDOW}s with VS Code RSS ${vscode_rss} kB — preemptive helper restart"
    notify_desktop "warn" "⚠️ VS Code Startup Churn" \
      "Repeated VS Code helper respawns detected; restarting heaviest helper to prevent crash."
    if kill_top_vscode_helper "startup churn burst (${_startup_burst_count} new PIDs/${STARTUP_BURST_WINDOW}s)"; then
      _startup_burst_danger=false
      _startup_burst_count=0
      _startup_burst_window_start=$(date +%s)
    fi
  fi

  if (( vscode_rss >= eff_emerg )); then
    incr_counter _rss_emergency_events
    log "EMERGENCY: VS Code RSS ${vscode_rss} kB (≥3.5 GB) — attempting to save VS Code window"
    notify_desktop "crit" "🚨 VS Code Memory EMERGENCY" \
      "VS Code RSS: $(( vscode_rss / 1024 )) MB — restarting extension host.\nRun: Developer: Restart Extension Host"
    kill_browsers "KILL" "VS Code RSS emergency: ${vscode_rss} kB"
    if [[ -z "$chrome_running" ]]; then
      # No Chrome to kill — restart helper only (never main VS Code process).
      kill_top_vscode_helper "VS Code RSS emergency: ${vscode_rss} kB"
    fi
  elif (( vscode_rss >= eff_warn )); then
    incr_counter _rss_warn_events
    log "WARNING: VS Code RSS ${vscode_rss} kB (≥2.5 GB) — SIGTERMing Chrome, restart ext host soon"
    notify_desktop "warn" "⚠️ VS Code Memory High" \
      "VS Code RSS: $(( vscode_rss / 1024 )) MB — terminating Chrome.\nConsider: Developer: Restart Extension Host"
    kill_browsers "TERM" "VS Code RSS high: ${vscode_rss} kB"
  fi

  # Escalate: SIGKILL at critical threshold
  if (( pct <= SIGKILL_THRESHOLD )); then
    incr_counter _critical_kill_events
    notify_desktop "crit" "🚨 Critical Memory: ${pct}% free" \
      "Force-killing Chrome/Playwright.\nClose ChromeOS tabs if crash persists."
    kill_browsers "KILL" "CRITICAL: ${pct}% MemAvailable (${avail} kB)"

  # Intervene: SIGTERM at low-memory threshold
  elif (( pct <= SIGTERM_THRESHOLD )); then
    incr_counter _low_mem_term_events
    notify_desktop "warn" "⚠️ Low Memory: ${pct}% free" \
      "Terminating Chrome/Playwright to protect VS Code."
    kill_browsers "TERM" "LOW: ${pct}% MemAvailable (${avail} kB)"

  # Intervene: SIGTERM on sustained PSI pressure spike
  elif (( psi_x100 >= PSI_THRESHOLD * 100 )); then
    incr_counter _psi_events
    notify_desktop "warn" "⚠️ Memory Stall Detected" \
      "PSI full avg10=$(( psi_x100 / 100 ))% — terminating Chrome/Playwright."
    kill_browsers "TERM" "PSI stall: ${psi_x100}x (${pct}% RAM free)"
  fi

  if (( local_now - _last_status_log >= STATUS_INTERVAL )); then
    log_status_snapshot "periodic"
  fi

  # ── Adaptive sleep ───────────────────────────────────────────────────────
  # Skip sleep on the first iteration after startup trigger (immediate re-check).
  # Use STARTUP_INTERVAL (0.5s) during startup mode, INTERVAL (2s) otherwise.
  # `sleep & wait $!` makes the sleep interruptible: bash processes signals
  # immediately during `wait` (a builtin), whereas a foreground `sleep` defers
  # traps until the subprocess exits — causing up to 2 s shutdown delay.
  if $in_startup && $_startup_just_triggered; then
    _startup_just_triggered=false
    # No sleep — re-check immediately after detecting new VS Code PIDs
  else
    sleep "$eff_interval" & _sleep_pid=$!
    wait "$_sleep_pid" || true
  fi
done
