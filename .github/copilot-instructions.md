# Copilot Instructions — crostini-mem-watchdog

## Project Origin & Context

This repo was extracted from a separate private project after repeated VS Code OOM crashes during Playwright automation sessions. **The canonical technical post-mortem** — including the full crash timeline, the Crostini swap investigation, and why earlyoom fails — lives at [docs/technical/system-stability.md](../docs/technical/system-stability.md). Read it before making architectural changes.

**Hardware**: Chromebook, Intel i3-N305, 6.3 GB RAM, ChromeOS Crostini (Debian 12, kernel 6.6.99). No swap visible inside the container (`free -h` shows `Swap: 0B`) — 16 GB zram swap runs at the ChromeOS host layer, transparent to the container kernel. The container OOM killer fires on the container's own RAM view.

## Architecture

```
mem-watchdog.sh          ← core daemon; single infinite loop, no deps beyond coreutils
mem-watchdog.service     ← systemd user unit (systemctl --user, NOT system)
install.sh               ← legacy installer (pre-extension path; still functional)
test-watchdog.sh         ← 12-test suite; exits 0/1; logs to scratch/
watchdog-tray.sh         ← optional yad system tray icon (separate from service)
vscode-extension/        ← self-contained installable VS Code extension
  extension.js           ← activate(): orchestrates install, config, commands, status bar
  installer.js           ← hash-based daemon auto-install/upgrade; writes to ~/.local/bin/
  configWriter.js        ← VS Code settings → ~/.config/mem-watchdog/config.sh
  commands.js            ← 4 commands: dashboard, preflight, killChrome, restartService
  lifecycle.js           ← vscode:uninstall hook; stops + disables the service
  scripts/
    prepare.js           ← vscode:prepublish: copies mem-watchdog.sh + .service → resources/
  resources/             ← BUILD ARTIFACT (gitignored); bundled into .vsix by vsce
    mem-watchdog.sh      ← copy of repo-root daemon (chmod +x)
    mem-watchdog.service ← copy of repo-root service unit
  package.json           ← manifest: commands, settings (scope=machine), extensionKind=["ui"]
```

**The daemon must remain a separate systemd process.** The VS Code JS extension host freezes under OOM pressure — the daemon's independence is the protection. The extension auto-installs the daemon; it does NOT replace it.

**Config sourcing pattern:** `mem-watchdog.sh` sources `~/.config/mem-watchdog/config.sh` (if it exists) after its own defaults. `configWriter.js` writes that file from VS Code Settings. This keeps the daemon script itself unmodified at runtime and simplifies upgrade detection.

**Companion scripts** (superseded by extension commands, no longer needed):
- `mem-status.sh` — memory dashboard (superseded by `memWatchdog.showDashboard` command)
- `playwright-safe-launch.sh` — pre-flight RAM check (superseded by `memWatchdog.preflightCheck` command)

## Critical Constraints — Never Violate

