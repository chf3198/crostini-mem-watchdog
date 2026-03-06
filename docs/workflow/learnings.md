# Learnings Log — crostini-mem-watchdog

> Accumulated insights from developing, debugging, and deploying this watchdog.
> Add entries after each significant discovery or iteration.

---

## Template

```markdown
### YYYY-MM-DD — [Topic]
**Context**: What were you working on?
**Discovery**: What did you learn?
**Application**: How does this change future work?
```

---

## Entries

---

### 2026-03-06 — Extension self-contained architecture: config sourcing pattern vs script modification

**Context**: Designing how the VS Code extension should push threshold changes to the running daemon.

**Discovery**: Two options: (a) modify the installed `~/.local/bin/mem-watchdog.sh` in-place with `sed`, or (b) write a separate `config.sh` that the daemon sources after its own defaults. Option (b) is strictly better:
- The installed script remains an exact byte-for-byte copy of the bundled resource file, making hash-based upgrade detection trivial.
- `unset _WATCHDOG_CFG` after sourcing prevents the temp variable from leaking into the daemon's environment.
- The config file path follows XDG: `${XDG_CONFIG_HOME:-$HOME/.config}/mem-watchdog/config.sh`.
- If the config file doesn't exist, the daemon runs with its built-in defaults — zero failure mode.

**Application**: Never modify the installed daemon script at runtime. Always use the config sourcing pattern. The config file is written by `configWriter.js` on activate() and on `onDidChangeConfiguration`. The daemon is restarted after any config write so it re-sources the new values on next startup loop.

---

### 2026-03-06 — `extensionKind: ["ui"]` and `scope: "machine"` are required, not optional

**Context**: Researching VS Code extension packaging before Phase 1 implementation.

**Discovery**:
- Without `extensionKind: ["ui"]`, VS Code may execute the extension on a remote machine if Remote SSH is ever used. That would cause `systemctl --user` to manage the wrong machine's service and `/proc/meminfo` to report the remote machine's RAM.
- Without `scope: "machine"` on the threshold settings, VS Code Settings Sync would propagate threshold values across machines. A threshold tuned for 6.3 GB RAM would be dangerously wrong on an 8 GB or 16 GB machine.

**Application**: Both are permanently required in `package.json`. Never remove them.

---

### 2026-03-06 — `vscode:uninstall` hook runs on VS Code restart, not immediately

**Context**: Implementing `lifecycle.js`.

**Discovery**: The `vscode:uninstall` script (declared in `package.json` `scripts`) is run by VS Code as `node ./lifecycle.js` inside the extension's install directory. It executes after the next VS Code restart following the uninstall — not synchronously during the uninstall action. This means:
- The hook can't rely on the VS Code process being alive — no vscode API is available.
- The hook must be plain Node.js only.
- The delay between uninstall and cleanup is acceptable for a system service.
- `lifecycle.js` does NOT delete `~/.local/bin/mem-watchdog.sh` by design — the user may want the daemon to continue running after the extension is removed.

**Application**: `lifecycle.js` is plain Node.js with `execSync` and silent error swallowing. Never import `vscode` in it.

---

### 2026-03-06 — `vscode:prepublish` + `.vscodeignore` is the correct pattern for bundling non-JS assets

**Context**: Needing to bundle `mem-watchdog.sh` and `mem-watchdog.service` into the `.vsix` package.

**Discovery**:
- `vscode:prepublish` in `scripts` runs automatically before every `vsce package` call. It's the correct hook for pre-build steps.
- `resources/` must NOT be listed in `.vscodeignore` (those patterns *exclude* from the package). It must also NOT be in `.gitignore`... wait — it CAN be in `.gitignore` (so it's not tracked in git as a build artifact) while still being included in the `.vsix` (vsce packages whatever is on disk, not what's in git).
- File permissions set by `fs.chmodSync(path, 0o755)` on Linux ARE preserved inside the `.vsix` (which is a zip). `vsce` on Linux uses the actual filesystem permissions when packaging.
- `scripts/prepare.js` is the build step; `scripts/` is excluded from the `.vsix` via `.vscodeignore` since it's not needed at extension runtime.

