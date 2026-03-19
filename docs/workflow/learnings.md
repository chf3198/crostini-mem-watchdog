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

### 2026-03-19 — `.env` in VSIX bundle: credential leak blocked by vsce, silent in git

**Context**: Publishing `CurtisFranks.mem-watchdog-status v0.3.3` to the VS Code Marketplace for the first time since `.env` was added to the extension directory.

**Discovery**: `vsce publish` hard-blocked with `ERROR: .env files should not be packaged.` The `.env` file (`VSCE_PAT=<Azure DevOps PAT>`) and `.env.example` were not in `.vscodeignore`. vsce includes all non-ignored files — it does not have a built-in exclusion for `.env` (unlike `package-lock.json`, `*.vsix`, `.github/`, `node_modules/`, and devDependencies which ARE auto-excluded). Without the block, the PAT would have been visible inside the `.vsix` archive to anyone who unpacked it and to VS Code extension host processes on install.

Two layers of risk:
1. **Direct PAT exposure**: anyone who installs the extension and extracts the VSIX gets the literal `VSCE_PAT` value
2. **Extension host environment**: VS Code loads the extension from its install directory; `.env` files in that directory are accessible to the extension process and potentially to other extensions

`.gitignore` had `.env` excluded (so it was never committed), but `.vscodeignore` is a separate gating file and did not have it.

**Fix**: Added to `.vscodeignore` under the `publish.sh` comment block:
```
publish.sh
.env
.env.example
```

**Application**: For any VS Code extension that uses a `.env` for publish credentials: add `.env` and `.env.example` to `.vscodeignore` at the same time the file is created — not at first publish. Run `vsce ls` before every new publish to confirm the bundle manifest before the actual upload. Note: `vsce ls` does NOT require the PAT and can be run at any time as a pre-flight check.

---

### 2026-03-07 — Zero-fork service status: cgroup.procs vs exec() benchmark

**Context**: Deep memory usage analysis of the VS Code extension. Looking for ways to reduce CPU and heap pressure from the `update()` hot path, which runs every 2 s (0.5 s in startup mode).

**Discovery**: The status check `exec('systemctl --user is-active mem-watchdog')` cost measured on this hardware:
- **exec() (current)**: 8.7 ms/call avg, ~308 KB heap Δ per 100 calls — and `fork()` can fail with `ENOMEM` under extreme OOM, making the check unreachable exactly when it matters most
- **`cgroup.procs` read**: 14.5 µs/call, ~42 KB heap Δ per 100 calls — 600× faster, pure `fs.readFileSync`, zero forks
- **`/proc/PID/cmdline` access**: 2.02 µs/call — fastest, but requires PID refresh when service restarts

`cgroup.procs` is the correct choice: it survives service restarts without PID tracking, and if the file exists and is non-empty (has PIDs) the service is active; ENOENT means inactive.

The **path derivation** is the tricky part. The extension process runs inside a Chromium scope cgroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-NNN.scope`. Naively stripping the last segment gives the wrong path. The correct anchor is `/app.slice` — the mem-watchdog service lives at that same level:
```
/sys/fs/cgroup/systemd
  + rel.slice(0, rel.indexOf('/app.slice') + '/app.slice'.length)
  + '/mem-watchdog.service/cgroup.procs'
