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
#   - 4-stage graduated pressure response (Issue #4):
#     Stage 1 (Monitor):   PSI some > 1% OR MemAvail < 35% → log + raise Chrome oom_score_adj
#     Stage 2 (Throttle):  PSI some > 3% OR MemAvail < 30% → cgroup soft_limit + SIGTERM Chrome
#     Stage 3 (Reclaim):   PSI full > 2% OR MemAvail < 25% → cgroup force_empty + SIGTERM Chrome + helpers
#     Stage 4 (Terminate): PSI full > 5% OR MemAvail < 15% → SIGKILL Chrome; VS Code recovery if needed
#   - VS Code RSS warning at 2.2 GB: SIGTERM Chrome + desktop alert + journal.
#   - VS Code RSS emergency at 3.2 GB: SIGKILL Chrome; if no Chrome, SIGTERM
#     the highest-RSS `code` process (extension host) to save the VS Code window.
#   - Sets oom_score_adj=0 on VS Code (lowers Electron's default 200-300).
#   - Sets oom_score_adj=+1000 on Chrome (kernel kills it first).
#   - Checks every 2 seconds (was 4s — confirmed too slow to catch rapid spike).
#   - STARTUP MODE: switches to 0.5s checks for 90s when new VS Code PIDs detected.
#   - STARTUP MODE: proactively SIGTERMs Chrome the moment VS Code starts loading.
#   - STARTUP MODE: uses 2.0 GB emergency threshold (vs 3.2 GB normal).
#   - Sends desktop notifications (notify-send) throttled to once per 5 min.
#   - Logs all actions via systemd journal (logger -t mem-watchdog).
#
# USAGE:
#   As a service:  systemctl --user start mem-watchdog  (see mem-watchdog.service)
#   Manual test:   ./scripts/mem-watchdog.sh --dry-run
# ─────────────────────────────────────────────────────────────────────────────

# ── 4-stage pressure response model (Issue #4) ────────────────────────────────
# Replaces binary kill-or-wait with graduated response.
# PSI thresholds calibrated for Crostini (Issue #14): no-swap means PSI
# stays near 0% until OOM. See docs/technical/psi-calibration.md.
# cgroup v1: memory.soft_limit_in_bytes (throttle), memory.force_empty (reclaim).
#
# Stage 1 — Monitor: log + raise Chrome oom_score_adj
STAGE1_PSI_SOME_X100=100       # PSI some avg10 > 1.00%
STAGE1_MEM_PCT=35              # OR MemAvailable < 35%
#
# Stage 2 — Throttle: write memory.soft_limit_in_bytes + SIGTERM Chrome
STAGE2_PSI_SOME_X100=300       # PSI some avg10 > 3.00%
STAGE2_MEM_PCT=30              # OR MemAvailable < 30%
STAGE2_SOFT_LIMIT_PCT=80       # soft_limit = 80% of MemTotal (creates reclaim pressure)
#
# Stage 3 — Reclaim: write memory.force_empty + SIGTERM Chrome + helpers
STAGE3_PSI_FULL_X100=200       # PSI full avg10 > 2.00%
STAGE3_MEM_PCT=25              # OR MemAvailable < 25%
#
# Stage 4 — Terminate: SIGKILL Chrome + VS Code recovery if needed
STAGE4_PSI_FULL_X100=500       # PSI full avg10 > 5.00%
STAGE4_MEM_PCT=15              # OR MemAvailable < 15%

# Backward-compatible names — NOT used directly in the daemon.
# configWriter.js (v0.3.x) writes these to ~/.config/mem-watchdog/config.sh.
# After config sourcing below, they are mapped to stage constants.
INTERVAL=2             # Seconds between checks (was 4 — confirmed too slow in crash of 2026-03-05)
export WATCHDOG_VERSION=20260325.6   # 2026-03-25 v6: process classification tiers (#6)     # Bump on behavioral changes; used by extension installer to prevent downgrades
OOM_VSCODE_ADJ=0       # oom_score_adj for VS Code: lowers Electron's default 200-300
OOM_CHROME_ADJ=1000    # oom_score_adj for Chrome: maximum killable

# ── Process classification tiers (Issue #6) ──────────────────────────────────
# Three tiers classify processes for oom_score_adj and kill-eligibility decisions.
# Override patterns in ~/.config/mem-watchdog/config.sh to add custom processes.
#
# PROTECTED: VS Code core processes
#   Matched by: ps -C $TIER_PROTECTED_PNAME (process name match)
#   oom_score_adj: OOM_VSCODE_ADJ (0) — non-negative; no root needed
#   Kill policy: never automatic; circuit-breaker only (kill_vscode_main at Stage 4)
#
# DISPOSABLE: browser and automation processes
#   Matched by: pgrep -f $TIER_DISPOSABLE_PATTERN / $TIER_DISPOSABLE_PATTERN_AUX
#   oom_score_adj: OOM_CHROME_ADJ (1000) — maximum kernel OOM priority
#   Kill policy: Stage 2+ (Throttle and above)
#
# MONITORED: all other user processes (not actively managed by the watchdog)
#   oom_score_adj: not modified; kill eligibility: not targeted
#
# Sub-tier refinement within protected (kill_top_vscode_helper):
#   Extension Host: --inspect-port flag → excluded from helper kills entirely
#   Language servers: protected at WARN severity, killable at EMERG only
#   Other helpers (renderer, IPC): killable at WARN as expendable candidates
TIER_PROTECTED_PNAME='code'                       # ps -C process name for protected tier
TIER_DISPOSABLE_PATTERN='(chrome|chromium)'        # pgrep -f ERE for disposable browsers
TIER_DISPOSABLE_PATTERN_AUX='node.*playwright'     # pgrep -f ERE for disposable automation

# VS Code RSS thresholds (confirmed: extension host hit 4 GB, watchdog had no Chrome to kill)
# Lower thresholds so we can intervene BEFORE the kernel OOM fires.
VSCODE_RSS_EMERG_KB=3200000   # ~3.2 GB — emergency cutoff before kernel OOM territory
VSCODE_RSS_WARN_KB=2200000    # ~2.2 GB — earlier warning for constrained Crostini RAM
NOTIFY_INTERVAL=300           # seconds between desktop notifications per severity

# ── Startup mode — faster polling + tighter thresholds for 90s after VS Code starts ──
# Root cause of 2026-03-06 crash: extension host went 0→4.7 GB in <2s during startup.
# Fix: detect new VS Code PIDs, switch to 0.5s interval, drop emergency threshold to 2 GB.
STARTUP_INTERVAL=0.5          # seconds between checks during VS Code startup
STARTUP_DURATION=90           # seconds to stay in startup mode after new VS Code PIDs
STARTUP_RSS_WARN_KB=2800000   # ~2.8 GB — startup can spike fast; intervene earlier
STARTUP_RSS_EMERG_KB=3400000  # ~3.4 GB — emergency ceiling in startup mode
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
STARTUP_BURST_RSS_KB=2200000   # only act if VS Code RSS is already above ~2.2 GB
                              # Changed from 1.6 GB (2026-03-25): 1.6 GB is normal
                              # VS Code steady state on this system. The burst kill
                              # at 1641544 kB (89% free memory) killed the Extension
                              # Host unnecessarily during post-crash recovery.
HELPER_KILL_COOLDOWN=10        # min seconds between helper restarts (was 20; WARN branch fires
                              # after every EMERGENCY kill so 20s left it blocked for 15s)
