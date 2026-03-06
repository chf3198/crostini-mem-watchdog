# Changelog

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
