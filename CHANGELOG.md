# Changelog

All notable changes to the **crostini-mem-watchdog** daemon are documented here.
For VS Code extension changes, see [vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Daemon versions use `YYYYMMDD.N` (datestamp + revision).

## [Unreleased]

### Added
- **Interactive non-critical kill approval handshake** ([#157](https://github.com/chf3198/crostini-mem-watchdog/issues/157)) — daemon now supports an operator-in-the-loop gate for non-critical `kill_disposable_processes()` actions via `~/.config/mem-watchdog/kill-approval-request` and `kill-approval-response`. When enabled, the daemon requests approval, waits for extension response up to `INTERACTIVE_KILL_PROMPT_TTL_S`, and honors `defer` responses with bounded cooldown (`INTERACTIVE_KILL_DEFER_DEFAULT_S`). Critical paths remain ungated.
- **Repo-agnostic managed-window helper** ([#146](https://github.com/chf3198/crostini-mem-watchdog/issues/146)) — added `scripts/mem-watchdog-mode.sh` with `status|sleep|normal|run -- <command>` so any repository/workflow can request watchdog `mode=SLEEP` without embedding custom integration code. Installer now deploys it to `~/.local/bin/mem-watchdog-mode.sh`.
- **Truthful Stage 4 escalation + RSS circuit-breaker** ([#148](https://github.com/chf3198/crostini-mem-watchdog/issues/148)) — when no disposable target exists, Stage 4 now escalates to critical VS Code helper kills instead of claiming kernel OOM will protect VS Code. Added aggregate VS Code RSS warn/emergency thresholds and a controlled `kill_vscode_main()` circuit-breaker to restart the window before a kernel OOM loop hard-kills random `code` processes.
- **Startup chat footprint warning scan** ([#153](https://github.com/chf3198/crostini-mem-watchdog/issues/153)) — daemon now scans `~/.config/Code/User/workspaceStorage/*/chatSessions/` at startup and emits WARN notifications when any workspace already exceeds `CHAT_WARN_MB` (default 200 MB), giving pre-open visibility into cross-workspace session-load OOM risk.

### Changed
- **Automation detection broadened for Playwright MCP / Claude visualization workflows** — `TIER_DISPOSABLE_PATTERN_AUX` now defaults to `(node|python|claude).*(playwright|puppeteer|cypress|selenium-webdriver|mcp|vision|visualization)` so active automation sessions are recognized reliably before `DISPOSABLE-EXCESS` cap enforcement.
- **Stack-agnostic disposable naming refactor** ([#140](https://github.com/chf3198/crostini-mem-watchdog/issues/140)) — daemon internals now use `kill_disposable_processes()`, `check_disposable_cap()`, `automation_session_active()`, and `DISPOSABLE_COUNT_MAX` naming. Legacy `CHROME_COUNT_MAX` remains accepted as a one-release alias with startup deprecation warning.
- **Journal token rename (breaking for log parsers)** — `CHROME-EXCESS` → `DISPOSABLE-EXCESS`.
- **Default automation fallback pattern broadened** — `TIER_DISPOSABLE_PATTERN_AUX` default now includes common Node automation frameworks: `playwright|puppeteer|cypress|selenium-webdriver`.
- **Managed-window stale-timeout guard** ([#138](https://github.com/chf3198/crostini-mem-watchdog/issues/138)) — `MEM_SLEEP_TIMEOUT_S` (default 300s) now auto-clears stale `mode=SLEEP` signals and logs a warning when the caller fails to clean up.
- **Status snapshots now log RSS runway context** — `STATUS(...)` lines include `rss_delta_kb`, `rss_warn_kb`, `rss_emerg_kb`, RSS warn/emergency event counters, and controlled VS Code main restart counts for post-incident forensics.

## [20260331.1] — 2026-03-31

### Added
- **Managed window signal file protocol** ([#139](https://github.com/chf3198/crostini-mem-watchdog/issues/139)) — external callers (e.g., publish scripts) write `SLEEP` to `~/.config/mem-watchdog/mode` to defer all kills and cgroup reclaim during a protected window. The daemon continues monitoring so it resumes the instant the file is removed. Mode is read via zero-fork `read` builtin each loop; transitions log `MODE: SLEEP / MODE: NORMAL`. `check_chrome_cap` also gated in SLEEP mode. Status snapshots include `mode=` field.

### Fixed
- **PSI-only kill gate** ([Stage 2/3](https://github.com/chf3198/crostini-mem-watchdog/)) — PSI-only triggers (memory has already recovered above the stage threshold) now apply cgroup throttle/reclaim but skip process kills. After an OOM event, PSI avg10 stays elevated ~10 s while MemAvailable is already 70–80%+; killing Chrome at 70% free was wasteful. Kills only fire when `pct` is below the stage threshold.

### Changed
- Test suite expanded from 18 to 19 tests: Test 19 verifies SLEEP mode end-to-end (static checks + live dry-run with mode file).

## [20260327.1] — 2026-03-27

### Fixed
- **Startup burst gate raised to `eff_warn`** ([#99](https://github.com/chf3198/crostini-mem-watchdog/issues/99)) — `STARTUP_BURST_RSS_KB=2200000` (2.2 GB) was 1.28 GB below the actual WARN threshold (config: 3.48 GB). Burst killed VS Code utility processes (Network Service, Shared Process, File Watcher) at 82% free RAM during normal Copilot sessions. Replaced with `eff_warn` gate — burst only fires when RSS is already at WARN level. Aligns with ACCEL gate pattern (#45).

## [20260326.5] — 2026-03-26

### Fixed
- **Process classification gap** ([#80](https://github.com/chf3198/crostini-mem-watchdog/issues/80)) — blanket `--type=utility` exclusion replaced with targeted PTY Host PID exclusion via `find_pty_host_pid()`. `kill_top_vscode_helper("normal")` now has 2–3 candidates (Shared Process, File Watcher, Network Service ≈300 MB) when no Chrome is running.

## [20260326.4] — 2026-03-26

### Fixed
- **Threshold raise for AI workloads** ([#77](https://github.com/chf3198/crostini-mem-watchdog/issues/77)) — WARN 3.0→3.4 GB, EMERG 3.2→3.8 GB, STARTUP_WARN 3.2→3.6 GB, STARTUP_EMERG 3.4→4.0 GB. Copilot Chat multi-agent research legitimately peaks at 3.0–3.5 GB; previous thresholds gave only 300 MB headroom.

## [20260326.3] — 2026-03-26

### Fixed
- **WARN cgroup fallback** ([#74](https://github.com/chf3198/crostini-mem-watchdog/issues/74)) — when no kill candidate exists at WARN, triggers `cgroup_throttle()` + `cgroup_reclaim()` as non-destructive intermediate relief. EMERGENCY resets `_action_taken=false` — non-critical kills cannot block emergency.

## [20260325.8] — 2026-03-25

### Fixed
- **WARN-deferral fix** ([#64](https://github.com/chf3198/crostini-mem-watchdog/issues/64)) — WARN and Stage 3 no longer escalate to `kill_extension_host()`. Defer to EMERGENCY/Stage 4. `VSCODE_RSS_WARN_KB` raised 2.2→3.0 GB. Utility processes excluded at non-emergency in all 3 awk blocks.

## [20260325.5] — 2026-03-25

### Fixed
- **Utility-process detection** ([#55](https://github.com/chf3198/crostini-mem-watchdog/issues/55)) — Extension Host identified by `--type=utility` + `--inspect-port` (VS Code 1.90+ migration). Other utility processes now eligible kill candidates. `kill_extension_host()` finds modern Extension Host.

## [20260325.1] — 2026-03-25

### Fixed
- **Action budget no-op fix** ([#49](https://github.com/chf3198/crostini-mem-watchdog/issues/49)) — no-op `kill_browsers()` no longer exhausts budget. `chrome_running` checked before `kill_browsers`. `STARTUP_BURST_RSS_KB` raised 1.6→2.2 GB.

## [20260324.3] — 2026-03-24

### Fixed
- **Three `kill_top_vscode_helper` bugs** ([#45](https://github.com/chf3198/crostini-mem-watchdog/issues/45), [#46](https://github.com/chf3198/crostini-mem-watchdog/issues/46), [#47](https://github.com/chf3198/crostini-mem-watchdog/issues/47)) — ACCEL path used `"emerg"` mode unconditionally; `json-server` and `eslint` missing from langserver protection; `--type=extensionHost` guard blind to modern VS Code process model.

[Unreleased]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260327.1...HEAD
[20260327.1]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260326.5...v20260327.1
[20260326.5]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260326.4...v20260326.5
[20260326.4]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260326.3...v20260326.4
[20260326.3]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260325.8...v20260326.3
[20260325.8]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260325.5...v20260325.8
[20260325.5]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260325.1...v20260325.5
[20260325.1]: https://github.com/chf3198/crostini-mem-watchdog/compare/v20260324.3...v20260325.1
[20260324.3]: https://github.com/chf3198/crostini-mem-watchdog/releases/tag/v20260324.3