HELPER_KILL_COOLDOWN_EMERG=5   # short cooldown used during EMERGENCY (no Chrome, RSS runaway)
                              # 2026-03-13 crash: 20s cooldown blocked all re-attempts while RSS
                              # grew 3.8→6.0 GB in 20s — kernel OOM fired before cooldown expired.
ANTI_RESPAWN_WINDOW=30         # seconds to skip a process type after killing it
                              # 2026-03-13: tsserver killed → immediately respawned → killed again
                              # in a tight loop. Skipping the same type forces a different target.
# EXT_HOST_ESCALATION_COUNT — superseded by RSS_RUNAWAY_STREAK circuit-breaker in kill_vscode_main
EXT_HOST_ESCALATION_WINDOW=60  # seconds window for escalation kill count   # short cooldown used during EMERGENCY (no Chrome, RSS runaway)
                              # 2026-03-13 crash: 20s cooldown blocked all re-attempts while RSS
                              # grew 3.8→6.0 GB in 20s — kernel OOM fired before cooldown expired.
STATUS_INTERVAL=60            # seconds between watchdog status snapshots in journal

# ── Intervention safety gates — prevent action thrash under spike storms ──
ACTION_BUDGET_WINDOW=30       # seconds in intervention budget window
ACTION_BUDGET_MAX=6           # max non-critical actions per window
CODE_RECOVERY_COOLDOWN=30     # minimum seconds between controlled VS Code recovery actions
RSS_ACCEL_KB=300000           # acceleration threshold (~300 MB per cycle)
RSS_RUNAWAY_MIN_KB=2600000    # only track runaway streak above this RSS floor
RSS_RUNAWAY_STREAK=3          # consecutive accel cycles before circuit-breaker recovery

# ── Restart-loop detection — VS Code crash-restart guard (Issue #25) ──────
# If VS Code restarts > RESTART_LOOP_THRESHOLD times in RESTART_LOOP_WINDOW_S
# seconds, escalate to SIGKILL Chrome and suppress further Chrome kills for
# RESTART_LOOP_COOLDOWN_S seconds. Discovered 2026-03-10: 30+ restarts drove
# Crostini VM termination. The SIGTERM-on-startup loop must break.
RESTART_LOOP_WINDOW_S=600       # 10-minute sliding window for restart counting
RESTART_LOOP_THRESHOLD=5        # VS Code startup events in window → declare restart loop
RESTART_LOOP_COOLDOWN_S=120     # suppress further Chrome kills for this many seconds

# ── Kill cooldown and hysteresis (Issue #5) ───────────────────────────────
# After ANY successful kill action, suppress non-critical re-evaluation for
# KILL_COOLDOWN seconds. This prevents kill-loops where freed memory hasn't
# propagated to MemAvailable within the next poll. EMERGENCY (≥eff_emerg) and
# SIGKILL (≤SIGKILL_THRESHOLD) paths bypass this — they are critical.
KILL_COOLDOWN=15                # seconds to skip non-critical kill evaluation after any action
HYSTERESIS_POLLS=3              # consecutive polls above threshold before non-critical action
                                # at 2s interval = 6s sustained pressure before acting
RECOVERY_POLLS=5                # consecutive clean polls to confirm recovery (10s at 2s)
RECOVERY_PSI_X100=100           # PSI some avg10 < 1.00% to count as clean (below Stage 1)
RECOVERY_MEM_PCT=40             # MemAvailable > 40% to count as clean (above Stage 1)

# ── Chrome process count cap — accumulation guard (Issue #26) ─────────────
# Discovered 2026-03-10: 12+ Chrome scopes accumulated over 3.5 hours.
# SIGTERM-on-startup only clears Chrome at restart moments, not between them.
CHROME_COUNT_MAX=3              # SIGKILL oldest Chrome/Chromium processes above this cap

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

# ── Backward-compatible config mapping (Issue #4 transition) ─────────────
# configWriter.js (v0.3.x) writes SIGTERM_THRESHOLD, SIGKILL_THRESHOLD,
# PSI_THRESHOLD to the config file. Map them to stage constants so existing
# user configs continue to work until the extension learns the new names.
# shellcheck disable=SC2154
[[ -v SIGTERM_THRESHOLD ]] && STAGE3_MEM_PCT=$SIGTERM_THRESHOLD
# shellcheck disable=SC2154
[[ -v SIGKILL_THRESHOLD ]] && STAGE4_MEM_PCT=$SIGKILL_THRESHOLD
# shellcheck disable=SC2154
[[ -v PSI_THRESHOLD ]] && STAGE4_PSI_FULL_X100=$(( PSI_THRESHOLD * 100 ))

# ── Startup mode state ───────────────────────────────────────────────────────
_startup_mode_end=0           # epoch seconds until startup mode expires
_startup_just_triggered=false # true for one iteration — skip sleep for instant re-check
_known_code_pids=""           # space-separated sorted PIDs from previous iteration
_last_startup_trigger=0       # epoch seconds of last activation (debounce state)
_startup_burst_window_start=0 # epoch seconds for startup-churn window
_startup_burst_count=0        # accumulated new VS Code PIDs in churn window
_startup_burst_danger=false   # set when churn threshold reached; acted on in main loop
_last_helper_kill=0           # epoch seconds of last helper restart
_last_killed_type=""          # process type tag of last helper kill (anti-respawn)
_last_killed_type_time=0      # epoch seconds of last kill of that type
_helper_kills_in_window=0     # count of helper kills within EXT_HOST_ESCALATION_WINDOW
_helper_kills_window_start=0  # epoch seconds when escalation window opened
_ext_host_escalation_events=0 # count of extension-host escalation kills
_last_status_log=0            # epoch seconds of last periodic status snapshot
_restart_timestamps=""        # space-separated epoch seconds of recent VS Code restart events
_restart_loop_cooldown_end=0  # epoch seconds until restart-loop cooldown expires

# ── Cooldown / hysteresis / recovery state (Issue #5) ────────────────────
_last_kill_action_time=0        # epoch seconds of last successful kill of any type
_hyst_warn_count=0              # consecutive polls with vscode_rss >= eff_warn
_hyst_lowmem_count=0            # consecutive polls with pct <= SIGTERM_THRESHOLD
_hyst_psi_count=0               # consecutive polls with psi_x100 >= PSI_THRESHOLD*100
_recovery_clean_count=0         # consecutive clean polls (no pressure condition true)
_pressure_active=false          # true when any non-critical intervention fired

