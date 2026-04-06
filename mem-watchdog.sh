#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# mem-watchdog.sh — Crostini-safe memory watchdog for VS Code / disposable processes
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
#   See docs/technical/crostini-swap-reality.md for zram/zswap investigation.
#
# WHAT THIS DOES:
#   - MemAvailable-primary architecture: only MemAvailable % and PSI trigger interventions.
#   - Outward-facing kill policy: NEVER kills VS Code or its components.
#   - Reads ONLY MemAvailable and MemTotal — both correct on this kernel.
#   - Also reads /proc/pressure/memory (PSI) for sustained-pressure detection.
#   - 4-stage graduated pressure response (Issue #4):
#     Stage 1 (Monitor):   PSI some > 1% OR MemAvail < 35% → log + raise Chrome oom_score_adj
#     Stage 2 (Throttle):  PSI some > 3% OR MemAvail < 30% → cgroup soft_limit + SIGTERM Chrome
#     Stage 3 (Reclaim):   PSI full > 2% OR MemAvail < 25% → cgroup force_empty + SIGTERM Chrome + helpers
#     Stage 4 (Critical):  PSI full > 5% OR MemAvail < 15% → SIGKILL Chrome + non-essential apps; defer to kernel OOM
#   - Kills disposable processes (Chrome, Playwright, non-essential apps) and reclaimable helpers only.
#   - Optional operator approval prompt for non-critical disposable kills
#     (extension modal handshake via ~/.config/mem-watchdog/kill-approval-* files).
#   - Stage 4: defers to kernel OOM killer instead of killing VS Code (oom_score_adj: code=0, chrome=1000).
#   - Sets oom_score_adj=0 on VS Code (lowers Electron's default 200-300).
#   - Sets oom_score_adj=+1000 on Chrome (kernel kills it first).
#   - Checks every 2 seconds (was 4s — confirmed too slow to catch rapid spike).
#   - STARTUP MODE: switches to 0.5s checks for 90s when new VS Code PIDs detected.
#   - STARTUP MODE: proactively SIGTERMs Chrome the moment VS Code starts loading.
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
# cgroup v2: memory.high (throttle), memory.reclaim (proactive reclaim, kernel 5.19+).
# cgroup v1: memory.soft_limit_in_bytes (throttle), memory.force_empty (reclaim).
# Detection: v2 preferred if available; v1 fallback. Graceful no-op if neither writable.
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
# Stage 4 — Critical: SIGKILL disposable targets + critical helper escalation
STAGE4_PSI_FULL_X100=500       # PSI full avg10 > 5.00%
STAGE4_MEM_PCT=15              # OR MemAvailable < 15%
VSCODE_RSS_WARN_KB=3481600     # 3.4 GB default warn threshold for aggregate VS Code RSS
VSCODE_RSS_EMERG_KB=3891200    # 3.8 GB default emergency threshold for aggregate VS Code RSS
RSS_ACCEL_KB=300000            # 300 MB/cycle RSS acceleration gate
CODE_RECOVERY_COOLDOWN=30      # minimum seconds between controlled VS Code main restarts

# Backward-compatible names — NOT used directly in the daemon.
# configWriter.js (v0.3.x) writes these to ~/.config/mem-watchdog/config.sh.
# After config sourcing below, they are mapped to stage constants.
INTERVAL=2             # Seconds between checks (was 4 — confirmed too slow in crash of 2026-03-05)
export WATCHDOG_VERSION=20260405.1   # 2026-04-05 v1: broaden automation session detection for Playwright MCP / Claude visualization flows
OOM_VSCODE_ADJ=0       # oom_score_adj for VS Code: lowers Electron's default 200-300
OOM_CHROME_ADJ=1000    # oom_score_adj for Chrome: maximum killable

# ── Process classification tiers (Issue #6) ──────────────────────────────────
# Three tiers classify processes for oom_score_adj and kill-eligibility decisions.
# Override patterns in ~/.config/mem-watchdog/config.sh to add custom processes.
#
# PROTECTED: VS Code core processes
#   Matched by: ps -C $TIER_PROTECTED_PNAME (process name match)
#   oom_score_adj: OOM_VSCODE_ADJ (0) — non-negative; no root needed
#   Kill policy: NEVER killed by the watchdog; protected at all severity levels
#
# DISPOSABLE: browser and automation-orchestrator processes
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
# Disposable process pattern (ERE for pgrep -f). Processes matching this
# pattern are candidates for SIGTERM/SIGKILL under memory pressure.
# Default covers common browser processes. Override in config.sh for your stack.
TIER_DISPOSABLE_PATTERN='(chrome|chromium|firefox)'
# Automation session orchestrator pattern. When a process matching this
# pattern is running, automation_session_active() returns true and the
# managed window protocol is applied automatically as a fallback for
# callers that cannot signal explicitly.
# Default covers common automation orchestrators (Node/Python/Claude wrappers)
# used by Playwright MCP and visualization workflows. Override in config.sh.
TIER_DISPOSABLE_PATTERN_AUX='(node|python|claude).*(playwright|puppeteer|cypress|selenium-webdriver|mcp|vision|visualization)'

NOTIFY_INTERVAL=300           # seconds between desktop notifications per severity

# ── Startup mode — faster polling for 90s after VS Code starts ──
# Root cause of 2026-03-06 crash: extension host went 0→4.7 GB in <2s during startup.
# Fix: detect new VS Code PIDs, switch to 0.5s interval for faster stage evaluation.
STARTUP_INTERVAL=0.5          # seconds between checks during VS Code startup
STARTUP_DURATION=90           # seconds to stay in startup mode after new VS Code PIDs
STARTUP_DEBOUNCE=300          # minimum seconds between startup mode activations
                              # VS Code language servers (TS, ESLint, GitLens workers) spawn
                              # new code PIDs throughout normal development. Without this guard
                              # the daemon triggered startup mode 567 times in a single day,
                              # keeping it at 0.5 s polling continuously.
HELPER_KILL_COOLDOWN=10        # min seconds between helper restarts
ANTI_RESPAWN_WINDOW=30         # seconds to skip a process type after killing it
                              # 2026-03-13: tsserver killed → immediately respawned → killed again
                              # in a tight loop. Skipping the same type forces a different target.
STATUS_INTERVAL=60            # seconds between watchdog status snapshots in journal

# ── Intervention safety gates — prevent action thrash under spike storms ──
ACTION_BUDGET_WINDOW=30       # seconds in intervention budget window
ACTION_BUDGET_MAX=6           # max non-critical actions per window

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
# propagated to MemAvailable within the next poll. Stage 4 and
# SIGKILL (≤SIGKILL_THRESHOLD) paths bypass this — they are critical.
KILL_COOLDOWN=15                # seconds to skip non-critical kill evaluation after any action
HYSTERESIS_POLLS=3              # consecutive polls above threshold before non-critical action
                                # at 2s interval = 6s sustained pressure before acting
