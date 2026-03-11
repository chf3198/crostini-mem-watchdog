# Contributing to crostini-mem-watchdog

Thank you for your interest in contributing. This document explains the workflow,
the non-negotiable invariants, and how to run the gate suite before opening a PR.

---

## Quick Start

```bash
git clone https://github.com/chf3198/crostini-mem-watchdog.git
cd crostini-mem-watchdog/vscode-extension
npm ci           # install devDependencies (no prod deps)
npm test         # 54 unit tests — must exit 0
```

> **Important:** `npm test` must be run from inside `vscode-extension/`, not from
> the repo root. There is no root-level `package.json`.

---

## Agent Workflow — Non-Negotiable Loop

Every change, however small, follows these phases in order. **Never blend phases.**

```
EXPLORE → PLAN → IMPLEMENT → GATE → REFLECT → COMMIT
```

- **EXPLORE**: Read relevant files. No edits. Understand before touching.
- **PLAN**: Name every file that will change and why. Write the plan before starting
  if the change touches more than 2 files.
- **IMPLEMENT**: Make the change. After every edit to a shell file, run
  `bash -n <file>` immediately.
- **GATE**: All four checks must exit 0 — no exceptions, no skips.
- **REFLECT**: Read your own diff. Ask: _"What did I not test? What could break
  under OOM pressure or during VS Code startup?"_ Fix those gaps.
- **COMMIT**: One logical change per commit (see format below).

---

## Gate Suite

Run all four checks before every commit. All must exit 0.

```bash
# 1. Bash unit tests (12 tests, ~3 s) — run from repo root
bash test-watchdog.sh

# 2. Bash syntax check
bash -n mem-watchdog.sh

# 3. ShellCheck — SC1091 (source) and SC2317 (unreachable) are intentionally suppressed
shellcheck --shell=bash -e SC1091,SC2317 mem-watchdog.sh watchdog-tray.sh install.sh

# 4. JS unit tests (54 tests, ~1 s) — must run from vscode-extension/
cd vscode-extension && npm test
```

For performance regression checking (optional but encouraged):

```bash
cd vscode-extension
npm run test:stress        # 6 stress scenarios: pileup guard, EL lag, heap usage
npm run test:coverage      # V8 coverage report + lcov
```

The stress harness requires `--expose-gc` (set in `package.json` `scripts`).
Do not remove that flag — without it the GC-pressure scenarios produce misleading
heap numbers.

> **Note:** `test-watchdog.sh` Tests 1, 2, and 11 require a live `systemctl --user`
> session with the `mem-watchdog` service installed. They are excluded from CI
> (GitHub Actions runs in a container without systemd). Run them locally before
> touching the daemon or the service unit.

---

## Commit Format

```
type(scope): imperative description

Why this change was needed — the specific crash, failure mode, or test that exposed it.
Reference: docs/technical/system-stability.md §N if relevant.
```

**Valid types:** `fix` `feat` `refactor` `test` `chore` `docs`  
**Valid scopes:** `daemon` `extension` `installer` `config` `tests` `tray`

### The 4-C Rule

> **Code → Critique → Correct → Commit**  
> Never go directly Code → Commit. The Critique step is not optional.

### Gate Failures

| Situation                              | Required action                                                           |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `test-watchdog.sh` exits non-zero      | Fix root cause. NEVER use `\|\| true`, skip flags, or `exit 0` overrides. |
| A previously passing test now fails    | Your change broke it — fix the change, not the test.                      |
| You cannot write a test for the change | State why explicitly in the commit message body.                          |
| Diff touches two unrelated concerns    | Split into two commits before pushing.                                    |

---

## Invariants — Never Violate

These constraints exist because of real crashes. Violating them will reintroduce
known failure modes.

1. **Never read `SwapFree` from `/proc/meminfo`.** The Crostini kernel reports
   `~18.4 exabytes` (uint64 overflow sentinel). Use only `MemAvailable` and
   `MemTotal`. See `docs/technical/system-stability.md §2`.

2. **Always use `systemctl --user`**, never `sudo systemctl`. The container runs
   non-root (`CapEff=0`).

