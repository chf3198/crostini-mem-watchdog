# AGENTS.md — crostini-mem-watchdog

## Agent startup protocol (required)

1. Load repository baseline instructions from .github/copilot-instructions.md before planning edits.
2. Use global skills from ~/.copilot/skills as the primary reusable capability layer.
3. Route workflow using these skills in order:
   - `repo-standards-router` (classify work type and gates)
   - `workflow-self-anneal` (only after failures/process mismatch)
4. Follow repository non-negotiables:
   - never read `SwapFree`
   - never call `systemctl` without `--user`
   - preserve daemon interruptible sleep (`sleep ... & wait`)
   - use integer-only shell math for thresholds/PSI
5. Validate changes with the project gates in .github/copilot-instructions.md.

## Repository-specific scope

This repository has a strict boundary:
- `mem-watchdog.sh` is the runtime watchdog daemon.
- `vscode-extension/` manages install/config/status UX.

Do not move watchdog runtime behavior into the extension.

## Edit discipline

- Keep changes minimal and localized.
- Preserve action log tokens (`ACTION(SIGTERM):`, `ACTION(SIGKILL):`) for journal analysis.
- If daemon behavior changes, bump `WATCHDOG_VERSION` in mem-watchdog.sh.
- Record significant discoveries in docs/workflow/learnings.md.