RECOVERY_POLLS=5                # consecutive clean polls to confirm recovery (10s at 2s)
RECOVERY_PSI_X100=100           # PSI some avg10 < 1.00% to count as clean (below Stage 1)
RECOVERY_MEM_PCT=40             # MemAvailable > 40% to count as clean (above Stage 1)
RECLAIM_TIMEOUT_S=${RECLAIM_TIMEOUT_S:-3}          # max seconds to wait on a cgroup reclaim write before aborting
RECLAIM_MIN_INTERVAL_S=${RECLAIM_MIN_INTERVAL_S:-10} # minimum seconds between reclaim attempts (prevents reclaim storms)
MEM_SLEEP_TIMEOUT_S=${MEM_SLEEP_TIMEOUT_S:-300}      # stale SLEEP mode auto-clear timeout (seconds)
CHAT_WARN_MB=${CHAT_WARN_MB:-200}                    # startup warning threshold per workspace chatSessions footprint
INTERACTIVE_KILL_PROMPT_ENABLED=${INTERACTIVE_KILL_PROMPT_ENABLED:-1}
INTERACTIVE_KILL_PROMPT_TTL_S=${INTERACTIVE_KILL_PROMPT_TTL_S:-20}
INTERACTIVE_KILL_DEFER_DEFAULT_S=${INTERACTIVE_KILL_DEFER_DEFAULT_S:-120}

# ── Disposable process count cap — accumulation guard (Issue #26) ─────────
# Discovered 2026-03-10: browser scopes accumulated over 3.5 hours.
# SIGTERM-on-startup only clears disposable processes at restart moments,
# not between them.
DISPOSABLE_COUNT_MAX=3

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

# Backward compatibility (Issue #140): accept legacy CHROME_COUNT_MAX for one
# release cycle. If both are set, DISPOSABLE_COUNT_MAX wins.
_legacy_chrome_cap_alias_used=false
if [[ -v CHROME_COUNT_MAX && ! -v DISPOSABLE_COUNT_MAX ]]; then
  DISPOSABLE_COUNT_MAX="$CHROME_COUNT_MAX"
  _legacy_chrome_cap_alias_used=true
fi

# ── Managed window signal file path (Issue #139) ───────────────────────────────
# External callers (e.g., publish scripts) write 'SLEEP' to this file to request
# that the watchdog defer all kill and reclaim actions during a protected window.
# The daemon continues monitoring memory; only interventions are gated.
# Removing the file or writing any other content restores normal operation.
_MODE_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/mem-watchdog/mode"
_KILL_APPROVAL_REQ_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/mem-watchdog/kill-approval-request"
_KILL_APPROVAL_RESP_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/mem-watchdog/kill-approval-response"

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
_last_helper_kill=0           # epoch seconds of last helper restart
_last_killed_type=""          # process type tag of last helper kill (anti-respawn)
_last_killed_type_time=0      # epoch seconds of last kill of that type
_last_status_log=0            # epoch seconds of last periodic status snapshot
_restart_timestamps=""        # space-separated epoch seconds of recent VS Code restart events
_restart_loop_cooldown_end=0  # epoch seconds until restart-loop cooldown expires
_last_vscode_main_restart=0   # epoch seconds of last controlled VS Code main restart
_last_vscode_rss_kb=0         # previous loop aggregate VS Code RSS for acceleration detection

# ── Cooldown / hysteresis / recovery state (Issue #5) ────────────────────
_last_kill_action_time=0        # epoch seconds of last successful kill of any type
_hyst_lowmem_count=0            # consecutive polls with pct <= SIGTERM_THRESHOLD
_hyst_psi_count=0               # consecutive polls with psi_x100 >= PSI_THRESHOLD*100
_recovery_clean_count=0         # consecutive clean polls (no pressure condition true)
_pressure_active=false          # true when any non-critical intervention fired

# ── 4-stage pressure state (Issue #4) ─────────────────────────────────────
_pressure_stage=0               # 0=normal, 1=monitor, 2=throttle, 3=reclaim, 4=terminate
_stage_entry_time=0             # epoch seconds when current stage was entered
_stage_hyst_count=0             # consecutive polls at candidate (higher) stage
_cgroup_mem_path=""             # populated at startup; empty = cgroup writes disabled
_cgroup_version=""             # "v2" or "v1" — set by discover_cgroup_mem_path()
_soft_limit_active=false        # true when we've lowered memory.high (v2) or memory.soft_limit_in_bytes (v1)
_stage_transitions=0            # total stage transitions for observability
_last_reclaim_action_time=0     # epoch seconds of last successful cgroup reclaim

# ── Cgroup event counters (Issue #12) ────────────────────────────────────────
# Read each poll cycle from memory.events.local (v2) or memory.oom_control +
# memory.failcnt (v1). Detecting oom_kill > _prev_cg_oom_kill means the kernel
# OOM killer fired between polls — critical alert.
_cg_failcnt=0                   # v1: times memory.limit_in_bytes was hit; v2: "max" events
_cg_oom_kill=0                  # kernel OOM kills inside this cgroup
_cg_high_events=0               # v2 only: times memory.high throttle was triggered by kernel
_cg_under_oom=0                 # v1 only: 1 if cgroup is currently under OOM handling
_prev_cg_oom_kill=0             # previous poll's oom_kill — delta detection

# ── Runtime counters / observability ─────────────────────────────────────────
_loops=0
_startup_mode_triggers=0
_startup_debounce_skips=0
_browser_term_actions=0
_browser_kill_actions=0
_browser_noop_actions=0
_helper_restart_attempts=0
_helper_restart_success=0
_helper_restart_cooldown_skips=0
_helper_restart_no_candidate=0
_helper_restart_failures=0
_low_mem_term_events=0
_critical_kill_events=0
_rss_warn_events=0
_rss_emerg_events=0
_vscode_main_restart_events=0
_psi_events=0
_interactive_kill_defer_until=0
_interactive_kill_waits=0
_interactive_kill_allows=0
_interactive_kill_defers=0
_restart_loop_events=0
_chrome_excess_events=0
_cooldown_skips=0
_hysteresis_skips=0
_recovery_confirmations=0
_action_budget_window_start=0
_action_budget_count=0
_action_taken=false
_helper_no_candidate_suppressed=0  # consecutive no-candidate results suppressed from log
_watchdog_mode=""         # current value read from mode file: "SLEEP" or "" (normal)
_last_logged_mode=""      # last mode written to log — prevents per-poll log spam
_mode_sleep_start=0        # epoch seconds when SLEEP mode was first observed

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
  local now avail total pct rss startup_left chrome_count rss_delta
  now=$(date +%s)
  avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  total=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  rss=$(sum_vscode_rss_kb)
  chrome_count=$(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | wc -l)
  rss_delta=0
  if (( _last_vscode_rss_kb > 0 && rss > _last_vscode_rss_kb )); then
    rss_delta=$(( rss - _last_vscode_rss_kb ))
  fi
  pct=0
  if [[ -n "$avail" && -n "$total" && "$total" -gt 0 ]]; then
    pct=$(( avail * 100 / total ))
  fi
  startup_left=0
  if (( now < _startup_mode_end )); then
    startup_left=$(( _startup_mode_end - now ))
  fi
  log "STATUS(${reason}): loops=${_loops} mem_free_pct=${pct} vscode_rss_kb=${rss} rss_delta_kb=${rss_delta} rss_warn_kb=${VSCODE_RSS_WARN_KB} rss_emerg_kb=${VSCODE_RSS_EMERG_KB} chrome_pids=${chrome_count} pressure_stage=${_pressure_stage} stage_transitions=${_stage_transitions} soft_limit_active=${_soft_limit_active} startup_left_s=${startup_left} startup_triggers=${_startup_mode_triggers} startup_debounce_skips=${_startup_debounce_skips} restart_loop_events=${_restart_loop_events} restart_loop_cooldown_remaining=$(( _restart_loop_cooldown_end > $(date +%s) ? _restart_loop_cooldown_end - $(date +%s) : 0 )) chrome_excess_events=${_chrome_excess_events} browser_term=${_browser_term_actions} browser_kill=${_browser_kill_actions} browser_noop=${_browser_noop_actions} helper_attempts=${_helper_restart_attempts} helper_success=${_helper_restart_success} helper_cooldown_skips=${_helper_restart_cooldown_skips} helper_no_candidate=${_helper_restart_no_candidate} helper_failures=${_helper_restart_failures} vscode_main_restarts=${_vscode_main_restart_events} rss_warn_events=${_rss_warn_events} rss_emerg_events=${_rss_emerg_events} anti_respawn_type=${_last_killed_type} action_budget_used=${_action_budget_count} cooldown_skips=${_cooldown_skips} hyst_skips=${_hysteresis_skips} recovery_confirms=${_recovery_confirmations} low_mem=${_low_mem_term_events} critical_mem=${_critical_kill_events} psi_events=${_psi_events} cg_failcnt=${_cg_failcnt} cg_oom_kill=${_cg_oom_kill} cg_high=${_cg_high_events} cg_under_oom=${_cg_under_oom} mode=${_watchdog_mode:-normal}"
  _last_status_log=$now
}