# ── 4-stage pressure state (Issue #4) ─────────────────────────────────────
_pressure_stage=0               # 0=normal, 1=monitor, 2=throttle, 3=reclaim, 4=terminate
_stage_entry_time=0             # epoch seconds when current stage was entered
_stage_hyst_count=0             # consecutive polls at candidate (higher) stage
_cgroup_mem_path=""             # populated at startup; empty = cgroup writes disabled
_soft_limit_active=false        # true when we've lowered memory.soft_limit_in_bytes
_stage_transitions=0            # total stage transitions for observability

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
_rss_accel_events=0
_ext_host_escalation_events=0
_prev_vscode_rss=0
_prev_rss_time=0
_low_mem_term_events=0
_critical_kill_events=0
_psi_events=0
_restart_loop_events=0
_chrome_excess_events=0
_code_recovery_events=0
_cooldown_skips=0
_hysteresis_skips=0
_recovery_confirmations=0
_action_budget_window_start=0
_action_budget_count=0
_action_taken=false
_last_code_recovery=0
_runaway_streak=0

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
  rss=$(ps -C "$TIER_PROTECTED_PNAME" -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
  chrome_count=$(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | wc -l)
  pct=0
  if [[ -n "$avail" && -n "$total" && "$total" -gt 0 ]]; then
    pct=$(( avail * 100 / total ))
  fi
  startup_left=0
  if (( now < _startup_mode_end )); then
    startup_left=$(( _startup_mode_end - now ))
  fi
  log "STATUS(${reason}): loops=${_loops} mem_free_pct=${pct} vscode_rss_kb=${rss} chrome_pids=${chrome_count} pressure_stage=${_pressure_stage} stage_transitions=${_stage_transitions} soft_limit_active=${_soft_limit_active} startup_left_s=${startup_left} startup_triggers=${_startup_mode_triggers} startup_debounce_skips=${_startup_debounce_skips} startup_burst_events=${_startup_burst_events} restart_loop_events=${_restart_loop_events} restart_loop_cooldown_remaining=$(( _restart_loop_cooldown_end > $(date +%s) ? _restart_loop_cooldown_end - $(date +%s) : 0 )) chrome_excess_events=${_chrome_excess_events} browser_term=${_browser_term_actions} browser_kill=${_browser_kill_actions} browser_noop=${_browser_noop_actions} helper_attempts=${_helper_restart_attempts} helper_success=${_helper_restart_success} helper_cooldown_skips=${_helper_restart_cooldown_skips} helper_no_candidate=${_helper_restart_no_candidate} helper_failures=${_helper_restart_failures} rss_warn=${_rss_warn_events} rss_emerg=${_rss_emergency_events} rss_accel=${_rss_accel_events} rss_runaway_streak=${_runaway_streak} code_recoveries=${_code_recovery_events} exthost_escal=${_ext_host_escalation_events} anti_respawn_type=${_last_killed_type} helper_kills_window=${_helper_kills_in_window} action_budget_used=${_action_budget_count} cooldown_skips=${_cooldown_skips} hyst_skips=${_hysteresis_skips} recovery_confirms=${_recovery_confirmations} hyst_warn=${_hyst_warn_count} low_mem=${_low_mem_term_events} critical_mem=${_critical_kill_events} psi_events=${_psi_events}"
  _last_status_log=$now
}

action_budget_allows() {
  local mode="${1:-normal}" # normal|critical
  local now
  now=$(date +%s)

  if $_action_taken; then
    log "  Action gate: already executed an intervention this loop — skipping"
    return 1
  fi

  if (( _action_budget_window_start == 0 || now - _action_budget_window_start > ACTION_BUDGET_WINDOW )); then
    _action_budget_window_start=$now
    _action_budget_count=0
  fi

  if [[ "$mode" != "critical" ]] && (( _action_budget_count >= ACTION_BUDGET_MAX )); then
    log "  Action budget active: ${_action_budget_count}/${ACTION_BUDGET_MAX} actions in ${ACTION_BUDGET_WINDOW}s — skipping non-critical action"
    return 1
  fi

  return 0
}

record_action() {
  _action_taken=true
  _action_budget_count=$(( _action_budget_count + 1 ))
  _last_kill_action_time=$(date +%s)
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

# ── Kill extension host (Copilot Chat container) — escalation of last resort ──
# Called when repeated helper kills (EXT_HOST_ESCALATION_COUNT in EXT_HOST_ESCALATION_WINDOW)
# have not reduced RSS below the emergency threshold. The extension host carries
# Copilot Chat (~700 MB). Killing it forces a full extension host restart.
kill_extension_host() {
  local reason="$1"
  action_budget_allows "normal" || return 1
  incr_counter _ext_host_escalation_events
  local exthost_pid
  # VS Code 1.90+: Extension Host runs as --type=utility with --inspect-port.
  # --inspect-port is present on exactly one utility process (the Extension Host).
  exthost_pid=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,args= 2>/dev/null \
    | awk '$0 ~ /--type=utility/ && $0 ~ /--inspect-port/ {print $1; exit}')
  # Fallback: legacy VS Code uses --type=extensionHost
  if [[ -z "$exthost_pid" ]]; then
    exthost_pid=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,args= 2>/dev/null \
      | awk '$0 ~ /--type=extensionHost/ {print $1; exit}')
  fi
  if [[ -z "$exthost_pid" ]]; then
    log "  ESCALATION: no extensionHost process found"
    return 1
  fi
  local rss
  rss=$(awk '/^VmRSS:/{print $2; exit}' /proc/"$exthost_pid"/status 2>/dev/null)
  record_action
  log "ESCALATION(SIGTERM): ${reason} — killing extensionHost PID ${exthost_pid} (rss=${rss} kB)"
  log "  Copilot Chat extension host will restart. Run: Developer: Restart Extension Host"
  notify_desktop "crit" "🚨 Extension Host Killed" \
    "Repeated helper kills failed to reduce RSS. Extension host (Copilot Chat) restarted.\nRun: Developer: Restart Extension Host"
  $DRY_RUN && { log "  (dry-run: would SIGTERM extensionHost PID ${exthost_pid})"; return 0; }
  kill -TERM "$exthost_pid" 2>/dev/null
  _helper_kills_in_window=0
  _helper_kills_window_start=$(date +%s)
}

kill_vscode_main() {
  local reason="$1"
  local mode="${2:-critical}" # normal|critical
  local now
  now=$(date +%s)

  action_budget_allows "$mode" || return 1
  if (( now - _last_code_recovery < CODE_RECOVERY_COOLDOWN )); then
    log "  VS Code recovery cooldown active (${CODE_RECOVERY_COOLDOWN}s) — skipping"
    return 1
  fi

  local pid rss
  pid=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,args= 2>/dev/null | awk '$0 ~ /\/usr\/share\/code\/code$/ {print $1; exit}')
  if [[ -z "$pid" ]]; then
    pid=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,rss= 2>/dev/null | sort -k2 -rn | awk 'NR==1{print $1}')
  fi
  [[ -z "$pid" ]] && { log "  VS Code recovery: no code PID found"; return 1; }

  rss=$(awk '/^VmRSS:/{print $2; exit}' /proc/"$pid"/status 2>/dev/null)
  record_action
  incr_counter _code_recovery_events
  _last_code_recovery=$now
  log "RECOVERY(SIGTERM): ${reason} — restarting VS Code main PID ${pid} (rss=${rss} kB)"
  notify_desktop "crit" "🚨 VS Code Recovery Triggered" \
    "Runaway memory detected. Restarting VS Code to prevent kernel OOM."

  $DRY_RUN && { log "  (dry-run: would SIGTERM VS Code PID ${pid})"; return 0; }
  kill -TERM "$pid" 2>/dev/null
}

