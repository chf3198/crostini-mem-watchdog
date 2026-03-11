## What does this PR do?

<!-- One sentence description. -->

## Closes

<!-- Required — no orphan PRs. Every PR must trace to an issue. -->

Closes #

## Tracking

<!-- Required before merge -->

- [ ] Milestone assigned
- [ ] Labels applied: one taxonomy label (`type: epic|research|task|bug-fix`) + `priority:*` + at least one domain label (`policy` / `psi` / `cgroup` / `oom` / `testing` / `research` / `crostini`)
- [ ] Commit messages follow `type(scope): description` convention
- [ ] Client UAT requirement acknowledged: release is blocked until client confirms UAT pass

## Motivation

<!-- Why is this change needed? What crash, failure mode, or limitation does it address? -->

## Gate suite results

All four checks must exit 0 before this PR is ready for review.

- [ ] `bash test-watchdog.sh` — 12 bash tests (run from repo root)
- [ ] `bash -n mem-watchdog.sh` — bash syntax check
- [ ] `shellcheck --shell=bash -e SC1091,SC2317 mem-watchdog.sh watchdog-tray.sh install.sh`
- [ ] `cd vscode-extension && npm test` — 54 JS unit tests

## Invariants confirmed

- [ ] `SwapFree` is not read anywhere in this diff
- [ ] `systemctl --user` used (not `sudo systemctl`)
- [ ] No new VS Code settings added without `scope: "machine"`
- [ ] No `/tmp` writes added to `mem-watchdog.sh`
- [ ] `STARTUP_DEBOUNCE` not lowered below 300 without a compensating PID filter

## What I did NOT test

<!-- Be explicit: what edge cases, OOM scenarios, or startup-mode interactions
did you not exercise? This is required — "everything" is not an acceptable answer. -->

## Critique

<!-- Following the 4-C rule (Code → Critique → Correct → Commit): what did your
self-review catch, and what did you fix as a result? -->

## Client UAT (required before release)

- [ ] Client consultation completed if design-impacting
- [ ] Client UAT executed
- [ ] Client UAT result: PASS (required before release tag/publish)
