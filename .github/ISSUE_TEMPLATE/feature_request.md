---
name: Feature request
about: Suggest an improvement or new capability
title: "[Feature] "
labels: enhancement
assignees: chf3198
---

## Problem statement

<!-- What problem would this feature solve? Be specific: what crash, failure mode,
or workflow gap are you experiencing? -->

## Proposed solution

<!-- Describe the change you'd like. If it touches mem-watchdog.sh, note whether
it keeps to bash + coreutils with no external deps. If it touches the extension,
note whether it affects the statusbar poll path (hot path — every 2 s). -->

## Alternatives considered

<!-- What other approaches did you consider and why did you rule them out? -->

## Platform constraints to keep in mind

- The daemon must remain a separate systemd user process (the extension host
  freezes under OOM; the daemon's independence is the protection).
- Never read `SwapFree` from `/proc/meminfo` — Crostini reports ~18.4 exabytes
  (uint64 overflow sentinel). Only `MemAvailable` and `MemTotal` are safe.
- All VS Code settings must use `scope: "machine"` to prevent Settings Sync from
  propagating hardware-specific thresholds to other machines.

## Additional context

<!-- Screenshots, links, related issues, etc. -->