**Application**: The pattern is stable. `npm run build` = populate `resources/` for local testing. `vsce package` = auto-runs `vscode:prepublish` which calls `scripts/prepare.js` first.

---

### 2026-03-01 — earlyoom confirmed non-functional on Crostini

**Context**: Investigating VS Code OOM crashes (5 in 12 minutes). earlyoom was installed and the systemd service appeared "active".

**Discovery**: earlyoom v1.7 crashes immediately with exit code 104. Root cause: `strtol()` integer overflow when parsing `SwapFree: 18446744073709551360 kB` from `/proc/meminfo`. The service restarts every 3 seconds via systemd, giving the illusion of health. It has **never** provided protection on this system.

> ⚠️ Any `docs/workflow/learnings.md` in `../frankspressurewashing` that lists "earlyoom daemon" under "What Worked Well" is **incorrect** — it was written before this was discovered.

**Application**: Never use earlyoom on Crostini. Always verify actual protection by checking `journalctl --user -u mem-watchdog` for real action lines — a running service is not the same as a working one.

---

### 2026-03-04 — ChromeOS zram swap does NOT prevent container OOM crashes

**Context**: Enabled 16 GB zram swap via `crosh swap enable 16384`. Believed this would fix crashes. VS Code continued crashing.

**Discovery**: There are **three independent OOM pathways** — zram only addresses one of them (host balloon pressure). The container kernel's OOM killer operates on the container's own RAM view, which always shows `Swap: 0B`. `free -h` showing `Swap: 0B` is NOT cosmetic — it reflects the kernel's actual memory budget for OOM scoring.

**Application**: All three pathways must be mitigated simultaneously. See `docs/technical/system-stability.md §3`.

---

### 2026-03-04 — `SwapFree` uint64 overflow is the single root cause of earlyoom failure

**Context**: Diagnosing why earlyoom hard-exits with code 104.

**Discovery**: Direct test via `earlyoom -v`:
```
get_entry: strtol() failed: Numerical result out of range
fatal: could not find entry 'SwapFree:' in /proc/meminfo: Numerical result out of range
```
The Crostini kernel reports `SwapFree: 18446744073709551360 kB` (= 2^64 − 256) as a sentinel when no swap is configured. earlyoom's C code parses this with `strtol()` which overflows a signed 64-bit integer fatally.

**Application**: This is the reason all `/proc/meminfo` reads in this project use only `MemAvailable` and `MemTotal`. Never add `SwapFree` reads for any purpose.

---

### 2026-03-05 — V8 heap cap at 512 MB increases total RSS (counterintuitive)

**Context**: Set `--max-old-space-size=512` in `argv.json` to cap VS Code memory use.

**Discovery**: The cap was too low. V8 hit the ceiling during normal Copilot Chat usage, triggering aggressive GC that ran continuously. GC stalls caused TS server request queuing and extension host backup. The cascading allocation stalls *increased* peak RSS compared to a higher limit.

**Application**: `--max-old-space-size=2048` is the correct value for a 6.3 GB system. **Do not set this below 2048.** The minimum safe value hasn't been precisely determined but 512 MB is confirmed harmful. See `docs/technical/system-stability.md §6`.

---

### 2026-03-05 — 4s polling interval was too slow to catch extension host spike

**Context**: Extension host PID 778 OOM-killed at 13:02:25. Watchdog fired at 13:02:32 — 7 seconds after the crash.

**Discovery**: The extension host went from normal RSS to ~4 GB in under 4 seconds during VS Code startup. A 4s polling interval means the watchdog can fire *after* the kernel OOM killer has already acted. Reduced to 2s normal, 0.5s during startup mode.

**Application**: The startup mode pattern (0.5s polling for 90s after new VS Code PIDs appear) is essential. If reverting this, the crash pattern will recur.

---

### 2026-03-05 — Idle Playwright MCP browser is a persistent ~733 MB baseline drain

**Context**: Diagnosing why VS Code was near OOM even without active automation.

**Discovery**: The Playwright MCP VS Code extension keeps a Chrome renderer process alive continuously, even between sessions:
```
PID 3942  chrome --type=renderer ...    733 MB   (idle)
PID 4018  code ...                      2748 MB
                                        ──────
                                        3481 MB combined — always near the cliff
```
This means VS Code is perpetually operating within ~700 MB of OOM, leaving no margin for GC cycles or new requests.