```
This path is derived once at module load from `/proc/self/cgroup` and cached in `_cgroupPath`. The fallback to `sh()` handles non-cgroup-v1 or remote extension host environments.

Daily cost comparison at 43,200 calls/day (2 s polling): exec = 375 ms CPU, cgroup = <1 ms CPU.

**Application**: Any extension hot-path that polls system state should prefer direct procfs/cgroupfs reads over `exec()`. The `fork()` failure risk under OOM is not hypothetical — it's the exact failure mode a memory watchdog must be resilient to. Always derive and validate the cgroup path at startup so the path resolution cost is paid once.

---

### 2026-03-07 — Startup mode debounce: 567 activations/day from language server PIDs

**Context**: Forensic investigation after reported VS Code crash. Journal showed 567 "startup mode active" entries in 24 hours.

**Discovery**: VS Code spawns new `code` subprocesses throughout normal development — TypeScript language servers, ESLint workers, GitLens index workers, etc. Each new PID triggered `adjust_oom_scores()` to fire startup mode (0.5 s polling + pre-emptive Chrome SIGTERM). With frequent language server spawning, the daemon was in perpetual startup mode:
- 0.5 s polling all day = 4× more CPU and `ps`/`pgrep` fork calls than 2 s polling
- Spurious Chrome SIGTERMs during active work sessions
- Journal flooded with "startup mode active" entries masking real events

Root cause: no debounce between startup mode activations. The 90 s window would expire, a language server would spawn, immediately triggering a new 90 s window.

**Fix**: `STARTUP_DEBOUNCE=300` — startup mode can only fire once per 5 minutes regardless of how many new `code` PIDs appear. Language servers persist after first spawn, so the debounce has no real-world effect on genuine VS Code startup protection.

**Application**: Any PID-detection loop that triggers mode switches needs a minimum activation interval. The "new PID" signal is too broad — it fires for subprocesses and workers, not just for new application windows.

---

### 2026-03-07 — Foreground `sleep` in bash daemons defers SIGTERM traps

**Context**: `systemctl stop mem-watchdog` was waiting the full 90 s systemd default before issuing SIGKILL. Journal showed `State 'final-sigterm' timed out. Killing.`

**Discovery**: When bash executes a foreground external command (`sleep 2`), SIGTERM is deferred until the subprocess exits. A `trap '...' TERM` handler doesn't fire until `sleep` finishes — up to 2 s normal, 0.5 s in startup mode. This hit systemd's default `TimeoutStopSec=90` on service restart.

**Fix** (canonical interruptible pattern):
```bash
_sleep_pid=''
trap '[[ -n "${_sleep_pid:-}" ]] && kill "$_sleep_pid" 2>/dev/null; exit 0' TERM INT