# ── Kill Chrome and Playwright processes ─────────────────────────────────────
kill_browsers() {
  local signal="$1"   # TERM or KILL
  local reason="$2"
  local mode="${3:-normal}" # normal|critical

  action_budget_allows "$mode" || return 1

  if [[ "$signal" == "TERM" ]]; then
    incr_counter _browser_term_actions
  else
    incr_counter _browser_kill_actions
  fi

  log "ACTION(SIG${signal}): ${reason}"

  if $DRY_RUN; then
    record_action
    log "  (dry-run: would kill chrome/playwright/chromium)"
    return 0
  fi

  local killed=false

  if pkill "-${signal}" -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null; then
    log "  → Chromium SIG${signal} sent"
    killed=true
  fi
  if pkill "-${signal}" -f "$TIER_DISPOSABLE_PATTERN_AUX" 2>/dev/null; then
    log "  → Playwright node SIG${signal} sent"
    killed=true
  fi

  if ! $killed; then
    incr_counter _browser_noop_actions
    log "  (no chrome/playwright processes found to kill)"
    # Do NOT record_action — no-op kills must not consume the action budget
    # or block fallback interventions (kill_top_vscode_helper, kill_extension_host).
    # Crash 2026-03-25: action budget exhausted by 6 no-op kill_browsers calls in 3s,
    # blocking all real interventions while RSS grew from 2.8→3.5 GB unimpeded.
    return 1
  fi

  record_action
  return 0
}

# ── Restart heaviest VS Code helper (never main window process) ───────────────────
kill_top_vscode_helper() {
  local reason="$1"
  # use_emerg_cooldown: pass "emerg" to use the shorter HELPER_KILL_COOLDOWN_EMERG (5s)
  local mode="${2:-normal}"
  local cooldown=$HELPER_KILL_COOLDOWN
  [[ "$mode" == "emerg" ]] && cooldown=$HELPER_KILL_COOLDOWN_EMERG
  # Language server protection: critical servers must not be killed at WARN severity.
  # Crashes documented:
  #   2026-03-24 crash #1: tsserver (104 MB) only candidate at WARN -> killed -> session crash
  #   2026-03-24 crash #2: old watchdog (not deployed) killed tsserver; markdown/html
  #                        servers crashed 5x each in OOM cascade.
  # Only allow these as kill targets at "emerg" severity (true emergency).
  local protect_tsserver=true
  local protect_langservers=true   # htmlServerMain, serverWorkerMain (markdown), cssServerMain, jsonServerMain, eslintServer
  [[ "$mode" == "emerg" ]] && protect_tsserver=false
  [[ "$mode" == "emerg" ]] && protect_langservers=false
  local now
  now=$(date +%s)
  action_budget_allows "normal" || return 1
  incr_counter _helper_restart_attempts

  if (( now - _last_helper_kill < cooldown )); then
    incr_counter _helper_restart_cooldown_skips
    log "  Helper restart cooldown active (${cooldown}s) — skipping"
    return 1
  fi

  local line pid rss args candidate_type

  # ── Build candidate list: language servers / extension workers first ─────
  # Anti-respawn: classify a process type tag from its cmdline, then skip the
  # last-killed type if it was killed within ANTI_RESPAWN_WINDOW seconds.
  # This prevents the tsserver kill → respawn → kill tight loop that caused the
  # 2026-03-13 crash (2081 cooldown skips / 488 successes; 4:1 block ratio).
  _classify_helper_type() {
    local a="$1"
    if   [[ "$a" == *"tsserver.js"* ]];          then echo "tsserver"
    elif [[ "$a" == *"htmlServerMain"* ]];        then echo "html-server"
    elif [[ "$a" == *"serverWorkerMain"* ]];      then echo "markdown-server"
    elif [[ "$a" == *"cssServerMain"* ]];         then echo "css-server"
    elif [[ "$a" == *"eslintServer.js"* ]];       then echo "eslint"
    elif [[ "$a" == *"jsonServerMain"* ]];        then echo "json-server"
    elif [[ "$a" == *"server.bundle.js"* ]];      then echo "server-bundle"
    elif [[ "$a" == *"--node-ipc"* ]];            then echo "node-ipc"
    elif [[ "$a" == *"--type=renderer"* ]];       then echo "renderer"
    else                                               echo "other"
    fi
  }

  local now_inner
  now_inner=$(date +%s)
  local skip_type=""
  if [[ -n "$_last_killed_type" ]] && (( now_inner - _last_killed_type_time < ANTI_RESPAWN_WINDOW )); then
    skip_type="$_last_killed_type"
  fi

  # Preferred: language servers / extension workers, excluding recently-killed type
  line=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,rss=,args= 2>/dev/null \
    | awk -v skip="$skip_type" -v prot="$protect_tsserver" -v ls="$protect_langservers" '
      function classify(a) {
        if (a ~ /tsserver\.js/)        return "tsserver"
        if (a ~ /htmlServerMain/)       return "html-server"
        if (a ~ /serverWorkerMain/)     return "markdown-server"
        if (a ~ /cssServerMain/)        return "css-server"
        if (a ~ /eslintServer\.js/)    return "eslint"
        if (a ~ /jsonServerMain/)       return "json-server"
        if (a ~ /server\.bundle\.js/) return "server-bundle"
        if (a ~ /--node-ipc/)           return "node-ipc"
        return "other"
      }
      {
        pid=$1; rss=$2;
        $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
        if (args ~ /^\/usr\/share\/code\/code$/) next;
        if (args ~ /--type=zygote/) next;
        if (args ~ /--type=gpu-process/) next;
        if (args ~ /--type=extensionHost/) next;
        if (args ~ /--type=utility/ && args ~ /--inspect-port/) next;
        t=classify(args)
        if (skip != "" && t == skip) next;
        if (prot == "true" && t == "tsserver") next;
        if (ls == "true" && (t == "html-server" || t == "markdown-server" || t == "css-server" || t == "json-server" || t == "eslint")) next;
        if (args ~ /--node-ipc/ || args ~ /server\.bundle\.js/ || (args ~ /tsserver\.js/ && prot != "true") || (args ~ /eslintServer\.js/ && ls != "true") || (args ~ /jsonServerMain/ && ls != "true")) {
          printf "%s %s %s\n", pid, rss, args;
        }
      }
    ' | sort -k2 -rn | head -1)

  # Fallback: any non-main, non-zygote, non-extensionHost child
  if [[ -z "$line" ]]; then
    line=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,rss=,args= 2>/dev/null \
      | awk -v skip="$skip_type" -v prot="$protect_tsserver" -v ls="$protect_langservers" '
        function classify(a) {
          if (a ~ /tsserver\.js/)      return "tsserver"
          if (a ~ /eslintServer\.js/)  return "eslint"
          if (a ~ /jsonServerMain/)     return "json-server"
          if (a ~ /server\.bundle\.js/) return "server-bundle"
          if (a ~ /--node-ipc/)         return "node-ipc"
          return "other"
        }
        {
          pid=$1; rss=$2;
          $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
          if (args ~ /^\/usr\/share\/code\/code$/) next;
          if (args ~ /--type=zygote/) next;
          if (args ~ /--type=gpu-process/) next;
          if (args ~ /--type=extensionHost/) next;
          if (args ~ /--type=utility/ && args ~ /--inspect-port/) next;
          t=classify(args)
          if (skip != "" && t == skip) next;
          if (prot == "true" && t == "tsserver") next;
          if (ls == "true" && (t == "html-server" || t == "markdown-server" || t == "css-server" || t == "json-server" || t == "eslint")) next;
          printf "%s %s %s\n", pid, rss, args;
        }
      ' | sort -k2 -rn | head -1)
  fi

  # Last-resort fallback: include recently-killed type if nothing else found
  if [[ -z "$line" ]]; then
    line=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,rss=,args= 2>/dev/null \
      | awk -v prot="$protect_tsserver" -v ls="$protect_langservers" '{
          pid=$1; rss=$2;
          $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
          if (args ~ /^\/usr\/share\/code\/code$/) next;
          if (args ~ /--type=zygote/) next;
          if (args ~ /--type=gpu-process/) next;
          if (args ~ /--type=extensionHost/) next;
          if (args ~ /--type=utility/ && args ~ /--inspect-port/) next;
          if (prot == "true" && args ~ /tsserver\.js/) next;
          if (ls == "true" && (args ~ /htmlServerMain/ || args ~ /serverWorkerMain/ || args ~ /cssServerMain/ || args ~ /jsonServerMain/ || args ~ /eslintServer/)) next;
          printf "%s %s %s\n", pid, rss, args;
        }' | sort -k2 -rn | head -1)
    [[ -n "$line" ]] && log "  Anti-respawn: no alternative found — re-using last-killed type"
  fi

  [[ -z "$line" ]] && { incr_counter _helper_restart_no_candidate; log "  No VS Code helper candidate found"; return 1; }

  pid=$(echo "$line" | awk '{print $1}')
  rss=$(echo "$line" | awk '{print $2}')
  args=$(echo "$line" | cut -d' ' -f3-)
  candidate_type=$(_classify_helper_type "$args")

  record_action
  log "ACTION(SIGTERM): ${reason} — restarting helper PID ${pid} (rss=${rss} kB): ${args}"
  if $DRY_RUN; then
    log "  (dry-run: would SIGTERM helper PID ${pid})"
    _last_helper_kill=$now
    return 0
  fi

  if kill -TERM "$pid" 2>/dev/null; then
    incr_counter _helper_restart_success
    _last_helper_kill=$now
    # Record anti-respawn type so next kill picks a different process
    _last_killed_type="$candidate_type"
    _last_killed_type_time=$now
    # Track escalation window
    if (( now - _helper_kills_window_start > EXT_HOST_ESCALATION_WINDOW )); then
      _helper_kills_in_window=1
      _helper_kills_window_start=$now
    else
      _helper_kills_in_window=$(( _helper_kills_in_window + 1 ))
    fi
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
  for pid in $(ps -C "$TIER_PROTECTED_PNAME" -o pid= 2>/dev/null); do
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
  for pid in $(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null; pgrep -f "$TIER_DISPOSABLE_PATTERN_AUX" 2>/dev/null); do
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
  current_pids=$(ps -C "$TIER_PROTECTED_PNAME" -o pid= 2>/dev/null | sort | tr '\n' ' ')
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
        # Record timestamp for restart-loop detection (Issue #25)
        _restart_timestamps="${_restart_timestamps} ${now}"
        log "VS Code startup: ${new_count} new PIDs — startup mode active for ${STARTUP_DURATION}s (${STARTUP_INTERVAL}s interval, ${STARTUP_RSS_EMERG_KB} kB emerg threshold)"
        # Pre-emptively SIGTERM Chrome to free memory before extensions load
        if pgrep -f "$TIER_DISPOSABLE_PATTERN" &>/dev/null; then
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

