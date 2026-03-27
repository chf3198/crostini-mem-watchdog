# Changelog

All notable changes to the **crostini-mem-watchdog** daemon are documented here.
For VS Code extension changes, see [vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Daemon versions use `YYYYMMDD.N` (datestamp + revision).

## [Unreleased]

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