sum_vscode_rss_kb() {
  ps -C "$TIER_PROTECTED_PNAME" -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}'
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

read_kill_approval_field() {
  local file="$1"
  local key="$2"
  local line
  [[ -f "$file" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" == "$key="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done < "$file"
  return 1
}

request_operator_kill_approval() {
  local signal="$1"
  local reason="$2"
  local mode="$3"

  (( INTERACTIVE_KILL_PROMPT_ENABLED == 1 )) || return 0
  [[ "$mode" == "critical" ]] && return 0

  local now request_id existing_id req_ts resp_id decision defer_s remain
  now=$(date +%s)

  if (( now < _interactive_kill_defer_until )); then
    remain=$(( _interactive_kill_defer_until - now ))
    log "  interactive-kill: operator defer cooldown active (${remain}s remaining)"
    return 1
  fi

  existing_id=""
  req_ts=0
  read_kill_approval_field "$_KILL_APPROVAL_REQ_FILE" "id" >/dev/null 2>&1 && existing_id=$(read_kill_approval_field "$_KILL_APPROVAL_REQ_FILE" "id")
  read_kill_approval_field "$_KILL_APPROVAL_REQ_FILE" "ts" >/dev/null 2>&1 && req_ts=$(read_kill_approval_field "$_KILL_APPROVAL_REQ_FILE" "ts")

  if [[ -n "$existing_id" && "$req_ts" =~ ^[0-9]+$ ]]; then
    resp_id=""
    decision=""
    defer_s=""
    read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "id" >/dev/null 2>&1 && resp_id=$(read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "id")
    read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "decision" >/dev/null 2>&1 && decision=$(read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "decision")
    read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "defer_seconds" >/dev/null 2>&1 && defer_s=$(read_kill_approval_field "$_KILL_APPROVAL_RESP_FILE" "defer_seconds")

    if [[ "$resp_id" == "$existing_id" && "$decision" == "allow" ]]; then
      incr_counter _interactive_kill_allows
      rm -f "$_KILL_APPROVAL_REQ_FILE" "$_KILL_APPROVAL_RESP_FILE" 2>/dev/null || true
      log "  interactive-kill: operator approved non-critical disposable kill"
      return 0
    fi
    if [[ "$resp_id" == "$existing_id" && "$decision" == "defer" ]]; then
      [[ "$defer_s" =~ ^[0-9]+$ ]] || defer_s="$INTERACTIVE_KILL_DEFER_DEFAULT_S"
      _interactive_kill_defer_until=$(( now + defer_s ))
      incr_counter _interactive_kill_defers
      rm -f "$_KILL_APPROVAL_REQ_FILE" "$_KILL_APPROVAL_RESP_FILE" 2>/dev/null || true
      log "  interactive-kill: operator deferred disposable kill for ${defer_s}s"
      return 1
    fi

    if (( now - req_ts <= INTERACTIVE_KILL_PROMPT_TTL_S )); then
      incr_counter _interactive_kill_waits
      log "  interactive-kill: awaiting operator decision (request_age=$(( now - req_ts ))s/${INTERACTIVE_KILL_PROMPT_TTL_S}s)"
      return 1
    fi
  fi

  request_id="${now}-$RANDOM"
  mkdir -p "$(dirname "$_KILL_APPROVAL_REQ_FILE")" 2>/dev/null || true
  {
    echo "id=$request_id"
    echo "ts=$now"
    echo "signal=$signal"
    echo "mode=$mode"
    echo "reason=${reason//$'\n'/ }"
    echo "pct=$pct"
    echo "mem_available_kb=$avail"
    echo "mem_total_kb=$total"
    echo "psi_full_x100=$psi_x100"
    echo "vscode_rss_kb=$vscode_rss_kb"
  } > "$_KILL_APPROVAL_REQ_FILE"
  rm -f "$_KILL_APPROVAL_RESP_FILE" 2>/dev/null || true
  log "  interactive-kill: requested operator approval for non-critical disposable kill (ttl=${INTERACTIVE_KILL_PROMPT_TTL_S}s)"
  return 1
}

# ── Kill disposable processes ───────────────────────────────────────────────
kill_disposable_processes() {
  local signal="$1"   # TERM or KILL
  local reason="$2"
  local mode="${3:-normal}" # normal|critical

  # Issue #109: When automation is active and the severity is non-critical,
  # refuse to kill disposable processes.
  # Callers at Stage 2-3 fall through to helper kills or cgroup.
  # Stage 4 passes mode="critical" and bypasses this guard.
  if [[ "$mode" != "critical" ]] && automation_session_active; then
    log "  (automation session active — deferring disposable kill; severity=${mode})"
    return 1
  fi

  request_operator_kill_approval "$signal" "$reason" "$mode" || return 1

  action_budget_allows "$mode" || return 1

  if [[ "$signal" == "TERM" ]]; then
    incr_counter _browser_term_actions
  else
    incr_counter _browser_kill_actions
  fi

  log "ACTION(SIG${signal}): ${reason}"

  if $DRY_RUN; then
    record_action
    log "  (dry-run: would kill disposable process patterns)"
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
    log "  (no disposable processes found to kill)"
    # Do NOT record_action — no-op kills must not consume the action budget
    # or block fallback interventions (kill_top_vscode_helper, kill_nonessential_apps).
    # Crash 2026-03-25: action budget exhausted by 6 no-op kill_disposable_processes calls in 3s,
    # blocking all real interventions while RSS grew from 2.8→3.5 GB unimpeded.
    return 1
  fi

  record_action
  return 0
}

# ── Kill non-essential apps (outward-facing kill policy) ──────────────────────
# Discovers user processes that are NOT VS Code, NOT shell sessions, NOT systemd
# infrastructure. Kills the highest-RSS non-essential process to free memory
# without touching any VS Code component.
# Returns 0 if a process was killed, 1 if no eligible target found.
kill_nonessential_apps() {
  local reason="$1"
  local min_rss_kb=51200  # 50 MB minimum to be worth killing

  action_budget_allows "normal" || return 1

  # Find user processes excluding VS Code, shells, systemd, and essential services.
  # The awk script filters by RSS threshold and excludes protected process names.
  local line
  line=$(ps -u "$(id -u)" -o pid=,rss=,comm=,args= 2>/dev/null \
    | awk -v min_rss="$min_rss_kb" '
      {
        pid=$1; rss=$2; comm=$3;
        $1=""; $2=""; $3=""; sub(/^[[:space:]]+/, "", $0); args=$0;
        # Skip VS Code processes
        if (comm == "code") next;
        # Skip shells and terminals
        if (comm ~ /^(bash|sh|zsh|fish|tmux|screen)$/) next;
        # Skip systemd infrastructure
        if (comm ~ /^(systemd|dbus|gpg-agent|ssh-agent|pipewire|pulse)/) next;
        # Skip the watchdog itself
        if (args ~ /mem-watchdog/) next;
        # Skip very small processes
        if (rss < min_rss) next;
        printf "%s %s %s %s\n", pid, rss, comm, args;
      }
    ' | sort -k2 -rn | head -1)

  if [[ -z "$line" ]]; then
    log "  kill_nonessential_apps: no eligible non-essential process found (min ${min_rss_kb} kB)"
    return 1
  fi

  local pid rss comm
  pid=$(echo "$line" | awk '{print $1}')
  rss=$(echo "$line" | awk '{print $2}')
  comm=$(echo "$line" | awk '{print $3}')

  record_action
  log "ACTION(SIGTERM): ${reason} — killing non-essential app PID ${pid} (${comm}, rss=${rss} kB)"

  if $DRY_RUN; then
    log "  (dry-run: would SIGTERM non-essential PID ${pid})"
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null
  return $?
}

# ── Identify PTY Host PID (the one utility with terminal children) ─────────────────
# VS Code utility processes (--type=utility) include ExtHost, PTY Host, Shared
# Process, File Watcher, and Network Service. ExtHost is identified by
# --inspect-port. PTY Host is the only node.mojom.NodeService utility that has
# child processes (bash terminal shells). All others (Shared, File Watcher,
# Network Service) have 0 children and are safe to kill — they auto-restart.
# This function returns the PTY Host PID in _pty_host_pid (empty if not found).
find_pty_host_pid() {
  _pty_host_pid=""
  local pid
  # Find all node.mojom.NodeService utility PIDs that are NOT the ExtHost
  for pid in $(ps -C "$TIER_PROTECTED_PNAME" -o pid=,args= 2>/dev/null \
    | awk '$0 ~ /--type=utility/ && $0 ~ /node\.mojom\.NodeService/ && $0 !~ /--inspect-port/ {print $1}'); do
    # PTY Host is the one with child processes (bash terminals)
    # shellcheck disable=SC2009  # grep -q . checks for non-empty output, not process name
    if ps --ppid "$pid" -o pid= 2>/dev/null | grep -q .; then
      _pty_host_pid="$pid"
      return 0
    fi
  done
  return 1
}

# ── Restart heaviest VS Code helper (never main window process) ───────────────────
kill_top_vscode_helper() {
  local reason="$1"
  local mode="${2:-normal}"
  local cooldown=$HELPER_KILL_COOLDOWN
  # Language server protection: VS Code is SACRED — language servers are ALWAYS protected.
  # Crashes documented:
  #   2026-03-24 crash #1: tsserver (104 MB) only candidate at WARN -> killed -> session crash
  #   2026-03-24 crash #2: old watchdog (not deployed) killed tsserver; markdown/html
  #                        servers crashed 5x each in OOM cascade.
  local protect_tsserver=true
  local protect_langservers=true   # htmlServerMain, serverWorkerMain (markdown), cssServerMain, jsonServerMain, eslintServer
  if [[ "$mode" == "critical" ]]; then
    protect_tsserver=false
    protect_langservers=false
    cooldown=0
  fi
  local now
  now=$(date +%s)
  action_budget_allows "$mode" || return 1
  incr_counter _helper_restart_attempts

  if (( now - _last_helper_kill < cooldown )); then
    incr_counter _helper_restart_cooldown_skips
    log "  Helper restart cooldown active (${cooldown}s) — skipping"
    return 1
  fi

  local line pid rss args candidate_type

  # Pre-compute PTY Host PID so awk can exclude it specifically.
  # This replaces the blanket --type=utility exclusion that blocked ALL utility
  # processes at WARN level, leaving zero kill candidates (#80).
  find_pty_host_pid
  local pty_host="${_pty_host_pid:-0}"

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
    | awk -v skip="$skip_type" -v prot="$protect_tsserver" -v ls="$protect_langservers" -v pty_host="$pty_host" -v md="$mode" '
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
        if (md != "critical" && args ~ /--type=utility/ && args ~ /--inspect-port/) next;
        if (pid == pty_host) next;
        t=classify(args)
        if (skip != "" && t == skip) next;
        if (prot == "true" && t == "tsserver") next;
        if (ls == "true" && (t == "html-server" || t == "markdown-server" || t == "css-server" || t == "json-server" || t == "eslint")) next;
        if (args ~ /--node-ipc/ || args ~ /server\.bundle\.js/ || (args ~ /tsserver\.js/ && prot != "true") || (args ~ /eslintServer\.js/ && ls != "true") || (args ~ /jsonServerMain/ && ls != "true")) {
          printf "%s %s %s\n", pid, rss, args;
        }
      }
    ' | sort -k2 -rn | head -1)

  # Fallback: any non-main, non-zygote, non-extensionHost child.
  # Always exclude PTY Host (identified by PID from find_pty_host_pid).
  # Other utility processes (Shared Process, File Watcher, Network Service)
  # are safe to kill — they auto-restart. (#80)
  if [[ -z "$line" ]]; then
    line=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,rss=,args= 2>/dev/null \
      | awk -v skip="$skip_type" -v prot="$protect_tsserver" -v ls="$protect_langservers" -v pty_host="$pty_host" -v md="$mode" '
        function classify(a) {
          if (a ~ /tsserver\.js/)      return "tsserver"
          if (a ~ /htmlServerMain/)     return "html-server"
          if (a ~ /serverWorkerMain/)   return "markdown-server"
          if (a ~ /cssServerMain/)      return "css-server"
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
          if (md != "critical" && args ~ /--type=utility/ && args ~ /--inspect-port/) next;
          if (pid == pty_host) next;
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
      | awk -v prot="$protect_tsserver" -v ls="$protect_langservers" -v pty_host="$pty_host" -v md="$mode" '{
          pid=$1; rss=$2;
          $1=""; $2=""; sub(/^[[:space:]]+/, "", $0); args=$0;
          if (args ~ /^\/usr\/share\/code\/code$/) next;
          if (args ~ /--type=zygote/) next;
          if (args ~ /--type=gpu-process/) next;
          if (args ~ /--type=extensionHost/) next;
          if (md != "critical" && args ~ /--type=utility/ && args ~ /--inspect-port/) next;
          if (pid == pty_host) next;
          if (prot == "true" && args ~ /tsserver\.js/) next;
          if (ls == "true" && (args ~ /htmlServerMain/ || args ~ /serverWorkerMain/ || args ~ /cssServerMain/ || args ~ /jsonServerMain/ || args ~ /eslintServer/)) next;
          printf "%s %s %s\n", pid, rss, args;
        }' | sort -k2 -rn | head -1)
    [[ -n "$line" ]] && log "  Anti-respawn: no alternative found — re-using last-killed type"
  fi

  if [[ -z "$line" ]]; then
    incr_counter _helper_restart_no_candidate
    if (( _helper_no_candidate_suppressed == 0 )); then
      log "  No VS Code helper candidate found (subsequent identical results suppressed)"
    fi
    _helper_no_candidate_suppressed=$(( _helper_no_candidate_suppressed + 1 ))
    return 1
  fi
  # Reset suppression counter on successful candidate find
  if (( _helper_no_candidate_suppressed > 0 )); then
    log "  Helper candidate found after ${_helper_no_candidate_suppressed} suppressed no-candidate polls"
    _helper_no_candidate_suppressed=0
  fi

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
    return 0
  fi
  incr_counter _helper_restart_failures
  return 1
}

kill_vscode_main() {
  local reason="$1"
  local now
  now=$(date +%s)

  action_budget_allows "critical" || return 1

  if (( now - _last_vscode_main_restart < CODE_RECOVERY_COOLDOWN )); then
    log "  VS Code main restart cooldown active (${CODE_RECOVERY_COOLDOWN}s) — skipping"
    return 1
  fi

  local line pid args
  line=$(ps -C "$TIER_PROTECTED_PNAME" -o pid=,args= 2>/dev/null \
    | awk '{ pid=$1; $1=""; sub(/^[[:space:]]+/, "", $0); args=$0; if (args ~ /^\/usr\/share\/code\/code$/) { print pid " " args; exit } }')
  if [[ -z "$line" ]]; then
    log "  kill_vscode_main: no VS Code main process found"
    return 1
  fi

  pid=$(echo "$line" | awk '{print $1}')
  args=$(echo "$line" | cut -d' ' -f2-)

  record_action
  incr_counter _vscode_main_restart_events
  log "ACTION(SIGTERM): ${reason} — restarting VS Code main PID ${pid}: ${args}"
  if $DRY_RUN; then
    _last_vscode_main_restart=$now
    return 0
  fi

  if kill -TERM "$pid" 2>/dev/null; then
    _last_vscode_main_restart=$now
    return 0
  fi
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
        log "VS Code startup: ${new_count} new PIDs — startup mode active for ${STARTUP_DURATION}s (${STARTUP_INTERVAL}s interval)"
        # Pre-emptively SIGTERM Chrome to free memory before extensions load
        if pgrep -f "$TIER_DISPOSABLE_PATTERN" &>/dev/null; then
          log "  Startup mode: pre-emptively SIGTERMing Chrome to free memory"
          kill_disposable_processes "TERM" "VS Code startup: freeing memory before extension load"
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
    log "RESTART-LOOP: VS Code restarted ${count}x in ${RESTART_LOOP_WINDOW_S}s — SIGKILL disposable processes + ${RESTART_LOOP_COOLDOWN_S}s cooldown"
    notify_desktop "crit" "🔄 VS Code Restart Loop"       "VS Code restarted ${count}x in $((RESTART_LOOP_WINDOW_S/60)) min. Force-killing disposable processes to break loop."
    kill_disposable_processes "KILL" "restart-loop: ${count} restarts/${RESTART_LOOP_WINDOW_S}s"
  fi
}

# ── Automation session detection (Issue #109/#140) ──────────────────────────
# Returns 0 (true) if a configured automation orchestrator process is running.
# When active, disposable processes are being used for automation work —
# the DISPOSABLE-EXCESS cap and non-critical kill_disposable_processes calls
# must defer. Stage 4 still kills disposable processes regardless (safety net).
automation_session_active() {
  pgrep -f "$TIER_DISPOSABLE_PATTERN_AUX" &>/dev/null
}

# ── Disposable process count cap (Issue #26/#140) ───────────────────────────
# Count disposable process PIDs. SIGKILL oldest processes above
# DISPOSABLE_COUNT_MAX. Skipped when automation is active.
check_disposable_cap() {
  # Issue #109: active automation needs its disposable processes.
  # The RSS/pressure paths still protect against genuine memory emergencies.
  if automation_session_active; then
    return
  fi
  local disposable_pids=()
  mapfile -t disposable_pids < <(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | sort -n)
  local count=${#disposable_pids[@]}
  if (( count > DISPOSABLE_COUNT_MAX )); then
    local excess=$(( count - DISPOSABLE_COUNT_MAX ))
    incr_counter _chrome_excess_events
    log "DISPOSABLE-EXCESS: ${count} disposable PIDs (cap=${DISPOSABLE_COUNT_MAX}) — SIGKILL ${excess} oldest"
    notify_desktop "warn" "⚠️ Disposable Accumulation: ${count}"       "Disposable process count (${count}) exceeds cap (${DISPOSABLE_COUNT_MAX}). Killing ${excess} oldest."
    local i=0
    for pid in "${disposable_pids[@]}"; do
      (( i >= excess )) && break
      if $DRY_RUN; then
        log "  (dry-run: would SIGKILL disposable PID ${pid})"
      else
        kill -9 "$pid" 2>/dev/null && log "  → SIGKILL disposable PID ${pid} (excess accumulation)"
      fi
      (( i++ ))
    done
  fi
}

# ── cgroup memory path discovery (v2 preferred, v1 fallback) ─────────────────
# Probes for cgroup v2 first (memory.high + memory.reclaim), then falls back to
# cgroup v1 (memory.soft_limit_in_bytes + memory.force_empty).
# Sets: _cgroup_mem_path, _cgroup_version. Empty path = cgroup writes disabled.
discover_cgroup_mem_path() {
  # ── Try cgroup v2 ──────────────────────────────────────────────────────
  local v2_root
  v2_root=$(awk '$3=="cgroup2"{print $2; exit}' /proc/mounts 2>/dev/null)
  if [[ -n "$v2_root" ]]; then
    local v2_rel
    v2_rel=$(awk -F: '$1=="0"{print $3; exit}' /proc/self/cgroup 2>/dev/null)
    local v2_path="${v2_root}${v2_rel}"
    if [[ -d "$v2_path" ]] && [[ -f "$v2_path/memory.high" ]]; then
      if sudo -n test -w "$v2_path/memory.high" 2>/dev/null; then
        _cgroup_mem_path="$v2_path"
        _cgroup_version="v2"
        local features="memory.high"
        [[ -f "$v2_path/memory.reclaim" ]] && features="${features} + memory.reclaim"
        log "cgroup: v2 path discovered: $v2_path ($features available)"
        return
      fi
      log "cgroup: v2 path $v2_path found but memory.high not writable — trying v1"
    fi
  fi

  # ── Try cgroup v1 ──────────────────────────────────────────────────────
  local rel
  rel=$(awk -F: '$2=="memory"{print $3; exit}' /proc/self/cgroup 2>/dev/null)
  if [[ -z "$rel" ]]; then
    log "cgroup: no v2 mount and no v1 memory controller — cgroup writes disabled"
    return
  fi
  local path="/sys/fs/cgroup/memory${rel}"
  if [[ ! -d "$path" ]]; then
    log "cgroup: v1 path $path does not exist — cgroup writes disabled"
    return
  fi
  if ! sudo -n test -w "$path/memory.soft_limit_in_bytes" 2>/dev/null; then
    log "cgroup: sudo -n cannot write to $path/memory.soft_limit_in_bytes — cgroup writes disabled"
    return
  fi
  _cgroup_mem_path="$path"
  _cgroup_version="v1"
  log "cgroup: v1 path discovered: $path (soft_limit + force_empty available)"
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

# ── cgroup throttle: memory.high (v2) or memory.soft_limit_in_bytes (v1) ─────
# Creates kernel reclaim pressure without hard-killing anything.
# v2: memory.high triggers transparent reclaim + allocation stalls.
# v1: memory.soft_limit_in_bytes creates reclaim pressure under global pressure.
cgroup_throttle() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  local total_kb limit_kb limit_bytes
  total_kb=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
  [[ -z "$total_kb" ]] && return 1
  limit_kb=$(( total_kb * STAGE2_SOFT_LIMIT_PCT / 100 ))
  limit_bytes=$(( limit_kb * 1024 ))

  if [[ "$_cgroup_version" == "v2" ]]; then
    if $DRY_RUN; then
      log "  (dry-run: would write ${limit_bytes} to memory.high)"
      _soft_limit_active=true
      return 0
    fi
    if echo "$limit_bytes" | sudo -n tee "$_cgroup_mem_path/memory.high" > /dev/null 2>&1; then
      log "  cgroup: memory.high set to ${limit_kb} kB (${STAGE2_SOFT_LIMIT_PCT}% of total)"
      _soft_limit_active=true
      return 0
    fi
    log "  cgroup: failed to write memory.high"
    return 1
  fi

  # v1 fallback
  if $DRY_RUN; then
    log "  (dry-run: would write ${limit_bytes} to memory.soft_limit_in_bytes)"
    _soft_limit_active=true
    return 0
  fi
  if echo "$limit_bytes" | sudo -n tee "$_cgroup_mem_path/memory.soft_limit_in_bytes" > /dev/null 2>&1; then
    log "  cgroup: memory.soft_limit_in_bytes set to ${limit_kb} kB (${STAGE2_SOFT_LIMIT_PCT}% of total)"
    _soft_limit_active=true
    return 0
  fi
  log "  cgroup: failed to write memory.soft_limit_in_bytes"
  return 1
}

# ── cgroup reclaim: memory.reclaim (v2, kernel 5.19+) or memory.force_empty (v1)
# v2: requests asynchronous page reclaim (256 MB default). Logs pre/post delta.
# v1: triggers synchronous kernel reclaim of reclaimable pages from the cgroup.
RECLAIM_BYTES=${RECLAIM_BYTES:-$((256 * 1024 * 1024))}  # 256 MB default
cgroup_reclaim() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  local now
  now=$(date +%s)
  if (( now - _last_reclaim_action_time < RECLAIM_MIN_INTERVAL_S )); then
    log "  cgroup: reclaim skipped — last reclaim $(( now - _last_reclaim_action_time ))s ago (<${RECLAIM_MIN_INTERVAL_S}s)"
    return 1
  fi

  if [[ "$_cgroup_version" == "v2" ]]; then
    if $DRY_RUN; then
      log "  (dry-run: would write ${RECLAIM_BYTES} to memory.reclaim)"
      _last_reclaim_action_time=$now
      return 0
    fi
    if [[ -f "$_cgroup_mem_path/memory.reclaim" ]]; then
      local pre_avail
      pre_avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
      if echo "$RECLAIM_BYTES" | timeout "${RECLAIM_TIMEOUT_S}s" sudo -n tee "$_cgroup_mem_path/memory.reclaim" > /dev/null 2>&1; then
        _last_reclaim_action_time=$now
        # Allow kswapd to run before re-reading
        sleep 1 & _sleep_pid=$!; wait "$_sleep_pid" || true
        local post_avail
        post_avail=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
        local delta_kb=$(( ${post_avail:-0} - ${pre_avail:-0} ))
        log "  cgroup: memory.reclaim ${RECLAIM_BYTES}B — freed ~${delta_kb} kB (${pre_avail}→${post_avail} kB)"
        return 0
      fi
      local rc=$?
      if (( rc == 124 )); then
        log "  cgroup: memory.reclaim timed out after ${RECLAIM_TIMEOUT_S}s — skipping to preserve watchdog loop"
        return 1
      fi
      log "  cgroup: memory.reclaim write failed (kernel may not support it)"
    else
      log "  cgroup: memory.reclaim not available (requires kernel 5.19+)"
    fi
    # v2 without memory.reclaim — fall through to force_empty if v1 path exists
    [[ ! -f "$_cgroup_mem_path/memory.force_empty" ]] && return 1
    log "  cgroup: v2 reclaim unavailable — falling back to force_empty"
  fi

  # v1 path (or v2 fallback)
  if $DRY_RUN; then
    log "  (dry-run: would write 0 to memory.force_empty)"
    _last_reclaim_action_time=$now
    return 0
  fi
  if echo 0 | timeout "${RECLAIM_TIMEOUT_S}s" sudo -n tee "$_cgroup_mem_path/memory.force_empty" > /dev/null 2>&1; then
    _last_reclaim_action_time=$now
    log "  cgroup: memory.force_empty triggered — kernel reclaiming pages"
    return 0
  fi
  local rc=$?
  if (( rc == 124 )); then
    log "  cgroup: memory.force_empty timed out after ${RECLAIM_TIMEOUT_S}s — reclaim skipped to keep watchdog responsive"
    return 1
  fi
  log "  cgroup: failed to write memory.force_empty"
  return 1
}

# ── cgroup throttle release: reset memory.high (v2) or soft_limit (v1) ───
cgroup_release_throttle() {
  [[ -z "$_cgroup_mem_path" ]] && return 1
  $_soft_limit_active || return 0  # nothing to release

  if [[ "$_cgroup_version" == "v2" ]]; then
    if $DRY_RUN; then
      log "  (dry-run: would reset memory.high to max)"
      _soft_limit_active=false
      return 0
    fi
    if echo max | sudo -n tee "$_cgroup_mem_path/memory.high" > /dev/null 2>&1; then
      log "  cgroup: memory.high reset to max (throttle released)"
      _soft_limit_active=false
      return 0
    fi
    return 1
  fi

  # v1 fallback
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

# ── Read cgroup event counters (Issue #12) ──────────────────────────────────
# v2: memory.events.local has: low, high, max, oom, oom_kill, oom_group_kill
# v1: memory.oom_control has: oom_kill_disable, under_oom, oom_kill
#     memory.failcnt has: single integer (times limit was hit)
# Detects oom_kill delta > 0 and emits CRIT alert + desktop notification.
read_cgroup_events() {
  [[ -z "$_cgroup_mem_path" ]] && return

  _prev_cg_oom_kill=$_cg_oom_kill

  if [[ "$_cgroup_version" == "v2" ]]; then
    local events_file="$_cgroup_mem_path/memory.events.local"
    if [[ -r "$events_file" ]]; then
      local line
      while IFS= read -r line; do
        case "$line" in
          high\ *)     _cg_high_events=${line#high }  ;;
          max\ *)      _cg_failcnt=${line#max }       ;;
          oom_kill\ *) _cg_oom_kill=${line#oom_kill }  ;;
        esac
      done < "$events_file"
    fi
  else
    # v1: memory.failcnt (single integer)
    local fc_file="$_cgroup_mem_path/memory.failcnt"
    if [[ -r "$fc_file" ]]; then
      read -r _cg_failcnt < "$fc_file" 2>/dev/null || _cg_failcnt=0
    fi
    # v1: memory.oom_control (oom_kill_disable, under_oom, oom_kill)
    local oc_file="$_cgroup_mem_path/memory.oom_control"
    if [[ -r "$oc_file" ]]; then
      local line
      while IFS= read -r line; do
        case "$line" in
          oom_kill\ *)  _cg_oom_kill=${line#oom_kill }   ;;
          under_oom\ *) _cg_under_oom=${line#under_oom } ;;
        esac
      done < "$oc_file"
    fi
  fi

  # ── oom_kill delta detection ───────────────────────────────────────────
  if (( _cg_oom_kill > _prev_cg_oom_kill )); then
    local delta=$(( _cg_oom_kill - _prev_cg_oom_kill ))
    log "CRIT: kernel OOM kill detected in cgroup — oom_kill counter ${_prev_cg_oom_kill}→${_cg_oom_kill} (+${delta})"
    notify_desktop "crit" "💀 Kernel OOM Kill" "${delta} process(es) killed by cgroup OOM (total: ${_cg_oom_kill})"
    log_status_snapshot "oom_kill"
  fi

  # ── under_oom alert (v1 only) ──────────────────────────────────────────
  if [[ "$_cgroup_version" == "v1" ]] && (( _cg_under_oom > 0 )); then
    log "WARN: cgroup under_oom=1 — kernel OOM handler is active right now"
  fi
}

# ── Workspace chat session footprint warning (Issue #153) ───────────────────
# Extension guard runs every 60s and can miss fast session-load spikes when
# switching workspaces. This startup scan emits an early warning if any
# workspaceStorage/*/chatSessions footprint is already oversized.
scan_workspace_chat_footprint() {
  local ws_root="${XDG_CONFIG_HOME:-${HOME}/.config}/Code/User/workspaceStorage"
  [[ -d "$ws_root" ]] || return 0

  local warn_bytes=$(( CHAT_WARN_MB * 1024 * 1024 ))
  local warned=0
  local ws_dir

  shopt -s nullglob
  for ws_dir in "$ws_root"/*; do
    [[ -d "$ws_dir/chatSessions" ]] || continue

    local total_bytes=0
    local file_count=0
    local chat_file
    for chat_file in "$ws_dir"/chatSessions/*.json; do
      [[ -f "$chat_file" ]] || continue
      local size_bytes
      size_bytes=$(stat -c%s "$chat_file" 2>/dev/null || echo 0)
      total_bytes=$(( total_bytes + size_bytes ))
      file_count=$(( file_count + 1 ))
    done

    (( file_count == 0 )) && continue
    if (( total_bytes >= warn_bytes )); then
      warned=1
      local ws_id ws_hint
      ws_id="${ws_dir##*/}"
      ws_hint="unknown"
      if [[ -r "$ws_dir/workspace.json" ]]; then
        ws_hint=$(awk -F'"' '/"folder"[[:space:]]*:/{print $4; exit}' "$ws_dir/workspace.json" 2>/dev/null)
        [[ -z "$ws_hint" ]] && ws_hint=$(awk -F'"' '/"workspace"[[:space:]]*:/{print $4; exit}' "$ws_dir/workspace.json" 2>/dev/null)
        [[ -z "$ws_hint" ]] && ws_hint="unknown"
      fi
      log "WARN: chat session storage high — workspace_id=${ws_id} chat_json_mb=$(( total_bytes / 1024 / 1024 )) files=${file_count} source=${ws_hint}"
    fi
  done
  shopt -u nullglob

  if (( warned > 0 )); then
    notify_desktop "warn" "⚠️ Oversized Chat Sessions Detected" \
      "One or more VS Code workspaces have chatSessions footprint ≥ ${CHAT_WARN_MB} MB. Consider archive rescue before opening those workspaces."
  fi
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
# Stage 4 and SIGKILL callers pass mode="critical" to bypass.
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

# Discover cgroup memory path for Stage 2/3 interventions (Issues #4, #7, #8)
discover_cgroup_mem_path

log "Started (4-stage model: S1≤${STAGE1_MEM_PCT}%/PSIsome>${STAGE1_PSI_SOME_X100}, S2≤${STAGE2_MEM_PCT}%/PSIsome>${STAGE2_PSI_SOME_X100}, S3≤${STAGE3_MEM_PCT}%/PSIfull>${STAGE3_PSI_FULL_X100}, S4≤${STAGE4_MEM_PCT}%/PSIfull>${STAGE4_PSI_FULL_X100}, oom_adj code=${OOM_VSCODE_ADJ} chrome=+${OOM_CHROME_ADJ}, cgroup=${_cgroup_version:-disabled})"
$DRY_RUN && log "DRY-RUN mode — no processes will be killed"
$_legacy_chrome_cap_alias_used && log "CONFIG: CHROME_COUNT_MAX is deprecated; use DISPOSABLE_COUNT_MAX (legacy alias accepted for this release)"

# Apply OOM scores immediately at startup before the first loop iteration
adjust_oom_scores

# Log tier assignments at startup for diagnostics (Issue #6)
log_tier_assignments

# Startup early warning for cross-workspace oversized chat sessions (Issue #153)
scan_workspace_chat_footprint

while true; do
  incr_counter _loops
  _action_taken=false

  # ── Determine effective thresholds and whether we're in startup mode ────────
  local_now=$(date +%s)
  if (( local_now < _startup_mode_end )); then
    in_startup=true
    eff_interval=$STARTUP_INTERVAL
  else
    in_startup=false
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

  # ── Read managed window signal file (Issue #139) ──────────────────────────
  # Zero-fork: bash `read` builtin reads the mode file directly — no subprocess.
  now=$(date +%s)
  _watchdog_mode=""
  if [[ -f "$_MODE_FILE" ]]; then
    read -r _watchdog_mode < "$_MODE_FILE" 2>/dev/null || _watchdog_mode=""
  fi
  if [[ "$_watchdog_mode" == "SLEEP" ]]; then
    if (( _mode_sleep_start == 0 )); then
      _mode_sleep_start=$now
    elif (( now - _mode_sleep_start >= MEM_SLEEP_TIMEOUT_S )); then
      log "MODE: SLEEP stale for $(( now - _mode_sleep_start ))s (timeout=${MEM_SLEEP_TIMEOUT_S}s) — auto-clearing mode file"
      if ! $DRY_RUN; then
        rm -f "$_MODE_FILE" 2>/dev/null || true
      fi
      _watchdog_mode=""
      _mode_sleep_start=0
    fi
  else
    _mode_sleep_start=0
  fi
  if [[ "$_watchdog_mode" == "SLEEP" && "$_last_logged_mode" != "SLEEP" ]]; then
    log "MODE: SLEEP — managed protection window active; all kill/reclaim actions deferred"
    _last_logged_mode="SLEEP"
  elif [[ "$_watchdog_mode" != "SLEEP" && "$_last_logged_mode" == "SLEEP" ]]; then
    log "MODE: NORMAL — managed protection window cleared; resuming normal operation"
    _last_logged_mode=""
  fi

  # ── Restart-loop and Chrome-cap checks ───────────────────────────────────
  check_restart_loop
  # Chrome-cap check skipped in SLEEP mode — during managed windows (e.g., a
  # Playwright automation run), Chrome PID counts are legitimately elevated.
  [[ "${_watchdog_mode}" != "SLEEP" ]] && check_disposable_cap

  # Read MemAvailable and MemTotal.
  # IMPORTANT: Never use SwapFree — Crostini kernel has historically reported
  # ~18.4 exabytes (uint64 overflow sentinel). Current kernel reports 0 kB, but
  # the value is unreliable across versions. See docs/technical/crostini-swap-reality.md.
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

  # ── Cgroup event counters (Issue #12) ──────────────────────────────────────
  # Read memory.events.local (v2) or memory.oom_control + memory.failcnt (v1).
  # Detects kernel OOM kills via oom_kill counter delta → CRIT alert.
  read_cgroup_events

  # ── Chrome detection (needed for stage actions) ─────────────────────────
  disposable_running=$(pgrep -f "$TIER_DISPOSABLE_PATTERN" 2>/dev/null | head -1)
  vscode_rss_kb=$(sum_vscode_rss_kb)
  rss_delta_kb=0
  if (( _last_vscode_rss_kb > 0 && vscode_rss_kb > _last_vscode_rss_kb )); then
    rss_delta_kb=$(( vscode_rss_kb - _last_vscode_rss_kb ))
  fi

  # ── 4-stage pressure evaluation (Issue #4) ──────────────────────────────
  # Graduated response based on MemAvailable % and PSI pressure.
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
  # SLEEP mode: skip all kills and cgroup reclaim. The daemon keeps monitoring
  # so pressure stage tracking stays current and it resumes the moment the mode
  # file is removed or its content changes to anything other than 'SLEEP'.
  if [[ "${_watchdog_mode}" != "SLEEP" ]]; then
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
        # Kill gate: PSI-only triggers (pct above stage threshold) get cgroup
        # throttle above but NO process kills.  After an OOM recovery, PSI avg10
        # stays elevated for ~10 s while memory has already recovered to 70-80%+.
        # Killing Chrome at 70% free wastes browser state for zero benefit.
        if (( pct > STAGE2_MEM_PCT )); then
          log "  Stage 2 PSI-only trigger (pct=${pct}% > ${STAGE2_MEM_PCT}%) — cgroup throttle applied, kills skipped"
        elif [[ -n "$disposable_running" ]]; then
          incr_counter _low_mem_term_events
          notify_desktop "warn" "⚠️ Memory Pressure Stage 2: ${pct}% free" \
            "Throttling memory + terminating Chrome. PSI some=$(( psi_some_x100 / 100 )).$(( psi_some_x100 % 100 ))%"
          # Issue #109: if kill_disposable_processes defers (automation active), cgroup throttle
          # above is already applied — no further action needed at Stage 2.
          kill_disposable_processes "TERM" "Stage 2 throttle: pct=${pct}% psi_some=${psi_some_x100}"
        fi
      fi
      ;;
    3)
      # Stage 3 — Reclaim: force_empty + SIGTERM Chrome + helpers
      _recovery_clean_count=0
      _pressure_active=true
      if kill_cooldown_allows "normal"; then
        reclaim_applied=false
        if cgroup_reclaim; then
          reclaim_applied=true
        fi
        # Kill gate: PSI-only triggers (pct above stage threshold) get cgroup
        # reclaim above but NO process kills.  After an OOM recovery, PSI avg10
        # stays elevated for ~10 s while memory has already recovered to 70-80%+.
        # Killing NetworkService (10 MB) at 83% free is harmful and pointless.
        if (( pct > STAGE3_MEM_PCT )); then
          if $reclaim_applied; then
            log "  Stage 3 PSI-only trigger (pct=${pct}% > ${STAGE3_MEM_PCT}%) — cgroup reclaim applied, kills skipped"
          else
            log "  Stage 3 PSI-only trigger (pct=${pct}% > ${STAGE3_MEM_PCT}%) — cgroup reclaim unavailable/skipped, kills skipped"
          fi
        else
          incr_counter _low_mem_term_events
          notify_desktop "warn" "⚠️ Memory Pressure Stage 3: ${pct}% free" \
            "Reclaiming pages + terminating Chrome. PSI full=$(( psi_x100 / 100 )).$(( psi_x100 % 100 ))%"
          if [[ -n "$disposable_running" ]]; then
            # Issue #109: if kill_disposable_processes defers (automation active), fall through
            # to helper kill just like the no-Chrome path.
            if ! kill_disposable_processes "TERM" "Stage 3 reclaim: pct=${pct}% psi_full=${psi_x100}"; then
              if ! kill_top_vscode_helper "Stage 3: Chrome deferred (pct=${pct}%, psi_full=${psi_x100})"; then
                kill_nonessential_apps "Stage 3: no candidate (pct=${pct}%, psi_full=${psi_x100})"
              fi
            fi
          else
            if ! kill_top_vscode_helper "Stage 3: no Chrome (pct=${pct}%, psi_full=${psi_x100})"; then
              kill_nonessential_apps "Stage 3: no candidate, no Chrome (pct=${pct}%, psi_full=${psi_x100})"
            fi
          fi
        fi
      fi
      ;;
    4)
      # Stage 4 — Terminate: SIGKILL disposable targets; if none remain,
      # escalate to critical helper kills instead of lying about kernel OOM protection.
      _recovery_clean_count=0
      _pressure_active=true
      incr_counter _critical_kill_events
      notify_desktop "crit" "🚨 Critical Memory Stage 4: ${pct}% free" \
        "Force-killing Chrome/Playwright.\nClose ChromeOS tabs if crash persists."
      if [[ -n "$disposable_running" ]]; then
        kill_disposable_processes "KILL" "Stage 4 terminate: pct=${pct}% psi_full=${psi_x100}" "critical"
      else
        log "Stage 4: no disposable target — escalating to critical VS Code helper kill path"
        if ! kill_top_vscode_helper "Stage 4: no disposable target (pct=${pct}%, psi_full=${psi_x100})" "critical"; then
          log "Stage 4: no critical helper candidate found — awaiting RSS circuit breaker or recovery"
        fi
      fi
      ;;
  esac
  fi # end SLEEP mode gate (Issue #139)

  # ── RSS circuit breaker — catch VS Code self-ballooning before kernel OOM ──
  if [[ "${_watchdog_mode}" != "SLEEP" ]]; then
    if (( vscode_rss_kb >= VSCODE_RSS_EMERG_KB )); then
      incr_counter _rss_emerg_events
      log "RSS-EMERG: vscode_rss_kb=${vscode_rss_kb} (threshold=${VSCODE_RSS_EMERG_KB}) pct=${pct}% psi_full=${psi_x100}"
      if [[ -z "$disposable_running" ]]; then
        if ! kill_top_vscode_helper "RSS emergency: rss=${vscode_rss_kb}kB pct=${pct}% psi_full=${psi_x100}" "critical"; then
          kill_vscode_main "RSS emergency circuit-breaker: rss=${vscode_rss_kb}kB pct=${pct}% psi_full=${psi_x100}"
        fi
      fi
    elif (( vscode_rss_kb >= VSCODE_RSS_WARN_KB && rss_delta_kb >= RSS_ACCEL_KB )); then
      incr_counter _rss_warn_events
      if kill_cooldown_allows "normal"; then
        log "RSS-WARN: vscode_rss_kb=${vscode_rss_kb} delta_kb=${rss_delta_kb} (warn=${VSCODE_RSS_WARN_KB}, accel=${RSS_ACCEL_KB})"
        if [[ -n "$disposable_running" ]]; then
          kill_disposable_processes "TERM" "RSS warn: rss=${vscode_rss_kb}kB delta=${rss_delta_kb}kB"
        else
          kill_top_vscode_helper "RSS warn: rss=${vscode_rss_kb}kB delta=${rss_delta_kb}kB"
        fi
      fi
    fi
  fi

  # ── Recovery confirmation (Issues #4, #5) ─────────────────────────────────
  # When ALL conditions are clear: stage 0 (below all stage thresholds)
  # and recovery quality thresholds met — count clean polls.
  # At RECOVERY_POLLS, release cgroup throttle, log recovery, reset tracking.
  if (( _pressure_stage == 0 )); then
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
    _last_vscode_rss_kb=$vscode_rss_kb
    sleep "$eff_interval" & _sleep_pid=$!
    wait "$_sleep_pid" || true
  fi
done
