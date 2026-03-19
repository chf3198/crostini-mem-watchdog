# Changelog

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