1. **Never read `SwapFree` from `/proc/meminfo`** — it is `~18.4 exabytes` on Crostini (uint64 overflow sentinel). Use only `MemAvailable` and `MemTotal`.
2. **Always use `systemctl --user`**, never `sudo systemctl`. The container is non-root (`CapEff=0`).
3. **No `/tmp` writes in `mem-watchdog.sh`** — Test 9 checks this. Log only via `logger -t mem-watchdog`.
4. **Bash integer arithmetic only** for threshold comparisons — no `bc`, no floats. PSI values are scaled ×100 (e.g., `psi_x100=345` represents `avg10=3.45`).
5. **`oom_score_adj`**: VS Code PIDs → `0` (counters Electron's 200–300 default); Chrome/Playwright → `1000`. Non-negative values require no root.

## Kill Hierarchy (in priority order)

| Condition | Action |
|---|---|
| `MemAvailable ≤ 15%` | `SIGKILL` Chrome/Playwright |
| `MemAvailable ≤ 25%` | `SIGTERM` Chrome/Playwright |
| PSI `full avg10 > 25%` | `SIGTERM` Chrome/Playwright |
| VS Code RSS ≥ `VSCODE_RSS_EMERG_KB` (3.5 GB) | `SIGKILL` Chrome; if no Chrome → `SIGTERM` highest-RSS `code` PID (extension host) |
| VS Code RSS ≥ `VSCODE_RSS_WARN_KB` (2.5 GB) | `SIGTERM` Chrome + desktop alert |

## Startup Mode Pattern

When new VS Code PIDs are detected, the daemon switches to 0.5s polling for 90s and drops the RSS emergency threshold to 2.0 GB. This prevents the crash pattern where the extension host spikes 0→4+ GB in under 2 seconds during startup. The state is tracked via `_startup_mode_end` (epoch seconds), `_known_code_pids`, `_startup_just_triggered`, and `_last_startup_trigger`.

**Debounce**: `STARTUP_DEBOUNCE=300` prevents re-triggering within 5 minutes. Without this guard, VS Code language servers (TypeScript, ESLint, GitLens workers) spawn new `code` PIDs throughout normal development — observed to trigger startup mode 567 times in a single day, keeping the daemon at 0.5 s polling continuously and sending spurious pre-emptive Chrome SIGTERMs.

**Interruptible sleep**: the main loop uses `sleep "$eff_interval" & _sleep_pid=$!; wait "$_sleep_pid"` with `trap 'kill "$_sleep_pid"; exit 0' TERM INT` so SIGTERM from `systemctl stop` fires immediately rather than waiting up to 2 s for the foreground sleep subprocess.

## Client Interaction Boundaries — Non-Negotiable

**The client performs UAT only.** All technical work is the agent's sole responsibility.

**The agent NEVER asks the client to:**
- Run any shell command, git command, or terminal instruction
- Configure credentials, authentication, or git settings
- Perform any git operation (branch, commit, merge, push, rebase)
- Interpret error output or diagnose failures
- Manually edit files or configs

**When blocked by a technical hurdle, the agent must:**
1. Exhaust all programmatic workarounds before surfacing anything to the client
2. If an **external security authorization** is genuinely required (the one known case is GitHub's `workflow` OAuth scope — required to push `.github/workflows/` files, enforced at every GitHub API layer with no programmatic bypass), the agent frames it as a single browser action: *"Please visit [URL] in your browser and enter the code [CODE] shown in the terminal to authorize CI/CD push access."* This is equivalent to clicking "Authorize" on any OAuth app — not technical work.
3. After the client completes any browser authorization, the agent resumes and finishes all remaining work without further client input.

**Git operations are entirely the agent's responsibility:** branch creation, commits, merges, rebases, conflict resolution, push retries, and credential scope management. A push failure is an agent problem to solve, not a client task.

## Repository Admin & Contribution Visibility — Non-Negotiable

All implementation work must be publicly traceable for repo visitors.

Before coding:
1. Confirm a linked issue exists.
2. Ensure issue has taxonomy label: `type: epic|research|task|bug-fix`.
3. Ensure issue has one priority label and at least one domain label.
4. Ensure issue is assigned to a milestone and on the roadmap project.

Before merge:
1. PR includes `Closes #N`.
2. PR checklist includes milestone + labels + gate suite evidence.
3. Any assumption mismatch discovered during work is recorded in `docs/workflow/learnings.md`.

Never perform untracked work. If no issue exists, create one first.

---

## Agent Workflow — Non-Negotiable Loop

Every change follows these phases in order. **Never blend phases.**

```
EXPLORE → PLAN → IMPLEMENT → GATE → REFLECT → COMMIT
```

**EXPLORE**: Read relevant files. No edits. Understand before touching.  
**PLAN**: Name every file that will change and why. If the change touches >2 files, write the plan before starting.  
**IMPLEMENT**: Make the change. After every edit to a shell file, run `bash -n <file>` immediately.  
**GATE**: All four checks must exit 0 — no exceptions, no skips.

```bash
bash test-watchdog.sh   # 12 bash tests, ~3s — must exit 0
bash -n mem-watchdog.sh # bash syntax check — must exit 0
shellcheck --shell=bash -e SC1091,SC2317 mem-watchdog.sh watchdog-tray.sh install.sh
cd vscode-extension && npm test   # 54 JS unit tests, ~1s — must exit 0
```

**REFLECT**: Read your own diff. Ask aloud: *"What did I not test? What could break under OOM pressure or during VS Code startup?"* Fix those gaps before proceeding.  
**COMMIT**: One logical change per commit. See format below.

### Gate Failures

| Situation | Required action |
|---|---|
| `test-watchdog.sh` exits non-zero | Fix root cause. NEVER use `\|\| true`, skip flags, or `exit 0` overrides. |
| A previously passing test now fails | Your change broke it — fix the change, not the test. |
| You cannot write a test for the change | State why explicitly in the commit message body. |
| Diff touches two unrelated concerns | Split into two commits before pushing. |

### Commit Format

```
type(scope): imperative description

Why this change was needed — the specific crash, failure mode, or test that exposed it.
Reference: docs/technical/system-stability.md §N if relevant.
```

Valid types: `fix` `feat` `refactor` `test` `chore` `docs`  
Valid scopes: `daemon` `extension` `installer` `config` `tests` `tray`

### The 4-C Rule

> **Code → Critique → Correct → Commit**  
> Never go directly Code → Commit. The Critique step is not optional.

## Developer Reference

```bash
# Test without killing anything
./mem-watchdog.sh --dry-run

# Run all 12 validation tests (~3s, exits 0/1) — logs go to scratch/
bash test-watchdog.sh

# Run live memory pressure tests (requires RAM < 40% free or Chrome tabs open)
bash test-pressure.sh --dry-run   # preview
bash test-pressure.sh             # live: allocates memory, verifies watchdog fires

# Install (copies to ~/.local/bin, enables service)
bash install.sh [--no-extension] [--dry-run]

# Service management
systemctl --user status mem-watchdog
systemctl --user restart mem-watchdog
journalctl --user -u mem-watchdog -f

# Build and publish VS Code extension
cd vscode-extension
npm run build                     # populate resources/ for local dev/testing
npm test                          # 54 JS unit tests via node:test (~1s, exits 0/1)
npm run test:coverage             # same + c8 V8 coverage report to stdout + lcov
npm run test:stress               # 6 stress scenarios: pileup guard, EL lag, heap usage
npx vsce package                  # → mem-watchdog-status-x.y.z.vsix
VSCE_PAT="..." npx vsce publish --pat "$VSCE_PAT"  # publisher: CurtisFranks

# Adjust thresholds without reinstalling
# VS Code Settings → Mem Watchdog (configWriter.js writes ~/.config/mem-watchdog/config.sh)
```

## Out-of-Band System Config (not installed by install.sh)

Test 4 checks for these — they must be set manually after install:

- **`~/.config/Code/argv.json`**: `{ "js-flags": "--max-old-space-size=2048" }` — caps V8 heap. **Do not set this below 2048**; 512 MB caused GC thrash that *increased* total RSS (confirmed 2026-03-05).
- **`~/.config/Code/User/settings.json`**: `typescript.tsserver.maxTsServerMemory: 2048`, `files.watcherExclude` covering `node_modules/**`, `telemetry.telemetryLevel: "off"`.

## Threshold Tuning

**Preferred:** VS Code Settings → **Mem Watchdog** (all 5 thresholds). `configWriter.js` writes `~/.config/mem-watchdog/config.sh`; the daemon sources it on next restart.

**Manual fallback:** Top-of-file variables in [mem-watchdog.sh](../mem-watchdog.sh). For 6 GB RAM (default): `VSCODE_RSS_WARN_KB=2500000`, `VSCODE_RSS_EMERG_KB=3500000`. Adjust proportionally — see the RAM table in README.md.

## Logging Convention

All log lines go through `log()`: `logger -t mem-watchdog` (→ journald) + `echo` with timestamp. Action lines are prefixed `ACTION(SIGTERM):` or `ACTION(SIGKILL):`. Desktop notifications use `notify-send` with `DISPLAY=:0` set explicitly (required in Crostini where `$DISPLAY` may be unset in a service context), throttled per-severity via `_last_notify_warn` / `_last_notify_crit` epoch timestamps.

## Test Suite Notes

- Tests 1–12 live in `test-watchdog.sh` at the **repo root** (not `scripts/`).
- `REPO` is set to the script's own directory — do not add a `..` parent traversal.
- Test logs write to `scratch/` (gitignored) inside the repo root.
- Test 12 checks `watchdog-tray.sh` for stray `/tmp` data writes (the `mktemp` FIFO is exempted — it is cleaned up by the EXIT trap).
- `test-pressure.sh` — live pressure tests using real memory allocation + a cgroup safety ceiling. Uses `sudo -n` (confirmed no password required). Skips safely if insufficient free RAM; run when RAM < 40% free for best coverage.

## Key Reference Documents

- [docs/technical/system-stability.md](../docs/technical/system-stability.md) — crash post-mortem, three OOM pathways, why zram doesn't fix container OOM, V8 GC thrash analysis, cgroup testing technique
- [docs/workflow/learnings.md](../docs/workflow/learnings.md) — accumulated learnings log; update after every significant discovery
