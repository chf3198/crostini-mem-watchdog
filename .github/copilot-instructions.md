# Copilot Instructions — crostini-mem-watchdog

> **Canonical post-mortem**: [`docs/technical/system-stability.md`](../docs/technical/system-stability.md). Read before making architectural changes.

## Platform Context (Non-Negotiable)

**Hardware**: Chromebook, i3-N305, 6.3 GB RAM, ChromeOS Crostini (Debian 12, kernel 6.6.99). `free -h` shows `Swap: 0B` — 16 GB zram runs at the ChromeOS host layer, invisible to the container kernel. The container OOM killer fires on its own RAM view.

## Architecture

```
mem-watchdog.sh          ← core daemon; single infinite loop, no deps beyond coreutils
mem-watchdog.service     ← systemd user unit (systemctl --user, NOT system)
install.sh               ← shell-only installer (no VS Code required)
test-watchdog.sh         ← 15-test suite; exits 0/1; logs to scratch/
vscode-extension/
  extension.js           ← activate(): install → config → commands → status bar (2s poll)
  installer.js           ← SHA-256 hash-based daemon auto-install/upgrade
  configWriter.js        ← VS Code Settings → ~/.config/mem-watchdog/config.sh
  commands.js            ← 4 commands: dashboard, preflight, killChrome, restartService
  utils.js               ← readMeminfo(), sh(), checkServiceStatus() — shared helpers
  lifecycle.js           ← vscode:uninstall hook; stops + disables the service
  scripts/prepare.js     ← vscode:prepublish: copies daemon files → resources/
  resources/             ← BUILD ARTIFACT (gitignored); bundled into .vsix by vsce
```

**Two-process design is intentional.** The VS Code extension host can freeze under OOM pressure — the daemon must be a separate systemd process to survive it. The extension installs/upgrades the daemon; it does not replace it.

**Config sourcing**: `mem-watchdog.sh` sources `~/.config/mem-watchdog/config.sh` after its own defaults. `configWriter.js` writes this file from VS Code Settings. The daemon script is never modified at runtime — keeping SHA-256 upgrade detection exact. Bump `WATCHDOG_VERSION` in `mem-watchdog.sh` on any behavioral change.

**Service status check** (`utils.js`): reads `/sys/fs/cgroup/systemd/.../mem-watchdog.service/cgroup.procs` directly — zero-fork, ~600× faster than `exec('systemctl ...')`, and survives OOM where `fork()` can fail. Path is derived once at module load from `/proc/self/cgroup` by anchoring at `/app.slice`.

## Critical Constraints — Never Violate

1. **Never read `SwapFree`** — Crostini reports `~18.4 exabytes` (uint64 overflow sentinel). Use only `MemAvailable` and `MemTotal`.
2. **Always `systemctl --user`**, never `sudo systemctl`. Container is non-root (`CapEff=0`).
3. **No `/tmp` writes in `mem-watchdog.sh`** — Test 9 checks this. Log via `logger -t mem-watchdog` only.
4. **Bash integer arithmetic only** — no `bc`, no floats. PSI scaled ×100: `psi_x100=345` = `avg10=3.45`.
5. **`oom_score_adj`**: VS Code PIDs → `0`; Chrome/Playwright → `1000`. Non-negative; no root needed.
6. **Interruptible sleep**: `sleep "$eff_interval" & _sleep_pid=$!; wait "$_sleep_pid"` + trap kills `$_sleep_pid`. Never use foreground `sleep` in the main loop.

## Kill Hierarchy

| Condition | Action |
|---|---|
| `MemAvailable ≤ 15%` | `SIGKILL` Chrome/Playwright |
| `MemAvailable ≤ 25%` | `SIGTERM` Chrome/Playwright |
| PSI `full avg10 > 25%` | `SIGTERM` Chrome/Playwright |
| VS Code RSS ≥ `VSCODE_RSS_EMERG_KB` (3.2 GB) | `SIGKILL` Chrome; if no Chrome → `kill_vscode_main()` |
| VS Code RSS ≥ `VSCODE_RSS_WARN_KB` (2.2 GB) | `SIGTERM` Chrome + desktop alert; if no Chrome → `kill_top_vscode_helper()` |
| RSS delta ≥ `RSS_ACCEL_KB` (300 MB/cycle) **AND** `vscode_rss ≥ eff_warn` | `kill_top_vscode_helper()` or `kill_browsers(TERM)` |
| `RSS_RUNAWAY_STREAK=3` consecutive ACCEL cycles above `RSS_RUNAWAY_MIN_KB` (2.6 GB) | Circuit-breaker: `kill_vscode_main()` |

