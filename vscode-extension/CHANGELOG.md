# Changelog

## [0.3.16] — 2026-03-30

### Added
- **V8 memory flags in optimizer** ([#124](https://github.com/chf3198/crostini-mem-watchdog/issues/124)) — `ARGV_PROFILE` `js-flags` entry now includes 4 new flags benchmarked in [#120](https://github.com/chf3198/crostini-mem-watchdog/issues/120) (53% per-isolate RSS reduction, p99 GC < 35ms): `--optimize-for-size`, `--flush-baseline-code`, `--concurrent-turbofan-max-threads=1`, `--concurrent-maglev-max-threads=1`.
- **Per-flag js-flags audit** — `auditArgv()` now diffs individual flags within the compound `js-flags` string. Users with only `--max-old-space-size=2048` will see only the 4 missing flags reported, not the entire string as missing.
- **Flag merge on apply** — `applyArgv()` merges only missing flags into existing `js-flags`, preserving any user-added flags.
- **Per-flag report detail** — `renderReport()` shows each missing flag with savings estimate and rationale from `JS_FLAGS_DETAIL`.
- New helpers exported: `parseJsFlags()`, `diffJsFlags()`, `mergeJsFlags()`, `JS_FLAGS_DETAIL`.

### Tests
- JS unit tests: 128 → **146 passing** (+18 new: js-flags parsing, diffing, merging, partial audit, merge apply, per-flag rendering, profile invariants)

## [0.3.15] — 2026-03-30

### Added
- **Memory optimizer command** — new `Mem Watchdog: Optimize VS Code for Low Memory` command audits `settings.json` and `argv.json` against a 28-setting low-memory profile, reports what's already applied vs. missing, and applies all optimizations with one click. Biggest win: `disable-hardware-acceleration` in `argv.json` saves ~100-200 MB on Crostini (no real GPU).
- **`/memwatchdog optimize` chat command** — same audit/apply flow available via the `@memwatchdog` chat participant.
- **`optimizer.js` module** — new module with `SETTINGS_PROFILE` (28 settings), `ARGV_PROFILE` (2 entries), `auditSettings()`, `auditArgv()`, `applySettings()`, `applyArgv()`, and `renderReport()`. No `vscode` import dependency — receives the API as parameter.

### Tests
- JS unit tests: 98 → **128 passing** (+30 new optimizer tests covering `settingMatches`, `auditSettings`, `auditArgv`, `applyArgv`, `renderReport`, and profile completeness)

## [0.3.14] — 2026-03-30

### Changed
- **Outward-facing kill policy — never kill VS Code** ([#117](https://github.com/chf3198/crostini-mem-watchdog/issues/117)) — critical analysis revealed 0 kernel OOM kills ever vs 17 watchdog-inflicted VS Code kills, with RSS overcounting by 26% (shared Electron pages). The daemon now exclusively targets Chrome, Playwright, and non-essential apps. Stage 4 defers to the kernel OOM killer instead of calling `kill_vscode_main()`.
- **Removed VS Code RSS trigger system** — `kill_vscode_main()`, `kill_extension_host()`, EMERGENCY/WARN/ACCEL/BURST standalone RSS triggers, and all related state variables removed. MemAvailable percentage + PSI pressure are now the sole intervention triggers.
- **Extension settings simplified** — removed `vscodeRssWarnMB` and `vscodeRssEmergencyMB` settings. Config writes 3 variables (SIGTERM/SIGKILL thresholds + PSI) instead of 5.
- **Chat tuning profiles simplified** — profiles now carry `sigterm`/`sigkill` only (no `warn`/`emerg`).
- **Daemon bundle updated to v20260330.1**

### Tests
- JS unit tests: 106 → **98 passing** (RSS-related test blocks removed, remaining tests updated)
- New bash Test 15: "Outward-facing kill policy" validates no kill_vscode_main, no kill_extension_host, kernel OOM deferral present

## [0.3.13] — 2026-03-29

### Fixed
- **Daemon downgrade protection was dead code** ([#112](https://github.com/chf3198/crostini-mem-watchdog/issues/112)) — `watchdogVersion()` regex expected `^WATCHDOG_VERSION=` but the daemon uses `export WATCHDOG_VERSION=`. The regex never matched, both versions returned `0`, and the comparison `0 > 0` always failed — allowing the extension to overwrite a newer daemon with an older bundled version on every activation. This caused the second Playwright-fight-loop crash (2026-03-29 00:45:34): the Playwright-awareness fix (v20260329.1) was deployed at 00:22:55, but the frankspressurewashing window's extension downgraded it to v20260326.5 at 00:33:48.
- **Daemon bundle updated to v20260329.1** — includes Playwright-awareness (`playwright_is_active()`, `check_chrome_cap()` skip, `kill_browsers()` deferral at non-critical severity).

### Tests
- JS unit tests: 105 → **106 passing** (+1 new export-prefix downgrade protection test)
- Existing downgrade and MIN_SAFE tests updated to use real daemon format (`export WATCHDOG_VERSION=...`)

## [0.3.12] — 2026-03-27

### Notes
- v0.3.11 was reserved in the Marketplace API during a partial upload; this release contains the same code as v0.3.11.

## [0.3.11] — 2026-03-27

### Fixed
- **Config-before-restart activation order** ([#95](https://github.com/chf3198/crostini-mem-watchdog/issues/95)) — `activate()` wrote the config file AFTER the daemon restart, causing the daemon to load stale thresholds from the previous session. The daemon ran with WARN=3.0 GB / EMERG=3.4 GB instead of the configured WARN=3.4 GB / EMERG=3.8 GB, leading to a premature `kill_vscode_main` at 3.6 GB. Config is now written BEFORE install/restart, and a config-change-triggered restart ensures the daemon always picks up fresh values.
- **Config change detection** — `writeConfig()` now compares existing file content before writing. Returns `{ warnings, changed }` instead of plain warnings array. Skips unnecessary writes when content is identical; triggers daemon restart only when config actually changed.

### Tests
- JS unit tests: 103 → **105 passing** (+2 new `changed`-flag tests for `writeConfig`)

## [0.3.10] — 2026-03-27

### Fixed
- **Documentation threshold sync** — both READMEs now correctly show WARN 3.4 GB / EMERG 3.8 GB (were showing stale 3.0/3.2 GB from pre-#77 era). Architecture diagrams updated with `updateChecker.js`, `skillInstaller.js`, `chatParticipant.js`. Extension README test count corrected (103). Install-from-source vsix filename made version-agnostic.

### Notes
- v0.3.9 was reserved in the Marketplace API during a partial upload; this release contains the same code plus the docs sync from PR #91.

## [0.3.9] — 2026-03-26

### Fixed
- **Chat participant no longer pins to Chat panel** ([#43](https://github.com/chf3198/crostini-mem-watchdog/issues/43)) — `isSticky: true` in `package.json` caused the `@memwatchdog` chat participant to be permanently pinned in the Chat panel alongside the status bar item, creating the perception of "duplicate IDE info elements." Changed to `isSticky: false` — the participant is now invoked on demand with `@memwatchdog` rather than auto-pinned.

### Tests
- JS unit tests: 100 → **103 passing**
- Added `chatParticipant.test.js`: 2 manifest contract tests — `isSticky: false` regression guard, runtime ID matches `package.json` declaration
- Added `extension.activate.test.js`: 1 idempotency test — verifies exactly 1 status bar item + 1 chat participant registration across repeated `activate()` calls

## [0.3.8] — 2026-03-26

### Added
- **`@memwatchdog` chat participant** (`chatParticipant.js`) — Copilot Chat integration with four slash commands:
  - `/memwatchdog status` — RAM%, VS Code RSS, PSI, service state snapshot
  - `/memwatchdog logs` — last 40 journal lines from the daemon
  - `/memwatchdog tune <profile>` — apply `balanced`, `conservative`, or `playwright` tuning profile
  - `/memwatchdog act <action>` — kill Chrome, restart service, or open dashboard
  - Followup suggestions after each command for natural conversation flow
  - Graceful no-op when Chat API is unavailable (VS Code < 1.93)
- **`chatSkills` contribution** — bundled `skills/mem-watchdog-ops/SKILL.md` enables Copilot to carry watchdog-specific operational context across all repositories
- **User-level Copilot skill installer** (`skillInstaller.js`) — on activation, installs or refreshes `~/.copilot/skills/mem-watchdog-ops/` with SKILL.md and `watchdog-snapshot.sh` helper script
- **Tuning profiles** aligned with daemon v20260326.5 defaults:
  - `balanced`: warn 3.4 GB, emerg 3.8 GB (matches current daemon)
  - `conservative`: warn 3.0 GB, emerg 3.4 GB (earlier intervention)
  - `playwright`: warn 3.8 GB, emerg 4.2 GB (headroom for automation)

### Tests
- JS unit tests: 75 → **100 passing**
- Added `chatParticipant.test.js` — 20 tests covering detectProfile, applyProfile, all 4 requestHandler commands (/status, /logs, /tune, /act), null meminfo, followup providers, chat API unavailable
- Added `skillInstaller.test.js` — 3 tests covering install/update/skip states and executable permissions

## [0.3.7] — 2026-03-25

### Fixed
- **Bundled daemon upgraded to v20260325.8** — fixes three bugs in v20260325.6 that caused VS Code process kills during normal operation at 65–80% free memory:
  1. **WARN→ExtHost escalation removed** ([#64](https://github.com/chf3198/crostini-mem-watchdog/issues/64)) — WARN and Stage 3 fallback paths escalated to `kill_extension_host()` when `kill_top_vscode_helper` found no candidate, destroying terminal, Copilot, and all extensions at non-emergency RSS (2.7 GB, 76% free). Now logs and defers to EMERGENCY/Stage 4.
  2. **Fallback awk `classify` missing language server types** — `serverWorkerMain` (markdown), `htmlServerMain`, and `cssServerMain` were not classified in the fallback/last-resort awk blocks, causing them to bypass language server protection. Markdown servers were killed 11× in a 2-hour session.
  3. **Utility processes (PTY host, shared process, file watcher) killed at WARN level** — these processes are indistinguishable by cmdline, and killing the PTY host destroys VS Code's terminal; killing the shared process shows "A shared background process terminated unexpectedly." Now only killable at EMERG severity where the alternative is kernel OOM.
- **`VSCODE_RSS_WARN_KB` raised from 2.2 GB to 3.0 GB** — previous threshold was below the system's normal 2.3–2.7 GB baseline, causing WARN to fire constantly during normal operation.
- **`STARTUP_RSS_WARN_KB` raised from 2.8 GB to 3.2 GB** — keeps startup WARN above normal-mode WARN.
- **`MIN_SAFE_DAEMON_VERSION` updated to `20260325.8`** — minimum safe floor now matches the latest daemon with all protective fixes including WARN-deferral.
- Previously: v0.3.1–v0.3.6 users with `extensions.autoUpdate: false` ran a daemon as old as v20260313.2, missing all protective fixes from #45–#55, #6, and #64.

## [0.3.6] — 2026-03-25

### Added
- **Self-update checker** (`updateChecker.js`) — on activation (10 s deferred), checks the GitHub Releases API for a newer extension version. Shows a non-modal notification with "Update Now" (opens Marketplace) and "Dismiss" (per-version, stored in globalState) buttons. Throttled to once per 24 hours. Silently ignores all network errors. This ensures users with `extensions.autoUpdate: false` are always notified about critical daemon fixes in newer versions.
- **Minimum safe daemon version** (`MIN_SAFE_DAEMON_VERSION = 20260325.4` in `installer.js`) — if the installed daemon is below this floor after the install/upgrade check, a warning notification directs the user to update the extension. Defense-in-depth against scenarios where the hash-match or anti-downgrade guard leaves a critically outdated daemon in place.

### Daemon (v20260325.6)
- **Process classification tiers** ([#6](https://github.com/chf3198/crostini-mem-watchdog/issues/6)) — three configurable tiers (protected/disposable/monitored) with named pattern constants (`TIER_PROTECTED_PNAME`, `TIER_DISPOSABLE_PATTERN`, `TIER_DISPOSABLE_PATTERN_AUX`). All 13 hardcoded process patterns replaced with tier constants. `log_tier_assignments()` logs tier summary at startup. Override patterns via `~/.config/mem-watchdog/config.sh`.

### Daemon (v20260325.5)
- **Extension Host detected by `--inspect-port`, not stale `--type=extensionHost`** ([#55](https://github.com/chf3198/crostini-mem-watchdog/issues/55)) — VS Code 1.90+ runs the Extension Host as `--type=utility --utility-sub-type=node.mojom.NodeService` with `--inspect-port=0`. The previous `--type=extensionHost` pattern no longer matches, causing `kill_extension_host()` to fail on every call (753 consecutive failures during the 2026-03-25 17:33 crash). Now uses `--type=utility` + `--inspect-port` with fallback to legacy pattern.
- **Non-Extension-Host utility processes now eligible as kill candidates** ([#55](https://github.com/chf3198/crostini-mem-watchdog/issues/55)) — `kill_top_vscode_helper()` previously blanket-excluded all `--type=utility` processes (5 out of ~15 VS Code processes). Only the Extension Host (identified by `--inspect-port`) is now excluded; other utility processes (shared process, PTY host, file watcher) are available as EMERG-level candidates only (changed from WARN in v20260325.7 — killing PTY host at WARN destroyed VS Code terminals).

### Daemon (v20260325.1)
- **Action budget no longer exhausted by no-op browser kills** ([#49](https://github.com/chf3198/crostini-mem-watchdog/issues/49)) — `record_action()` in `kill_browsers()` moved after the kill verification check. Previously, every no-op call (no Chrome running) consumed the action budget and set `_action_taken=true`, exhausting the 30s budget in 3 seconds during 0.5s startup polling and blocking all fallback interventions for 27 seconds.
- **WARN/SIGTERM/SIGKILL paths check `chrome_running` before calling `kill_browsers`** ([#49](https://github.com/chf3198/crostini-mem-watchdog/issues/49)) — when no Chrome is running, the code now skips directly to the correct fallback (`kill_top_vscode_helper` or `kill_vscode_main`) instead of wasting the action budget on a guaranteed no-op.
- **`STARTUP_BURST_RSS_KB` raised from 1.6 GB to 2.2 GB** ([#49](https://github.com/chf3198/crostini-mem-watchdog/issues/49)) — 1.6 GB is normal VS Code steady state on this hardware; the previous threshold caused false-positive BURST kills after crash recovery.
- `MIN_SAFE_DAEMON_VERSION` updated to `20260325.1`.

### Tests
- JS unit tests: 55 → **75 passing**.
- Added `updateChecker.test.js` — 20 tests covering version comparison, 24 h throttling, button actions (Update Now / Dismiss), dismissal persistence, and error handling (network failure, 404, invalid JSON, timeout, missing tag_name).
- Added `installer.test.js` — MIN_SAFE_DAEMON_VERSION regression test: installed daemon below floor triggers warning notification.
- Updated `mockVscode.js` — added `_warnChoices` for warning-message button simulation, `commands.executeCommand` spy, `Uri.parse` stub.

## [0.3.5] — 2026-03-25

### Fixed
- **Bundled daemon version corrected** — v0.3.4 was published with a stale daemon (`20260316.1`) that did not include the language-server protection fixes from [#45](https://github.com/chf3198/crostini-mem-watchdog/issues/45), [#46](https://github.com/chf3198/crostini-mem-watchdog/issues/46), [#47](https://github.com/chf3198/crostini-mem-watchdog/issues/47). The extension installer's SHA-256 upgrade check would overwrite a manually deployed fix with the broken version. This release bundles daemon `20260324.3` with all three fixes.

## [0.3.4] — 2026-03-24

### Fixed
- **Duplicate status-bar item on extension reactivation** — extension activation is now idempotent per extension-host process, preventing creation of a second Mem Watchdog UI entry in the same VS Code window.
- **Runtime UI lifecycle cleanup** — status-bar item and poll timer are now tracked as module-level singletons and deterministically disposed on deactivation.

### Daemon (v20260324.3)
- **RSS acceleration path no longer uses emergency mode unconditionally** ([#45](https://github.com/chf3198/crostini-mem-watchdog/issues/45)) — the RSS velocity check at `eff_warn` (~2.2 GB) now uses `"normal"` kill mode, reserving `"emerg"` for when `vscode_rss ≥ eff_emerg` (~3.2 GB). Previously, the hardcoded `"emerg"` mode disabled all language-server protection even 1 GB below the true emergency threshold.
- **json-server and eslint added to language-server protection guard** ([#46](https://github.com/chf3198/crostini-mem-watchdog/issues/46)) — `jsonServerMain` and `eslintServer` are now excluded from `kill_top_vscode_helper` at normal severity. Before this fix, these processes were preferred kill targets despite being only 80–120 MB and subject to VS Code's 5-crash-in-3-minutes permanent death threshold.
- **Extension Host (utility process) excluded from helper kill path** ([#47](https://github.com/chf3198/crostini-mem-watchdog/issues/47)) — VS Code 1.90+ runs the Extension Host as `--type=utility --utility-sub-type=node.mojom.NodeService`, not the legacy `--type=extensionHost`. The 489 MB process hosting Copilot Chat, Playwright MCP, and all extensions now bypasses the helper-kill candidate pool at all severities below emergency.

### Tests
- JS unit tests updated: **56 passing**.
- Added regression test: `extension.activate.test.js` verifies repeated `activate()` calls only create one status-bar item.

## [0.3.3] — 2026-03-19

### Fixed
- **Daemon ACCEL guard restored** — RSS velocity intervention now requires both conditions: `rss_delta >= RSS_ACCEL_KB` **and** `vscode_rss >= eff_warn`. This prevents false-positive helper kills during normal startup JIT spikes at low total RSS.
- **Language-server helper protection widened** — `jsonServerMain` added to protected helper classification to avoid disruptive restarts of JSON language tooling.
- **Startup BURST fallback safety** — when no safe helper candidate exists, watchdog now logs and skips restart instead of escalating destructively.

### Changed
- Test gate totals updated and revalidated: **15 bash tests** (`test-watchdog.sh`) and **55 JS unit tests** (`npm test`).

## [0.3.1] — 2026-03-07

### Fixed
- **Daemon startup-mode debounce** — `STARTUP_DEBOUNCE=300` prevents startup mode from re-triggering within 5 minutes of the last activation. Without this guard, VS Code language servers (TypeScript, ESLint, GitLens workers) spawning new `code` PIDs during normal development caused the daemon to trigger startup mode **567 times in a single day**, keeping it at 0.5 s polling continuously and sending spurious pre-emptive Chrome SIGTERMs throughout the work session.
- **Daemon SIGTERM trap** — `systemctl stop/restart mem-watchdog` was taking the full 90 s systemd default before the forced SIGKILL. Root cause: the foreground `sleep "$interval"` deferred bash's SIGTERM trap until the subprocess exited. Fix: added `_sleep_pid` + `trap 'kill "$_sleep_pid"; exit 0' TERM INT` and changed sleep to `sleep & wait $!` so the `wait` builtin (which IS interruptible) processes signals immediately.
- **Service `TimeoutStopSec=10`** — belt-and-suspenders limit so the daemon is force-killed in 10 s rather than 90 s if the trap somehow doesn't fire.

### Changed
- `readMeminfo()` — replaced `split('\n')` + per-line regex loop with two anchored `/m` multiline regex matches. **~30× faster** (156 ms vs 4 795 ms per 500k calls), **12× less heap** per call (29 vs 349 bytes). Reduces V8 GC pressure during 0.5 s startup-mode polling. All 16 `readMeminfo` unit tests continue to pass unchanged.
- Tooltip construction and IPC update now skipped when `svcStatus`, `pct%`, and `availMB` are unchanged — `_lastTooltipKey` cache prevents redundant `MarkdownString` allocations and renderer IPC round-trips on every 2 s tick during a healthy, stable session.

### Performance
- **Zero-fork service status check** (`checkServiceStatus()` in `utils.js`) — replaces the `exec('systemctl --user is-active')` shell-out in the hot path with a direct `fs.readFileSync` of the systemd cgroup virtual file (`/sys/fs/cgroup/systemd/.../mem-watchdog.service/cgroup.procs`). Benchmarks on this hardware: `exec()` = 8.7 ms/call, 308 KB heap Δ/100 calls; `cgroup.procs` read = 14.5 µs/call, ~42 KB heap Δ/100 calls. **~600× faster**, daily CPU cost drops from 375 ms to <1 ms at 43,200 calls/day (2 s polling). Critically, `fork()` failures under `ENOMEM` are eliminated — the exec path becomes unreachable precisely when memory pressure is highest. Falls back to `sh('systemctl --user is-active')` on non-cgroup-v1 or non-systemd environments. Cgroup path is derived once at module load from `/proc/self/cgroup`.
- `_lastStateKey` unified cache — the separate `_lastTooltipKey` cache has been merged into `_lastStateKey`, which now gates **all four** `StatusBarItem` assignments (text, color, backgroundColor, tooltip) in a single `if (stateKey !== _lastStateKey)` block, eliminating redundant IPC for any field on a stable-state tick.

### Tests
- 52 → **54** JS unit tests: added `describe('update() — tooltip IPC cache')` with cache-hit and cache-miss tests; `resetStateCache()` exposed via `module._test` seam (renamed from `resetTooltipCache`) for deterministic per-test isolation. Pileup-guard tests updated to count `checkServiceStatus()` calls (via `checkCallCount`) instead of `sh()` calls.
- `_stats = { dropped, cacheHits, cacheMisses }` — three integer counters added to `extension.js`, incremented on every `update()` tick. Exposed via `_test.getStats()` / `_test.resetStats()` for assertion in pileup tests (`dropped===19` under 20 concurrent calls). Allocation cost is three integer increments per call — zero heap.
- `test/stress/update-stress.js` added (`npm run test:stress`) — 6 scenarios: stable-state, state-toggling, all-UI-states, pileup-50 ms, pileup-200 ms, warm-2000. Measures event-loop latency via `monitorEventLoopDelay({ resolution: 1 })`, heap usage via `process.memoryUsage()`, and pileup guard efficiency. JSON report written to `scratch/stress-TIMESTAMP.json`.
- **Zero-fork `snapshot()`** in `test-pressure.sh` — redesigned from ~190 forks per checkpoint to 1 amortized fork (`WD_PID` resolved once at test-suite start via `systemctl`). `$EPOCHSECONDS` (bash 5.0+ built-in, zero syscall) replaces `date +%s`; `/proc/[0-9]*/status` glob + `while IFS= read` loop replaces `ps -C code | awk | wc | tr` pipeline forks; `read -r < /proc/…/file` replaces all `cat` subshell forks. `wd_cpu_ticks` (sum of `utime+stime` fields from `/proc/$WD_PID/stat`) replaces the `ps %cpu` snapshot — the raw tick count is diffable across intervals to compute interval CPU rate.
- `monitorEventLoopDelay` resolution lowered 5 ms → 1 ms; `Number.isFinite()` NaN guards added to all histogram percentile reads — prevents `NaN` in JSON output when the histogram has not yet accumulated samples during warm-up. Confirmed: `monitorEventLoopDelay` uses a `uv_timer_t` on the main V8 thread (not a Worker) — its RSS is accounted within the main process heap.

---

## [0.3.0] — 2026-03-06

### Added
- **Unit test suite** — 52 tests across 5 files (`utils.test.js`, `configWriter.test.js`, `commands.test.js`, `installer.test.js`, `extension.test.js`). Zero-install runner via `node:test` built-in; coverage via `c8`.
- **`extension.test.js` stress tests** — 9 tests covering the status bar state machine (all 5 states), the `_updating` pileup guard under 20 concurrent `update()` calls, and resilience under adverse conditions (`/proc/meminfo` unreadable).
- **Live pressure suite** (`test-pressure.sh`) expanded to 5 tests: oom_score_adj verification on a real decoy process (unconditional), and dual chrome+playwright kill in one threshold crossing (conditional on RAM < 40% free).

### Changed
- Test file count now 52 JS + 12 bash = 64 total.
- All 4 gates must pass before publish: `bash test-watchdog.sh`, `bash -n mem-watchdog.sh`, `shellcheck`, `npm test`.

---

## [0.2.0] — 2026-03-06

### Changed
- License migrated from MIT to **PolyForm Noncommercial 1.0.0**. Free for personal, educational, and non-commercial use. Commercial use requires a paid license — see [COMMERCIAL-LICENSE.md](https://github.com/chf3198/crostini-mem-watchdog/blob/main/COMMERCIAL-LICENSE.md) or contact curtisfranks@gmail.com.

## [0.1.0] — 2026-03-06

Complete rewrite. The extension is now a self-contained installable that bundles and manages the daemon — no separate install script required.

### Added
- **Self-installing daemon**: SHA-256 hash-based auto-install and auto-upgrade of `mem-watchdog.sh` on every VS Code activation. Copies daemon to `~/.local/bin/` and service unit to `~/.config/systemd/user/`, then runs `systemctl --user enable --now`.
- **Show Memory Dashboard** command: full output-channel snapshot — system RAM, PSI pressure index, VS Code RSS per-PID, Chrome/Playwright RSS, service status, last 8 journal lines.
- **Playwright Pre-flight Check** command: pass/fail modal checking RAM%, VS Code RSS, Chrome presence, and watchdog state. Offers "Kill Chrome Now" inline if Chrome is running.
- **Kill Chrome / Playwright Now** command: immediate `SIGTERM` to all `chrome`, `chromium`, and `node.*playwright` processes.
- **Restart Service** command: `systemctl --user restart mem-watchdog` with status feedback.
- **Settings UI**: all 5 thresholds configurable via VS Code Settings → Mem Watchdog (`sigtermThresholdPct`, `sigkillThresholdPct`, `psiThresholdPct`, `vscodeRssWarnMB`, `vscodeRssEmergencyMB`). All `scope: "machine"` — never syncs across machines.
- **Auto-sync**: settings changes immediately rewrite `~/.config/mem-watchdog/config.sh` and restart the daemon.
- **Startup mode**: daemon switches to 0.5 s polling for 90 s when new VS Code PIDs are detected — catches the extension-host RSS spike during startup before it triggers OOM.
- **`vscode:uninstall` hook**: stops and disables the service when the extension is removed.

### Changed
- Status bar item now shows RAM *free* percentage (vs used in 0.0.1).
- Status bar item click opens the Memory Dashboard output channel.
- Status bar thresholds recalibrated: green > 35% free, amber 20–35%, red < 20%.

---

## [0.0.1] — 2026-02-15

Initial release.

### Added
- Status bar widget showing live RAM% and VS Code RSS, updated every 2 seconds.
- `systemctl --user is-active mem-watchdog` service health indicator.
- Color-coded status: green / amber / red / red-inactive.