3. **`STARTUP_DEBOUNCE=300` must not be lowered without a compensating filter.**
   VS Code language servers (TypeScript, ESLint, GitLens) spawn new `code` PIDs
   throughout normal development. Without this guard, startup mode triggered
   567 times in a single day — confirmed 2026-03-07. See `docs/workflow/learnings.md`.

4. **All VS Code settings must use `scope: "machine"`** in `package.json`. Without
   this, VS Code Settings Sync pushes thresholds tuned for 6.3 GB RAM to machines
   with different hardware. This is incorrect and potentially dangerous.

5. **No `/tmp` writes in `mem-watchdog.sh`** — Test 9 checks this. Log only via
   `logger -t mem-watchdog`.

6. **Bash integer arithmetic only** for threshold comparisons. No `bc`, no floats.
   PSI values are scaled ×100 (`psi_x100=345` represents `avg10=3.45`).

7. **The daemon must remain a separate systemd process.** The VS Code extension
   host freezes under OOM pressure. The daemon's independence is the protection.
   The extension auto-installs it; it does NOT replace it.

---

## Architecture Overview

```
mem-watchdog.sh          ← core daemon; single infinite loop, no deps beyond coreutils
mem-watchdog.service     ← systemd user unit (systemctl --user, NOT system)
install.sh               ← installer: copies daemon to ~/.local/bin/, enables service
test-watchdog.sh         ← 12-test suite; exits 0/1; logs to scratch/
vscode-extension/        ← self-contained VS Code extension
  extension.js           ← activate(): orchestrates install, config, commands, status bar
  installer.js           ← hash-based daemon auto-install/upgrade
  configWriter.js        ← VS Code settings → ~/.config/mem-watchdog/config.sh
  commands.js            ← dashboard, preflight, killChrome, restartService commands
  lifecycle.js           ← vscode:uninstall hook; stops + disables the service
  test/                  ← unit tests (node:test, no framework dep)
  test/bench/            ← micro-benchmarks (run manually, not in CI)
```

**Config sourcing pattern:** `mem-watchdog.sh` sources
`~/.config/mem-watchdog/config.sh` after its own defaults. `configWriter.js`
writes that file from VS Code Settings. This keeps the installed daemon
byte-for-byte identical to the bundled resource, making hash-based upgrade
detection trivial.

---

## Developer Reference

```bash
# Test without killing anything
./mem-watchdog.sh --dry-run

# Run all 12 validation tests (~3 s, exits 0/1) — logs go to scratch/
bash test-watchdog.sh

# Service management
systemctl --user status mem-watchdog
systemctl --user restart mem-watchdog
journalctl --user -u mem-watchdog -f

# Build and publish VS Code extension
cd vscode-extension
npm run build                     # populate resources/ for local dev/testing
npm test                          # 54 JS unit tests
npm run test:coverage             # + c8 V8 coverage report
npm run test:stress               # stress scenarios
npx vsce package                  # → mem-watchdog-status-x.y.z.vsix
```

---

## Opening a Pull Request

1. Fork the repository.
2. Create a branch: `type/short-description` (e.g., `fix/daemon-psi-threshold`).
3. Make your change following the workflow above.
4. Run the full gate suite. All four checks must exit 0.
5. Open a PR against `main`. The PR template checklist will guide you through
   the remaining steps.

Issues labelled `good first issue` are a good starting point if you're new to
the codebase.

---

## Repository Admin Process (Issue-First, Public by Default)

To keep contribution history auditable for visitors, all work must be tracked through GitHub Issues + Milestones + Project.

### Ticket taxonomy (required)

- `type: epic` — multi-issue initiatives spanning milestones
- `type: research` — investigation, benchmarking, architecture validation
- `type: task` — implementation or documentation work item
- `type: bug-fix` — defect, regression, or reliability correction

### Additional labels (required)

- Exactly one priority label: `priority: critical|high|medium|low`
- At least one domain label: `policy|psi|cgroup|oom|crostini|testing|performance|research`

### Lifecycle (required)

1. Create/choose issue
2. Assign labels + milestone
3. Link to project board
4. Implement on topic branch
5. Open PR with `Closes #N`
6. Merge only after gate suite + checklist complete

No direct work on `main` without a linked issue.