# ── Startup tier logging (Issue #6) ──────────────────────────────────────────
# Log a summary of process-to-tier classification. Called once at daemon startup
# after the first adjust_oom_scores pass so tier assignments are visible in the
# journal for diagnostics.
log_tier_assignments() {
  local protected_pids disposable_pids aux_pids
  local protected_count=0 disposable_count=0
  protected_pids=$(ps -C "$TIER_PROTECTED_PNAME" -o pid= 2>/dev/null | tr '\n' ' ')
  protected_count=$(echo "$protected_pids" | wc -w)
  disposable_pids=$(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | tr '\n' ' ')
  aux_pids=$(pgrep -f "$TIER_DISPOSABLE_PATTERN_AUX" 2>/dev/null | tr '\n' ' ')
  disposable_pids="${disposable_pids}${aux_pids}"
  disposable_count=$(echo "$disposable_pids" | wc -w)
  log "TIER: protected=${protected_count} (${TIER_PROTECTED_PNAME}, adj=${OOM_VSCODE_ADJ}) disposable=${disposable_count} (adj=${OOM_CHROME_ADJ}) patterns: browser='${TIER_DISPOSABLE_PATTERN}' automation='${TIER_DISPOSABLE_PATTERN_AUX}'"
  if (( protected_count > 0 )); then
    log "TIER: protected PIDs: ${protected_pids}"
  fi
  if (( disposable_count > 0 )); then
    log "TIER: disposable PIDs: ${disposable_pids}"
  fi
}