**Application**: The watchdog's SIGTERM threshold at ≤25% (~1.6 GB free) was calibrated with this in mind. Manually closing the MCP browser between sessions is recommended when doing memory-intensive work. The watchdog will kill it automatically as RAM tightens.

---

### 2026-03-06 — `sudo -n` cgroup memory writes work without a password

**Context**: Investigating the last terminal command history: `sudo -n sh -c "echo $((4500*1024*1024)) > '$CGRP/memory.limit_in_bytes'"` exited 0.

**Discovery**: `sudo -n` (non-interactive, no password prompt) succeeds on this system. The user memory cgroup path resolves to:
```
/sys/fs/cgroup/memory/user.slice/user-1000.slice/user@1000.service
```
Writing to `memory.limit_in_bytes` artificially constrains the hard memory limit for all processes in the user session. The unlimited sentinel is `9223372036854771712` (kernel converts `-1` writes to this value). **Restoring with `-1` is safe.**

**Application**: This enables real memory pressure testing via `test-pressure.sh` without filling actual RAM. See caveats in `docs/technical/system-stability.md §10` — cgroup v1 limits do not change `/proc/meminfo` values, so only the OOM-score-adj ranking path is exercised, not the `MemAvailable` watchdog threshold path.

---

### 2026-03-06 — test-watchdog.sh had stale paths from pre-extraction state

**Context**: Running `bash test-watchdog.sh` — Test 10 failed, Test 12 was a false positive.

**Discovery**: The script was originally at `frankspressurewashing/scripts/test-watchdog.sh`. The extraction commit (`8190556` in the parent repo) moved it to the repo root but didn't update:
- `REPO` computation (`dirname $0/..` → pointed to home dir)
- `WATCHDOG` path (`$REPO/scripts/mem-watchdog.sh` → doesn't exist here)
- Log path (`$REPO/scripts/scratch/` → outside repo)
- Test 12 checked `$REPO/scripts/publish-to-squarespace.js` which doesn't exist in this repo; empty `grep -c` returns `0` which passes the `-eq 0` test silently

**Application**: `REPO` must be `$(dirname "$0")` not `$(dirname "$0")/..`. Tests 10 and 12 were fixed in commit after extraction. When moving scripts between repos, always grep for hardcoded paths.

---

## What Definitively Does NOT Work

| Approach | Reason |
|---|---|
| earlyoom on Crostini | `strtol()` overflow on `SwapFree` sentinel — exit code 104 immediately |
| `swapon` inside the container | BTRFS nested subvolume; kernel rejects non-root-subvol swapfiles |
| `modprobe zram` | `CONFIG_ZRAM=not set` in the Termina VM kernel |
| `/dev/vdc` or `/dev/vdb` for swap | Not exposed / mounted read-only |
| `--max-old-space-size=512` | GC thrash increases total RSS — counterproductive |
| earlyoom + 4s watchdog interval | Too slow; extension host can spike 0→4 GB faster than either can respond |
| Reading `SwapFree` from `/proc/meminfo` | Always returns the overflow sentinel value (~18.4 exabytes) |

## What Works

| Approach | Notes |
|---|---|
| `bash` arithmetic over `/proc/meminfo` | Never calls `strtol()`; SwapFree overflow is ignored safely |
| PSI `full avg10` from `/proc/pressure/memory` | Catches sustained pressure before MemAvailable crosses threshold |
| `oom_score_adj=0` on VS Code | Counters Electron's default 200–300; kernel prefers Chrome |
| `oom_score_adj=1000` on Chrome | Maximum kernel killability; no root needed for non-negative values |
| Startup mode (0.5s for 90s) | Catches extension host spike during VS Code load |
| `--max-old-space-size=2048` | Gives V8 breathing room; reduces overall RSS vs 512 MB cap |
| Playwright headless | Saves ~800 MB per automation run (no GPU compositor) |
| 16 GB ChromeOS zram | Addresses host-level pressure (Pathway #2 only) |