**ACCEL gate (critical)**: The `vscode_rss >= eff_warn` guard on the RSS velocity check is non-negotiable. Without it, V8 JIT compilation during startup legitimately spikes 300–900 MB/cycle at 1–2 GB total RSS, causing the watchdog to kill the Extension Host in a restart loop. Confirmed 2026-03-16: "Extension host terminated unexpectedly 3 times."

**Startup mode**: 0.5s polling for 90s after new VS Code PIDs appear. Debounced at `STARTUP_DEBOUNCE=300s` — without this guard, language-server PID churn triggered startup mode 567 times in one day. Startup thresholds: `STARTUP_RSS_WARN_KB=2800000`, `STARTUP_RSS_EMERG_KB=3400000`.

**Action budget** (`utils.js`-equivalent in daemon): `action_budget_allows()` limits non-critical interventions to `ACTION_BUDGET_MAX=6` per `ACTION_BUDGET_WINDOW=30s`, and enforces at most one action per loop iteration (`_action_taken` flag). Prevents thrash storms under rapid-fire ACCEL or BURST triggers.

**`kill_vscode_main()`**: SIGTERM on the VS Code main process (identified by `/usr/share/code/code$` cmdline). Used as circuit-breaker only — gated by `CODE_RECOVERY_COOLDOWN=30s`. Causes VS Code window restart, which is preferable to kernel OOM-kill.

## Agent Workflow — Non-Negotiable Loop

```
EXPLORE → PLAN → IMPLEMENT → GATE → REFLECT → COMMIT
```

**IMPLEMENT**: After every shell file edit, run `bash -n <file>` immediately.  
**GATE**: All four checks must exit 0 — no exceptions, no skips:

```bash
bash test-watchdog.sh                                                          # 15 bash tests, ~3s
bash -n mem-watchdog.sh                                                        # syntax check
shellcheck --shell=bash -e SC1091,SC2317 mem-watchdog.sh watchdog-tray.sh install.sh
cd vscode-extension && npm test                                                # 55 JS unit tests, ~1s
```

**Gate failure rules**: Fix root cause — never `|| true`, skip flags, or `exit 0` overrides. A previously passing test that now fails means the change broke it; fix the change, not the test.

**4-C Rule**: Code → Critique → Correct → Commit. Never go directly Code → Commit.

## Build & Developer Reference

```bash
cd vscode-extension
npm run build              # populate resources/ for dev (gitignored; required before vsce package)
npm test                   # 55 unit tests via node:test (~1s)
npm run test:coverage      # + c8 V8 lcov output
npm run test:stress        # pileup guard + event-loop lag + heap scenarios
npx vsce package           # → mem-watchdog-status-x.y.z.vsix

bash test-watchdog.sh      # 15 bash tests (repo root — REPO=$(dirname $0), not scripts/)
bash test-pressure.sh      # live memory allocation tests; needs RAM < 40% free
./mem-watchdog.sh --dry-run

systemctl --user {status,restart,stop} mem-watchdog
journalctl --user -u mem-watchdog -f
```

**JS test mocking**: `test/helpers/mockVscode.js` patches `Module._resolveFilename` to intercept the bare `'vscode'` specifier. Inject mocks into `require.cache` before loading the module under test. Internals exposed via `module._test` when `process.env.MEM_WATCHDOG_TEST=1`.

**Logging convention**: All daemon lines go through `log()`: `logger -t mem-watchdog` + timestamped `echo`. Action lines prefixed `ACTION(SIGTERM):` / `ACTION(SIGKILL):`. `notify-send` uses `DISPLAY=:0` explicitly (unset in systemd service context), throttled per-severity via `_last_notify_warn` / `_last_notify_crit`.

## Commit Format

```
type(scope): imperative description

Why this change was needed — specific crash, failure mode, or test that exposed it.
Reference: docs/technical/system-stability.md §N if relevant.
```

Valid types: `fix` `feat` `refactor` `test` `chore` `docs`  
Valid scopes: `daemon` `extension` `installer` `config` `tests` `tray`

## Repository Admin & Client Interaction

**Issue-first**: every change needs a linked issue with taxonomy label (`type: epic|research|task|bug-fix`), priority label, domain label, milestone, and roadmap project assignment before coding. PR requires `Closes #N`, milestone, labels, and gate-suite evidence. Record assumption mismatches in `docs/workflow/learnings.md`.

**The client performs UAT only.** The agent never asks the client to run shell commands, perform git operations, or interpret errors. Git operations are entirely the agent's responsibility. The one permitted client action: visiting a browser URL to authorize GitHub `workflow` OAuth scope for CI/CD pushes.

## Key References

- [`docs/technical/system-stability.md`](../docs/technical/system-stability.md) — three OOM pathways, zram limitation, V8 heap cap analysis, cgroup testing technique
- [`docs/workflow/learnings.md`](../docs/workflow/learnings.md) — accumulated discoveries; update after every significant finding