# ── Restart-loop detection (Issue #25) ──────────────────────────────────────
# Prune _restart_timestamps to the active window, count remaining events.
# On threshold breach (and outside cooldown), SIGKILL Chrome and arm cooldown.
check_restart_loop() {
  local now
  now=$(date +%s)
  local cutoff=$(( now - RESTART_LOOP_WINDOW_S ))
  # Prune timestamps older than window
  local new_ts="" ts
  for ts in $_restart_timestamps; do
    (( ts >= cutoff )) && new_ts="$new_ts $ts"
  done
  _restart_timestamps="${new_ts# }"
  # Count remaining restart events in window
  local count=0
  [[ -n "$_restart_timestamps" ]] &&     count=$(echo "$_restart_timestamps" | tr ' ' '
' | grep -cv '^$' || echo 0)
  if (( count >= RESTART_LOOP_THRESHOLD && now >= _restart_loop_cooldown_end )); then
    incr_counter _restart_loop_events
    _restart_loop_cooldown_end=$(( now + RESTART_LOOP_COOLDOWN_S ))
    log "RESTART-LOOP: VS Code restarted ${count}x in ${RESTART_LOOP_WINDOW_S}s — SIGKILL Chrome + ${RESTART_LOOP_COOLDOWN_S}s cooldown"
    notify_desktop "crit" "🔄 VS Code Restart Loop"       "VS Code restarted ${count}x in $((RESTART_LOOP_WINDOW_S/60)) min. Force-killing Chrome to break loop."
    kill_browsers "KILL" "restart-loop: ${count} restarts/${RESTART_LOOP_WINDOW_S}s"
  fi
}

# ── Chrome process count cap (Issue #26) ─────────────────────────────────────
# Count Chrome/Chromium PIDs. SIGKILL oldest processes above CHROME_COUNT_MAX.
check_chrome_cap() {
  local chrome_pids=()
  mapfile -t chrome_pids < <(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | sort -n)
  local count=${#chrome_pids[@]}
  if (( count > CHROME_COUNT_MAX )); then
    local excess=$(( count - CHROME_COUNT_MAX ))
    incr_counter _chrome_excess_events
    log "CHROME-EXCESS: ${count} Chrome/Chromium PIDs (cap=${CHROME_COUNT_MAX}) — SIGKILL ${excess} oldest"
    notify_desktop "warn" "⚠️ Chrome Accumulation: ${count}"       "Chrome process count (${count}) exceeds cap (${CHROME_COUNT_MAX}). Killing ${excess} oldest."
    local i=0
    for pid in "${chrome_pids[@]}"; do
      (( i >= excess )) && break
      if $DRY_RUN; then
        log "  (dry-run: would SIGKILL Chrome PID ${pid})"
      else
        kill -9 "$pid" 2>/dev/null && log "  → SIGKILL Chrome PID ${pid} (excess accumulation)"
      fi
      (( i++ ))
    done
  fi
}

# ── cgroup v1 memory path discovery ──────────────────────────────────────────
# Derive the user-session memory cgroup path from /proc/self/cgroup.
# Used by Stage 2 (memory.soft_limit_in_bytes) and Stage 3 (memory.force_empty).
# If the path doesn't exist or sudo -n fails, cgroup writes are silently disabled.
discover_cgroup_mem_path() {
  local rel
  rel=$(awk -F: '$2=="memory"{print $3; exit}' /proc/self/cgroup 2>/dev/null)
  if [[ -z "$rel" ]]; then
    log "cgroup: no memory controller found in /proc/self/cgroup — cgroup writes disabled"
    return
  fi
  local path="/sys/fs/cgroup/memory${rel}"
  if [[ ! -d "$path" ]]; then
    log "cgroup: path $path does not exist — cgroup writes disabled"
    return
  fi
  # Test writability with sudo -n
  if ! sudo -n test -w "$path/memory.soft_limit_in_bytes" 2>/dev/null; then
    log "cgroup: sudo -n cannot write to $path/memory.soft_limit_in_bytes — cgroup writes disabled"
    return
  fi
  _cgroup_mem_path="$path"
  log "cgroup: discovered memory path: $path (soft_limit + force_empty available)"
}

# ── Stage transition logging ────────────────────────────────────────────────
set_pressure_stage() {
  local new_stage="$1"
  local reason="$2"
  if (( new_stage != _pressure_stage )); then
    local old=$_pressure_stage
    _pressure_stage=$new_stage
    _stage_entry_time=$(date +%s)
    _stage_hyst_count=0
    _stage_transitions=$(( _stage_transitions + 1 ))
    log "[STAGE ${old}→${new_stage}] ${reason}"
    if (( new_stage > old )); then
      _pressure_active=true
      _recovery_clean_count=0
    fi
  fi
}

# ── cgroup v1 throttle: write memory.soft_limit_in_bytes ─────────────────
# Creates kernel reclaim pressure without hard-killing anything.
# Only effective when system is under global memory pressure.
cgroup_throttle() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  local total_kb soft_limit_kb
  total_kb=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  [[ -z "$total_kb" ]] && return 1
  soft_limit_kb=$(( total_kb * STAGE2_SOFT_LIMIT_PCT / 100 ))
  local soft_limit_bytes=$(( soft_limit_kb * 1024 ))
  if $DRY_RUN; then
    log "  (dry-run: would write ${soft_limit_bytes} to memory.soft_limit_in_bytes)"
    _soft_limit_active=true
    return 0
  fi
  if echo "$soft_limit_bytes" | sudo -n tee "$_cgroup_mem_path/memory.soft_limit_in_bytes" > /dev/null 2>&1; then
    log "  cgroup: memory.soft_limit_in_bytes set to ${soft_limit_kb} kB (${STAGE2_SOFT_LIMIT_PCT}% of total)"
    _soft_limit_active=true
    return 0
  fi
  log "  cgroup: failed to write memory.soft_limit_in_bytes"
  return 1
}

# ── cgroup v1 reclaim: write to memory.force_empty ───────────────────────
# Triggers synchronous kernel reclaim of reclaimable pages from the cgroup.
cgroup_reclaim() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  if $DRY_RUN; then
    log "  (dry-run: would write 0 to memory.force_empty)"
    return 0
  fi
  if echo 0 | sudo -n tee "$_cgroup_mem_path/memory.force_empty" > /dev/null 2>&1; then
    log "  cgroup: memory.force_empty triggered — kernel reclaiming pages"
    return 0
  fi
  log "  cgroup: failed to write memory.force_empty"
  return 1
}

# ── cgroup v1 throttle release: reset soft_limit to unlimited ────────────
cgroup_release_throttle() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  $_soft_limit_active || return 0  # nothing to release
  if $DRY_RUN; then
    log "  (dry-run: would reset memory.soft_limit_in_bytes to unlimited)"
    _soft_limit_active=false
    return 0
  fi
  if echo -1 | sudo -n tee "$_cgroup_mem_path/memory.soft_limit_in_bytes" > /dev/null 2>&1; then
    log "  cgroup: memory.soft_limit_in_bytes reset to unlimited"
    _soft_limit_active=false
    return 0
  fi
  return 1
}

# ── Evaluate pressure stage from current metrics ─────────────────────────
# Returns the stage number (0-4) that current conditions warrant.
# Called every loop iteration; actual transition uses hysteresis.
evaluate_pressure_stage() {
  local pct="$1"          # MemAvailable percentage
  local psi_some="$2"     # PSI some avg10 × 100
  local psi_full="$3"     # PSI full avg10 × 100

  # Stage 4: terminate
  if (( psi_full >= STAGE4_PSI_FULL_X100 || pct <= STAGE4_MEM_PCT )); then
    echo 4; return
  fi
  # Stage 3: reclaim
  if (( psi_full >= STAGE3_PSI_FULL_X100 || pct <= STAGE3_MEM_PCT )); then
    echo 3; return
  fi
  # Stage 2: throttle
  if (( psi_some >= STAGE2_PSI_SOME_X100 || pct <= STAGE2_MEM_PCT )); then
    echo 2; return
  fi
  # Stage 1: monitor
  if (( psi_some >= STAGE1_PSI_SOME_X100 || pct <= STAGE1_MEM_PCT )); then
    echo 1; return
  fi
  echo 0
}

# ── Kill cooldown check (Issue #5) ──────────────────────────────────────────
# Returns 0 (allow) if cooldown has expired, 1 (skip) if still in cooldown.
# EMERGENCY and SIGKILL callers pass mode="critical" to bypass.
kill_cooldown_allows() {
  local mode="${1:-normal}"
  [[ "$mode" == "critical" ]] && return 0
  local now
  now=$(date +%s)
  if (( now - _last_kill_action_time < KILL_COOLDOWN )); then
    local remaining=$(( KILL_COOLDOWN - (now - _last_kill_action_time) ))
    incr_counter _cooldown_skips
    log "  [COOLDOWN] Skipping non-critical kill evaluation — ${remaining}s remaining"
    return 1
  fi
  return 0
}

# ── Main loop ────────────────────────────────────────────────────────────────
# ── SIGTERM / SIGINT trap ─────────────────────────────────────────────────────
# Without this, systemd's SIGTERM to the main bash process is deferred until
# the foreground `sleep` subprocess finishes (up to 2 s / 0.5 s). The `wait`
# builtin IS interruptible — signals fire immediately when using `sleep & wait`.
# Kills the pending sleep pid (if any) so it doesn't linger as an orphan.
_sleep_pid=''
trap '[[ -n "${_sleep_pid:-}" ]] && kill "$_sleep_pid" 2>/dev/null; log_status_snapshot "stop"; log "Stopping (signal received)"; exit 0' TERM INT

log "Started (4-stage model: S1≤${STAGE1_MEM_PCT}%/PSIsome>${STAGE1_PSI_SOME_X100}, S2≤${STAGE2_MEM_PCT}%/PSIsome>${STAGE2_PSI_SOME_X100}, S3≤${STAGE3_MEM_PCT}%/PSIfull>${STAGE3_PSI_FULL_X100}, S4≤${STAGE4_MEM_PCT}%/PSIfull>${STAGE4_PSI_FULL_X100}, oom_adj code=${OOM_VSCODE_ADJ} chrome=+${OOM_CHROME_ADJ}, cgroup=${_cgroup_mem_path:-disabled})"
$DRY_RUN && log "DRY-RUN mode — no processes will be killed"

# Apply OOM scores immediately at startup before the first loop iteration
adjust_oom_scores