# In the main loop:
sleep "$eff_interval" & _sleep_pid=$!
wait "$_sleep_pid" || true
```
`wait` is a shell builtin — bash processes signals during `wait` immediately. When SIGTERM fires, `wait` returns, the trap kills the background sleep, and `exit 0` terminates cleanly within milliseconds.

Also added `TimeoutStopSec=10` to the service unit as belt-and-suspenders.

**Application**: Any long-running bash loop that sleeps must use `sleep & wait $!` + a trap that kills `$_sleep_pid`. Never use foreground `sleep` in a daemon. Always set `TimeoutStopSec` to a reasonable value in the service unit.

---

### 2026-03-07 — readMeminfo split+loop is 30× slower than two /m regex

**Context**: bench_meminfo.js benchmark run during memory usage analysis.

**Discovery**: The original `readMeminfo()` split every `/proc/meminfo` line and matched a general regex against each:
- **Method A** (split+loop): 4 795 ms / 500k calls = 9.59 µs/call, 349 bytes heap/call
- **Method B** (two `/m` regex): 156 ms / 500k calls = 0.31 µs/call, 29 bytes heap/call

30× faster, 12× less heap. At 2 s polling this is negligible for latency but during startup mode (0.5 s) the GC pressure difference is meaningful. Method B is also cleaner to read.

**The D (indexOf + trimStart) approach had a bug**: `indexOf('MemTotal:')` matches at position 0 (start of file, no leading `\n`), but the implementation had `indexOf('\nMemTotal:')` which fails for the first field. Method B avoids this entirely with anchored `^` + `/m` flag.

**Application**: Prefer two targeted anchored `/m` regex over split+iterate for `/proc/meminfo` parsing. The `^` anchor with `/m` is the key — it anchors to the start of any line in the multiline string, preventing false matches inside numeric value fields.

---

### 2026-03-06 — Pre-publish doc/packaging audit: what vsce auto-excludes

**Context**: Pre-v0.3.0 audit of `.vscodeignore`, documentation, and file health.

**Discovery**: `vsce` has a built-in `defaultIgnore` list that automatically excludes many files from the `.vsix` without needing entries in `.vscodeignore`. Confirmed items auto-excluded: `package-lock.json`, `yarn.lock`, `**/.git/**`, `**/*.vsix`, `.github/`, `.vscode-test/**`, and all `devDependencies`. Items that are NOT auto-excluded and must be manually added: `test/` directories, `publish.sh`, CI scripts.

Before the fix, `vsce ls` showed the `test/` directory (6 files, ~25 KB) and `publish.sh` bundled into every installed extension unnecessarily.

**Application**: When adding new dev-only files/directories, always check `vsce ls` before publishing. The `.vscodeignore` blacklist approach is the right one (whitelist via `files` in `package.json` would conflict — vsce errors if both are present).

---

### 2026-03-06 — Duplicate JSDoc stale block: always delete the old one after editing

**Context**: Reviewing `configWriter.js` pre-publish.

**Discovery**: `configWriter.js` had two consecutive `/** ... */` JSDoc blocks for the same `writeConfig` function — the original single-param version (lacking `@returns`) followed by the updated version (with cross-field validation docs and `@returns`). The old block was never removed when the function signature was extended. This is invisible to `npm test` but confuses IDEs and documentation generators — hover docs show the stale description.

**Application**: When updating a function signature that already has a JSDoc block, delete the old block in the same edit. Never leave two `/**...*/` blocks above one function.

---

### 2026-03-06 — publish.sh PUBLISHER var was misleading (echoed but unused by vsce)

**Context**: Reviewing `publish.sh` pre-publish.

**Discovery**: The script set `PUBLISHER="${VSCE_PUBLISHER:-chf3198}"` from `.env`, echoed it, but never passed it to `vsce publish`. The publisher identity is read from `package.json "publisher"` by `vsce` automatically — the shell variable had no effect on the actual publish command. Worse, `VSCE_PUBLISHER=chf3198` in `.env` was stale (the real publisher is `CurtisFranks` as set in `package.json`). This could mislead an operator checking the script output.

**Fix**: Replaced with `node -e "process.stdout.write(require('./package.json').publisher)"` to read the authoritative value directly from `package.json`.

**Application**: Never maintain a separate publisher variable in shell scripts — it will drift. Read from `package.json` or document that `vsce` handles it automatically.

---

### 2026-03-06 — Unit tests for extension.js: pileup guard is the highest-value test

**Context**: Stress testing the watchdog extension — adding `extension.test.js`.

**Discovery**: The `_updating` pileup guard in `extension.js` is the most operationally critical logic to test: under OOM pressure, `systemctl --user is-active` can take seconds, and the 2-second `setInterval` can stack many concurrent `update()` calls. Each call spawns a `child_process.exec`, consuming ~2 MB RSS per call — exactly the kind of cascade that accelerates OOM under pressure. Testing that 20 concurrent calls produce exactly 1 `sh()` invocation (not 20) is the highest-value assertion in the entire test suite.

The test required a `_test` seam in `extension.js`: `module.exports._test = { update, POLL_INTERVAL_MS }` gated behind `process.env.MEM_WATCHDOG_TEST`. The key insight is that `require.cache` injection is sufficient — no need for a `_setCheckServiceFn` seam if the `sh` mock is injected at the utils module level before `extension.js` is loaded.

**Application**: Any timer-driven function that calls external processes needs a pileup guard and a test that exercises it under concurrent invocations. The `/* c8 ignore next */` annotation on the test-seam line prevents it from appearing as an uncovered branch in coverage reports.

---

### 2026-03-06 — PASS/FAIL macro `set -e` incompatibility: pre-increment vs post-increment

**Context**: Fixing `test-pressure.sh` during stress testing.

**Discovery**: `((pass++))` uses post-increment: it evaluates to the value of `pass` *before* the increment. When `pass=0`, this evaluates to `0` (false in bash arithmetic context), causing `set -e` to exit the script immediately after the first `PASS()` call. The fix is pre-increment: `((++pass))` evaluates to the value *after* incrementing — always ≥ 1 when pass starts at 0. The same issue applies to `fail++`.

Similarly, `[[ "$cond" == "value" ]] && continue` in a `for` loop body — when the condition is false, the `&&` short-circuits to false (exit code 1), triggering `set -e` and aborting the loop. The fix is `if [[ "$cond" == "value" ]]; then continue; fi`.

**Application**: Under `set -e`, never use post-increment (`i++`) for counter variables that start at 0. Never use `[[ condition ]] && statement` in loop bodies — always use `if/then/fi`. Run `bash -x script.sh` to trace failures when `set -e` causes mysterious early exits.



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

---

### 2026-03-07 — Zero-fork bash patterns for OOM-resilient test instrumentation

**Context**: `test-pressure.sh` `snapshot()` function was calling ~190 external processes per checkpoint (date, ps, awk, wc, cat, tr, systemctl). Under real OOM pressure, each fork risks `ENOMEM`, defeating the purpose of a memory pressure test's instrumentation.

**Discovery**:
- **`$EPOCHSECONDS`** (bash 5.0+) is a magic variable maintained by bash itself — zero syscall, zero fork. Replaces `$(date +%s)` entirely.
- **`/proc/[0-9]*/status` glob** inside a `for f in ...` loop reads all process status files directly in bash with `while IFS= read -r line < "$f"` — replaces the entire `ps -C code | awk | wc -l | tr` pipeline. Zero forks, no page cache pressure.
- **`read -r < /proc/$PID/stat`** replaces `cat /proc/$PID/stat` — avoids the subshell fork for single-file reads.
- **`wd_cpu_ticks`** = sum of `utime` + `stime` fields (fields 14 and 15) from `/proc/$WD_PID/stat` — a raw tick count that is diffable across intervals to compute interval CPU rate, replacing the `ps %cpu` snapshot which is a non-monotonic instantaneous estimate.
- **`monitorEventLoopDelay`** (Node.js `perf_hooks`) uses a `uv_timer_t` on the main V8 thread, not a Worker thread. Its RSS cost is part of the main process heap. `Number.isFinite()` guards are required on all histogram percentile reads — the histogram returns `NaN` until at least one sample has been recorded.
- **Result**: `WD_PID` resolved once at test-suite start (one `systemctl` call); all subsequent per-checkpoint reads are pure procfs with no external processes.

**Application**: In any bash script that runs under the conditions it is monitoring (memory pressure, CPU saturation), replace all `$(command)` substitutions with direct `/proc` reads and bash built-ins. The `$EPOCHSECONDS` + `read -r < /proc/file` + glob-loop pattern covers the majority of system-state queries with zero forks.

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

---

### 2026-03-08 — Log system design: five gaps in the initial journald configuration

**Context**: Deep research into optimal log system design for low-resource environments, applied to the full logging stack (journald, per-unit service settings, scratch/ test logs, tmpfiles.d).

**Discovery — five specific gaps:**

1. **File-level journald controls were absent.** `SystemMaxUse=100M` caps total size but without `SystemMaxFileSize` and `SystemMaxFiles`, the defaults are `SystemMaxFileSize=12.5M` (1/8 of SystemMaxUse) and `SystemMaxFiles=100` — allowing 100 archives × 12.5 MB = 1.25 GB before the total cap activates. Added `SystemMaxFileSize=16M` and `SystemMaxFiles=5`, producing at most 5 + 1 files × 16 MB = 96 MB maximum.

2. **`SystemKeepFree` was missing.** journald does not back off automatically when disk is nearly full unless `SystemKeepFree` is set. On a constrained Crostini container approaching storage limits, journald would continue writing until the filesystem is full. Added `SystemKeepFree=500M`.

3. **`LogRateLimitBurst=100` on the service unit was wrong in two ways.** First, when the burst limit is hit, journald drops ALL subsequent messages in that interval — including CRIT/EMERG priority lines. There are no priority exemptions from rate limiting. Second, the daemon is architecturally self-rate-limiting (it only logs on kill events and threshold crossings, never on every poll cycle), so a burst cap adds risk without any correctness benefit. Changed to `LogRateLimitBurst=0` (disabled at the unit level). The system-wide `RateLimitBurst=500` in journald.conf provides sufficient protection against other runaway services.

4. **`find -mtime +N` has a floor-division precision bug.** `find -mtime +7` means files older than **8 days** (POSIX: floor((now - mtime) / 86400) > 7). A day-long development sprint can accumulate dozens of files before the age limit activates — age-only limiting is insufficient. Fixed by: (a) replacing `-mtime` with `-mmin +43200` (exact 30-day precision), and (b) adding count-based pruning using `find … -printf '%T@ %p\n' | sort -rn` to keep the N newest files — protects against same-day accumulation regardless of age.

5. **journald vacuum doesn't work without `--rotate` first.** `journalctl --vacuum-size` and `--vacuum-time` only remove *archived* journal files. The active `.journal` file is never touched. Without calling `journalctl --rotate` first to archive the active file, a `--vacuum-size=95M` call on a 260 MB journal would free zero bytes. Added `journalctl --rotate && journalctl --vacuum-size=95M --vacuum-time=3d` immediately after installing the drop-in.

**Bonus discovery — tmpfiles.d `e` type for persistent daily cleanup:**
`systemd-tmpfiles-clean.service` runs daily via the user systemd session (present on Crostini/Debian 12 by default). The `e` directive type adjusts an existing directory by removing files matching the age criterion. Using `m:30d` (modification-time-only prefix) prevents directory reads from resetting the age clock. This provides a persistent backstop independent of whether tests are run, installed to `~/.config/user-tmpfiles.d/mem-watchdog-scratch.conf` by `install.sh`.

**Application**: For any log system on a constrained host:
- Always set both `SystemMaxUse` AND `SystemMaxFileSize`+`SystemMaxFiles` — total cap and per-file rotation cadence are independent knobs.
- Always set `SystemKeepFree` — journald does not self-throttle under disk pressure otherwise.
- Use `LogRateLimitBurst=0` for self-rate-limiting services where missing a CRIT message is worse than a brief flood.
- Use `-mmin` not `-mtime` in `find` for time-based file management.
- Count-based pruning (`sort | tail -n +N+1 | xargs rm`) is the right first tier; age-based is the backstop second tier.
- Always `journalctl --rotate` before `--vacuum-*` — vacuum only touches archived files.

---

### 2026-03-11 — Public contribution lineage requires explicit ticket taxonomy, not just labels
**Context**: The repository had strong coding and test discipline, but visitor-visible contribution flow was incomplete. Existing workflow artifacts (labels, milestones, project) were present, yet issue intake and PR governance did not force consistent category visibility across Epic/Research/Task/Bug-fix.

**Discovery**:
1. **Project board + milestones alone are insufficient for auditability.** Without explicit type labels and templates, issue intent drifts and the history reads as a flat list of enhancements.
2. **PR linkage must require taxonomy, not only priority/domain labels.** Requiring `Closes #N` is necessary but not enough; contributor history still becomes ambiguous unless each issue declares its work class.
3. **Issue template UX is the primary enforcement point for public visitors.** `ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: false` ensures every new ticket enters the same structured flow.
4. **Epics must exist as first-class tickets** (not just milestone names) to keep parent/child lineage visible directly in issue history and project views.

**Application**:
- Added issue templates for `type: epic`, `type: research`, `type: task`, `type: bug-fix`.
- Added/normalized type labels in the repository and backfilled active issues.
- Created explicit milestone epics (#17, #18, #19) and linked them to project tracking.
- Updated PR checklist and contributor docs to require taxonomy + milestone + label coverage for every PR.
- Added `docs/workflow/repo-admin-playbook.md` as the canonical admin process for repository transparency.