# Log tier assignments at startup for diagnostics (Issue #6)
log_tier_assignments

# Discover cgroup v1 memory path for Stage 2/3 interventions (Issue #4)
discover_cgroup_mem_path

while true; do
  incr_counter _loops
  _action_taken=false

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

  # ── VM health canary — /proc/meminfo inaccessibility (Issue #27) ───────────
  # "Transport endpoint is not connected" on /proc/meminfo signals that the
  # Crostini virtio socket to ChromeOS has been severed — VM shutdown imminent.
  # Discovered 2026-03-10: the watchdog silently continued with empty reads
  # instead of logging the impending shutdown. Flush and warn before exiting.
  if ! [[ -r /proc/meminfo ]]; then
    log "WARN: /proc/meminfo unreadable — Crostini VM shutdown signal detected; flushing and pausing"
    notify_desktop "crit" "⚠️ VM Shutdown Signal"       "/proc/meminfo unreadable. Crostini container may be terminating."
    sync 2>/dev/null || true
    sleep 1 & wait "$!" 2>/dev/null || true
    continue
  fi

  # ── Restart-loop and Chrome-cap checks ───────────────────────────────────
  check_restart_loop
  check_chrome_cap

  # Read MemAvailable and MemTotal.
  # IMPORTANT: Never use SwapFree — Crostini kernel reports ~18.4 exabytes
  # (uint64 overflow sentinel). Use awk to be safe against whitespace/format.
  avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  total=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)

  # Guard against empty/malformed reads
  [[ -z "$avail" || -z "$total" || "$total" -eq 0 ]] && continue

  pct=$(( avail * 100 / total ))

  # Read PSI avg10 values for staged pressure response (Issue #4).
  # "some": percentage of time at least ONE task stalled (Stage 1/2 trigger).
  # "full":  percentage of time ALL tasks stalled (Stage 3/4 trigger).
  # Multiply by 100 for integer comparison: avg10=3.45 → 345.
  psi_some_x100=$(awk '/^some[[:space:]]/{
    for(i=1;i<=NF;i++) {
      if($i ~ /^avg10=/) {
        sub("avg10=","",$i)
        printf "%d", $i * 100
        exit
      }
    }
  }' /proc/pressure/memory 2>/dev/null || echo 0)

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
  vscode_rss=$(ps -C "$TIER_PROTECTED_PNAME" -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')
  chrome_running=$(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | head -1)

  # ── RSS velocity check — detect runaway growth (≥RSS_ACCEL_KB/cycle) ──
  # 2026-03-13 crash: RSS grew 3.8→6.0 GB in ~20s (300 MB/cycle at 2s). Watchdog
  # detected threshold crossings but was already too late. Velocity tracking lets
  # us intervene earlier when the growth rate alone signals a runaway.
  #
  # GATE: only fire when vscode_rss is already at or above eff_warn.
  # Without this gate, V8 JIT compilation during VS Code startup legitimately spikes
  # 300–900 MB/cycle at 1–2 GB total RSS (safe range), causing the watchdog to kill
  # NodeService / extension-host processes in a restart loop (confirmed 2026-03-16:
  # "Extension host terminated unexpectedly 3 times within the last 5 minutes").
  # The 2026-03-13 crash that motivated this check started at ~3.8 GB — the gate
  # preserves that protection while eliminating startup false positives.
  if (( _prev_vscode_rss > 0 && vscode_rss > _prev_vscode_rss )); then
    _rss_delta=$(( vscode_rss - _prev_vscode_rss ))
    if (( _rss_delta >= RSS_ACCEL_KB && vscode_rss >= eff_warn )); then
      incr_counter _rss_accel_events
      log "ACCEL: VS Code RSS grew ${_rss_delta} kB in one cycle (total=${vscode_rss} kB) — accelerating intervention"
      if (( vscode_rss >= RSS_RUNAWAY_MIN_KB )); then
        _runaway_streak=$(( _runaway_streak + 1 ))
      fi
      if [[ -z "$chrome_running" ]]; then
        # Use normal mode (language-server protection ON) unless RSS has actually
        # reached emergency level. Without this, WARN-range spikes (~2.2 GB)
        # bypass all protection and kill language servers that only use ~80-120 MB.
        # Fix: issue #45 — confirmed 2026-03-24 crash from emerg at WARN range.
        accel_mode="normal"
        (( vscode_rss >= eff_emerg )) && accel_mode="emerg"
        kill_top_vscode_helper "RSS acceleration: +${_rss_delta} kB/cycle (${vscode_rss} kB total)" "$accel_mode"
      else
        kill_browsers "TERM" "RSS acceleration: +${_rss_delta} kB/cycle (${vscode_rss} kB total)"
      fi
    fi
  else
    _runaway_streak=0
  fi

  if (( _runaway_streak >= RSS_RUNAWAY_STREAK )); then
    log "CIRCUIT-BREAKER: RSS runaway streak ${_runaway_streak}/${RSS_RUNAWAY_STREAK} (rss=${vscode_rss} kB) — controlled VS Code restart"
    kill_vscode_main "RSS runaway persisted across ${_runaway_streak} cycles (${vscode_rss} kB)" "critical"
    _runaway_streak=0
  fi
  _prev_vscode_rss=$vscode_rss

  # Pre-emergency intervention: startup PID churn burst + elevated RSS.
  # Never run this once emergency threshold is reached; emergency takes priority.
  if $_startup_burst_danger && (( vscode_rss >= STARTUP_BURST_RSS_KB )) && (( vscode_rss < eff_emerg )); then
    log "BURST: startup PID churn=${_startup_burst_count} in ${STARTUP_BURST_WINDOW}s with VS Code RSS ${vscode_rss} kB — preemptive helper restart"
    notify_desktop "warn" "⚠️ VS Code Startup Churn" \
      "Repeated VS Code helper respawns detected; restarting heaviest helper to prevent crash."
    if kill_top_vscode_helper "startup churn burst (${_startup_burst_count} new PIDs/${STARTUP_BURST_WINDOW}s)"; then
      _startup_burst_danger=false
      _startup_burst_count=0
      _startup_burst_window_start=$(date +%s)
    else
      log "BURST: no safe helper candidate available — skipping helper restart to avoid language-server disruption"
      _startup_burst_danger=false
      _startup_burst_count=0
      _startup_burst_window_start=$(date +%s)
    fi
  fi

  if (( vscode_rss >= eff_emerg )); then
    # ── EMERGENCY — bypasses cooldown and hysteresis (critical) ──────────
    _hyst_warn_count=0
    _recovery_clean_count=0
    _pressure_active=true
    incr_counter _rss_emergency_events
    log "EMERGENCY: VS Code RSS ${vscode_rss} kB (≥${eff_emerg} kB) — attempting to save VS Code window"
    notify_desktop "crit" "🚨 VS Code Memory EMERGENCY" \
      "VS Code RSS: $(( vscode_rss / 1024 )) MB — triggering controlled recovery to avoid kernel OOM."
    if [[ -z "$chrome_running" ]]; then
      # No Chrome target during emergency: avoid helper thrash and restart VS Code directly.
      kill_vscode_main "VS Code RSS emergency with no browser target (${vscode_rss} kB)" "critical"
    else
      kill_browsers "KILL" "VS Code RSS emergency: ${vscode_rss} kB" "critical"
    fi
  elif (( vscode_rss >= eff_warn )); then
    # ── WARN — requires hysteresis and cooldown ─────────────────────────
    _recovery_clean_count=0
    _hyst_warn_count=$(( _hyst_warn_count + 1 ))
    if (( _hyst_warn_count < HYSTERESIS_POLLS )); then
      incr_counter _hysteresis_skips
      log "  [HYSTERESIS] RSS WARN ${vscode_rss} kB — poll ${_hyst_warn_count}/${HYSTERESIS_POLLS} (waiting for sustained pressure)"
    elif kill_cooldown_allows "normal"; then
      incr_counter _rss_warn_events
      _pressure_active=true
      log "WARNING: VS Code RSS ${vscode_rss} kB (≥${eff_warn} kB) sustained for ${_hyst_warn_count} polls — SIGTERMing Chrome, restart ext host soon"
      notify_desktop "warn" "⚠️ VS Code Memory High" \
        "VS Code RSS: $(( vscode_rss / 1024 )) MB — terminating Chrome.\nConsider: Developer: Restart Extension Host"
      # 2026-03-25 crash fix: check chrome_running BEFORE calling kill_browsers.
      if [[ -n "$chrome_running" ]]; then
        kill_browsers "TERM" "VS Code RSS high: ${vscode_rss} kB (sustained ${_hyst_warn_count} polls)"
      else
        if ! kill_top_vscode_helper "VS Code RSS warn: no Chrome to SIGTERM (${vscode_rss} kB)" "normal"; then
          kill_extension_host "warn fallback: helper unavailable while RSS high (${vscode_rss} kB)"
        fi
      fi
    fi
  else
    _hyst_warn_count=0
  fi

  # ── 4-stage pressure evaluation (Issue #4) ──────────────────────────────
  # Replaces flat SIGKILL/SIGTERM/PSI check with graduated response.
  # RSS-based checks (EMERGENCY/WARN above) remain independent.
  # Stage transitions use hysteresis for upward moves; Stage 4 bypasses.
  candidate_stage=$(evaluate_pressure_stage "$pct" "$psi_some_x100" "$psi_x100")

  if (( candidate_stage > _pressure_stage )); then
    # Upward transition — Stage 4 bypasses hysteresis (critical)
    if (( candidate_stage >= 4 )); then
      set_pressure_stage 4 "CRITICAL: pct=${pct}% psi_full=${psi_x100} — bypassing hysteresis"
    else
      _stage_hyst_count=$(( _stage_hyst_count + 1 ))
      if (( _stage_hyst_count >= HYSTERESIS_POLLS )); then
        set_pressure_stage "$candidate_stage" "sustained ${_stage_hyst_count} polls (pct=${pct}% psi_some=${psi_some_x100} psi_full=${psi_x100})"
      else
        incr_counter _hysteresis_skips
        log "  [HYSTERESIS] Stage ${_pressure_stage}→${candidate_stage} — poll ${_stage_hyst_count}/${HYSTERESIS_POLLS}"
      fi
    fi
  elif (( candidate_stage < _pressure_stage )); then
    # Downward transition — immediate
    _stage_hyst_count=0
    set_pressure_stage "$candidate_stage" "conditions eased (pct=${pct}% psi_some=${psi_some_x100} psi_full=${psi_x100})"
    # Release cgroup throttle if dropping below Stage 2
    if (( candidate_stage < 2 )); then
      cgroup_release_throttle
    fi
  else
    # Same stage — reset upward hysteresis counter
    _stage_hyst_count=0
  fi

  # ── Execute stage-specific actions ──────────────────────────────────────
  case $_pressure_stage in
    1)
      # Stage 1 — Monitor: log + Chrome oom_score_adj already managed per-loop
      _recovery_clean_count=0
      ;;
    2)
      # Stage 2 — Throttle: cgroup soft_limit + SIGTERM Chrome
      _recovery_clean_count=0
      _pressure_active=true
      if kill_cooldown_allows "normal"; then
        if ! $_soft_limit_active; then
          cgroup_throttle
        fi
        if [[ -n "$chrome_running" ]]; then
          incr_counter _low_mem_term_events
          notify_desktop "warn" "⚠️ Memory Pressure Stage 2: ${pct}% free" \
            "Throttling memory + terminating Chrome. PSI some=$(( psi_some_x100 / 100 )).$(( psi_some_x100 % 100 ))%"
          kill_browsers "TERM" "Stage 2 throttle: pct=${pct}% psi_some=${psi_some_x100}"
        fi
      fi
      ;;
    3)
      # Stage 3 — Reclaim: force_empty + SIGTERM Chrome + helpers
      _recovery_clean_count=0
      _pressure_active=true
      if kill_cooldown_allows "normal"; then
        cgroup_reclaim
        incr_counter _low_mem_term_events
        notify_desktop "warn" "⚠️ Memory Pressure Stage 3: ${pct}% free" \
          "Reclaiming pages + terminating Chrome. PSI full=$(( psi_x100 / 100 )).$(( psi_x100 % 100 ))%"
        if [[ -n "$chrome_running" ]]; then
          kill_browsers "TERM" "Stage 3 reclaim: pct=${pct}% psi_full=${psi_x100}"
        else
          if ! kill_top_vscode_helper "Stage 3: no Chrome (pct=${pct}%, psi_full=${psi_x100})" "normal"; then
            kill_extension_host "Stage 3 fallback: helper unavailable (${avail} kB free)"
          fi
        fi
      fi
      ;;
    4)
      # Stage 4 — Terminate: SIGKILL Chrome; if no Chrome → VS Code recovery
      _recovery_clean_count=0
      _pressure_active=true
      incr_counter _critical_kill_events
      notify_desktop "crit" "🚨 Critical Memory Stage 4: ${pct}% free" \
        "Force-killing Chrome/Playwright.\nClose ChromeOS tabs if crash persists."
      if [[ -n "$chrome_running" ]]; then
        kill_browsers "KILL" "Stage 4 terminate: pct=${pct}% psi_full=${psi_x100}" "critical"
      else
        kill_vscode_main "Stage 4: no browser target (${avail} kB free, psi_full=${psi_x100})" "critical"
      fi
      ;;
  esac

  # ── Recovery confirmation (Issues #4, #5) ─────────────────────────────────
  # When ALL conditions are clear: stage 0 (below all stage thresholds),
  # RSS below WARN, and recovery quality thresholds met — count clean polls.
  # At RECOVERY_POLLS, release cgroup throttle, log recovery, reset tracking.
  if (( _pressure_stage == 0 && vscode_rss < eff_warn )); then
    if (( psi_some_x100 < RECOVERY_PSI_X100 && psi_x100 < RECOVERY_PSI_X100 && pct > RECOVERY_MEM_PCT )); then
      _recovery_clean_count=$(( _recovery_clean_count + 1 ))
      if $_pressure_active && (( _recovery_clean_count >= RECOVERY_POLLS )); then
        incr_counter _recovery_confirmations
        cgroup_release_throttle
        log "RECOVERY: ${_recovery_clean_count} consecutive clean polls (psi_some=${psi_some_x100}, psi_full=${psi_x100}, mem_pct=${pct}%) — pressure cleared"
        _pressure_active=false
        _recovery_clean_count=0
        log_status_snapshot "recovery"
      fi
    else
      # Partially clear — don't count toward recovery
      _recovery_clean_count=0
    fi
  elif (( _pressure_stage == 0 )); then
    # Stage 0 but RSS still high — reset recovery counter
    _recovery_clean_count=0
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
