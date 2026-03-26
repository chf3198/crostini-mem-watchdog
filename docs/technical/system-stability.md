# VS Code / Crostini Memory Stability — Technical Reference

**Environment:** Chromebook (i3-N305, 8 cores, 6.3 GB RAM) · ChromeOS Crostini (Debian 12 Bookworm, kernel 6.6.99) · VS Code 1.108.0  
**Last updated:** 2026-03-25  
**Swap status:** 16 GB zram enabled at ChromeOS host layer via `crosh swap enable 16384` (2026-03-04). `free -h` inside the container always shows `Swap: 0B` — this is **NOT cosmetic** (see §3).

---

## 1. Root Cause of Crashes

**The container kernel OOM killer terminated VS Code processes because physical RAM visible to the container was exhausted.**

### Confirmed evidence (dmesg, 2026-03-05 13:02:25)

```
[ 2610.439831] code invoked oom-killer
[ 2610.522581] Out of memory: Killed process 778 (code)
               total-vm:1463369736kB, anon-rss:4087536kB, oom_score_adj:0
```

### Memory budget during a Playwright automation session

| Process | RAM |
|---|---|
| VS Code main + renderers | ~1,000 MB |
| Copilot Chat extension host | ~700 MB |
| TypeScript servers (×2) | ~200 MB |
| Other extensions (ESLint, GitLens, etc.) | ~300 MB |
| Playwright MCP server | ~100 MB |
| **Chrome (launched for automation)** | **~1,400 MB** |
| **Total peak** | **~3,700–4,200 MB** |

Total container RAM: **6,300 MB** with **0 MB swap visible to the container kernel**.

---

## 2. Why earlyoom Doesn't Work Here

**earlyoom v1.7 crashes immediately on Crostini with exit code 104.** It has provided zero protection across 20+ crashes spanning 6 days before being disabled.

Root cause: The Crostini kernel reports a `uint64` overflow sentinel for `SwapFree` when no swap is configured:

```
/proc/meminfo → SwapFree: 18446744073709551360 kB   ← 2^64 − 256
```

earlyoom passes this to C's `strtol()` → signed 64-bit overflow → fatal exit. Systemd restarts it every 3 seconds. **earlyoom is crash-looping and providing zero protection.**

**Why bash is safe:** bash's `$(( ... ))` arithmetic reads the SwapFree string and discards it — the value is never used in any calculation. Only `MemAvailable` and `MemTotal` are used, both of which are correct on this kernel.

---

## 3. Three Independent OOM Pathways

> This is the most important architectural insight. Missing any one of the three allows VS Code to crash.

| # | Pathway | Killed by | Fixed by ChromeOS zram? |
|---|---|---|---|
| 1 | Container kernel OOM: `MemAvailable` inside the LXC container drops to zero | `oom-killer` → SIGKILL | ❌ No |
| 2 | ChromeOS host memory pressure → balloon driver shrinks VM → VM OOM | ChromeOS balloon driver | ✅ Partially |
| 3 | V8 heap exhaustion at the 512 MB cap → GC thrash → allocation failure | V8 OOM handler | ✅ Fixed (set to 2048 MB) |

### Why `free -h` showing `Swap: 0B` is NOT cosmetic

The Crostini stack is three layers deep:

```
ChromeOS Host (KVM hypervisor)
├── zram0 swap (16 GB compressed) ← lives HERE
└── Termina VM (KVM guest)
    └── LXC container "penguin" (Debian 12 — where VS Code runs)
        └── free -h → Swap: 0B  ← the container kernel's REAL view
```

ChromeOS zram only addresses Pathway #2. The **container kernel's OOM killer** operates entirely on the container's view of RAM — it has no knowledge of host-level zram. When `MemAvailable` drops below reservation thresholds inside the container, the kernel selects and kills the highest-scoring process (VS Code — largest RSS) **regardless of what the host is doing**.

**This was initially diagnosed wrong.** The first analysis claimed `Swap: 0B` was cosmetic. VS Code continued crashing after zram was enabled, which proved it wrong.

---

## 4. Crostini Swap Limitation (Why You Can't Add Swap Inside the Container)

All swap-enabling routes inside the container are blocked:

| Approach | Blocker |
|---|---|
| `swapon /swapfile` | `/swapfile` is on BTRFS subvolid=258 (LXD nested subvolume). Kernel requires swapfiles on the top-level subvolume (subvolid=5). |
| `zram` via `modprobe` | Termina VM kernel built with `CONFIG_ZRAM=not set`. No kernel module, no `/sys/class/zram-control`. |
| Mount base BTRFS subvol (subvolid=5) | `/dev/vdc` block device is not exposed inside the container. |
| `/dev/vdb` (ext4 at `/opt/google/cros-containers`) | Mounted read-only. |
| `crosh`, `vmc`, `vsh` | Not available from inside the container. |
| `sudo nsenter -t 1 --mount --pid` | Escapes into Termina VM namespace (confirmed: `CapEff: 000001ffffffffff`), but `/dev/vdc` still not accessible and the existing `/swapfile` is on the wrong BTRFS subvolume. |

**Conclusion:** Swap must be enabled from the ChromeOS host via `crosh > swap enable 16384`. It cannot be done from inside the container.

---

## 5. Idle Playwright MCP Browser — The Hidden OOM Trigger

The VS Code Playwright MCP extension keeps a Chrome browser process alive **persistently**, even between automation runs:

```
PID 3942  chrome --type=renderer ...    733 MB   (idle, between sessions)
PID 4018  code --ms-enable-electron ... 2748 MB
                                        ──────
                                        3481 MB combined — perpetually near the cliff
```

This 733 MB idle process means VS Code is always operating within ~700 MB of OOM before any new tab, GC cycle, or Copilot request. The mem-watchdog will SIGTERM it automatically when RAM drops to ≤25% (~1.6 GB) free.

**Manual mitigation:** Close the MCP browser between automation sessions if memory is tight.

---

## 6. V8 Heap Cap: Do Not Set Below 2048 MB

`~/.config/Code/argv.json` must contain:
```json
{ "js-flags": "--max-old-space-size=2048" }
```

Setting this to **512 MB** (the original value) was counterproductive:
- V8 hit the ceiling during normal Copilot Chat usage
- Aggressive GC ran continuously, causing CPU spikes and allocation stalls
- TS server requests queued, extension host backed up, total RSS grew
- GC pressure **increased** peak memory consumption vs a higher limit

2048 MB gives V8 breathing room and results in less total RSS than 512 MB.

---

## 7. Complete VS Code Settings

### `~/.config/Code/argv.json`
```json
{ "js-flags": "--max-old-space-size=2048" }
```

### `~/.config/Code/User/settings.json` (memory-relevant entries)
```json
{
  "typescript.tsserver.maxTsServerMemory": 2048,
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "typescript.disableAutomaticTypeAcquisition": true,
  "files.watcherExclude": {
    "**/.git/objects/**": true,
    "**/node_modules/**": true,
    "**/.playwright-mcp/**": true
  },
  "workbench.editor.limit.enabled": true,
  "workbench.editor.limit.value": 8
}
```

---

## 8. Crash History

| Date | Count | Cause |
|---|---|---|
| 2026-02-27 | 2 | OOM — Playwright headed session |
| 2026-03-01 | 5 in 12 min | OOM — Playwright headed session, zero swap |
| 2026-03-02 | 4 | OOM — earlyoom installed but crash-looping (exit 104) |
| 2026-03-03 | 7 | OOM — earlyoom still crash-looping, headed Playwright |
| 2026-03-04 | 0 | earlyoom disabled, mem-watchdog active, Playwright headless, 16 GB zram enabled |
| 2026-03-05 13:02:25 | 1 | OOM — extension host spiked to 4.0 GB in <4s. Watchdog interval was 4s — fired 7s after crash. No Chrome to kill. |
| 2026-03-06 | 0 | Watchdog: interval 2s, startup mode 0.5s, ext host SIGTERM as last resort |
| 2026-03-24 | 1 | Language-server and Extension Host kills — three `kill_top_vscode_helper` bugs (issues #45–#47, daemon v20260324.3) |
| 2026-03-25 15:07:53 | 1 | EMERGENCY at 3.5 GB — action budget exhausted by no-op `kill_browsers()` calls; watchdog blocked for 27s during 2.8→3.5 GB climb (issue #49, daemon v20260325.1) |
| 2026-03-25 post-fix | 0 | Daemon v20260325.1: no-ops don't consume budget, `chrome_running` checked before `kill_browsers`, `STARTUP_BURST_RSS_KB` raised to 2.2 GB |
| 2026-03-25 17:33 | 2 | Watchdog blind at WARN level for 25 min: `kill_top_vscode_helper` blanket-excluded `--type=utility` (759 no-candidate polls), `kill_extension_host` used stale `--type=extensionHost` pattern (753 failed escalations). RSS grew 2.5→3.58 GB → EMERGENCY `kill_vscode_main`. (issue #55, daemon v20260325.5) |
| 2026-03-25 post-#55 | 0 | Daemon v20260325.5: Extension Host identified by `--type=utility` + `--inspect-port`; other utility processes now eligible kill candidates; `helper_no_candidate=0` |
| 2026-03-26 00:00:18 | 2 | WARN→ExtHost escalation: `kill_extension_host()` fired at 2.7 GB RSS / 76% free memory. WARN threshold (2.2–2.56 GB) was below normal baseline (2.3–2.7 GB), so WARN fired constantly. `kill_top_vscode_helper` found no candidate (utility processes correctly excluded), fell through to `kill_extension_host()` — destroyed terminal, Copilot, all extensions. ExtHost restart triggered extension v0.3.1 installer → overwrote daemon v20260325.7 with v20260313.2 (12 days old) → old daemon BURST-killed tsserver at 75% free. (issue #64, daemon v20260325.8) |
| 2026-03-26 post-#64 | 0 | Daemon v20260325.8: WARN and Stage 3 no longer escalate to `kill_extension_host()` — log and defer to EMERGENCY/Stage 4. `VSCODE_RSS_WARN_KB` raised 2.2→3.0 GB. `STARTUP_RSS_WARN_KB` raised 2.8→3.2 GB. Utility processes excluded at non-emergency in all 3 awk blocks. |
| 2026-03-26 12:15:03 | 1 | WARN dead zone: 18 consecutive WARN polls (3.0–3.1 GB, 74% free, no Chrome) with `helper_no_candidate=301`. No cgroup throttle/reclaim triggered at WARN. ACCEL killed tsserver (104 MB of 3.6 GB — 3%) and consumed action budget, blocking EMERGENCY on same iteration. Next cycle: EMERGENCY at 3.77 GB → `kill_vscode_main`. (issue #74, daemon v20260326.3) |
| 2026-03-26 post-#74 | 0 | Daemon v20260326.3: WARN fallback triggers `cgroup_throttle()` + `cgroup_reclaim()` when no kill candidate exists. EMERGENCY resets `_action_taken=false` — non-critical kills cannot block emergency. No-candidate log suppressed after first occurrence. |
| 2026-03-26 12:44:57 | 1 | Thresholds too low for Copilot Chat multi-agent workloads. RSS grew 2,328→3,114→3,300→3,423 MB in 47s during legitimate research. No Chrome, no helper candidate. STARTUP_RSS_EMERG_KB=3,400,000 gave only 300 MB above Copilot peak → `kill_vscode_main`. No kernel OOM (dmesg clean). (issue #77, daemon v20260326.4) |
| 2026-03-26 post-#77 | 0 | Daemon v20260326.4: WARN 3.0→3.4 GB, EMERG 3.2→3.8 GB, STARTUP_WARN 3.2→3.6 GB, STARTUP_EMERG 3.4→4.0 GB. Extension defaults and configWriter fallbacks updated to match. |
| 2026-03-26 post-#80 | 0 | Daemon v20260326.5: Process classification gap fixed. Blanket `--type=utility` exclusion replaced with targeted PTY Host PID exclusion via `find_pty_host_pid()`. `kill_top_vscode_helper("normal")` now has 2–3 candidates (Shared Process, File Watcher, Network Service ≈300 MB) when no Chrome is running. (issue #80, PR #81) |

### The 2026-03-05 crash — what was fixed

Three root causes:
1. **Interval too slow**: 4s → 2s (normal), 0.5s (during VS Code startup for 90s)
2. **RSS threshold too high**: 4 GB → 3.5 GB emergency, 2.5 GB warning
3. **No last resort**: If no Chrome to kill when VS Code RSS is critical, now SIGTERMs the highest-RSS `code` process (extension host) — causes "Extension host terminated unexpectedly" but saves the VS Code window

---

## 9. Current Risk Assessment

| Mitigation | Coverage | Status |
|---|---|---|
| V8 heap 2048 MB | Pathway #3 — V8 OOM/GC thrash | ✅ Fixed |
| mem-watchdog SIGTERM at ≤25% | Pathway #1 — kills Chrome/MCP browser before kernel OOM | ✅ Active |
| mem-watchdog startup mode (0.5s for 90s) | Pathway #1 — catches 0→4 GB spike on extension host load | ✅ Active |
| Playwright headless mode | Pathways #1, #2 — saves ~800 MB per automation run | ✅ Default |
| ChromeOS zram 16 GB | Pathway #2 only — host-level balloon pressure | ✅ Active |
| Action-budget no-op fix (v20260325.1) | Pathway #1 — no-op `kill_browsers()` no longer exhausts budget; fallback kills always reachable | ✅ Fixed |
| Utility-process detection fix (v20260325.5) | Pathway #1 — Extension Host identified by `--inspect-port`; non-ExtHost utility processes eligible as kill candidates; `kill_extension_host()` finds modern Extension Host | ✅ Fixed |
| WARN-deferral fix (v20260325.8) | Pathway #1 — WARN and Stage 3 no longer escalate to `kill_extension_host()`; defer to EMERGENCY/Stage 4. WARN threshold raised to 3.0 GB (above steady-state baseline). Prevents watchdog from destroying its own editing session at non-emergency RSS. | ✅ Fixed |
| WARN cgroup fallback (v20260326.3) | Pathway #1 — when no kill candidate exists at WARN, triggers `cgroup_throttle()` + `cgroup_reclaim()` as non-destructive intermediate relief. EMERGENCY resets `_action_taken` so non-critical kills cannot block it. | ✅ Fixed |
| Threshold raise for AI workloads (v20260326.4) | Pathway #1 — WARN 3.0→3.4 GB, EMERG 3.2→3.8 GB, STARTUP_WARN 3.2→3.6 GB, STARTUP_EMERG 3.4→4.0 GB. Copilot Chat multi-agent research legitimately peaks at 3.0–3.5 GB; previous thresholds gave only 300 MB headroom. | ✅ Fixed |
| Process classification fix (v20260326.5) | Pathway #1 — `kill_top_vscode_helper("normal")` now has intermediate candidates (Shared Process, File Watcher, Network Service ≈300 MB) between WARN cgroup throttle and EMERGENCY `kill_vscode_main`. PTY Host excluded by PID (child-detection), not blanket `--type=utility`. | ✅ Fixed |
| Container swap | Pathway #1 — direct relief for container kernel OOM | ❌ Blocked (CapEff=0, see §4) |

**Residual risk:** The container kernel can still OOM if VS Code + idle MCP browser + a Playwright session all run simultaneously without the MCP browser being killed first. The watchdog mitigates this but cannot guarantee prevention if the spike is faster than the 2s polling interval.

---

## 10. Cgroup Memory Limit — Testing Technique

`sudo -n` succeeds without a password on this system (`CapEff` includes `CAP_SYS_ADMIN`). The user memory cgroup path is:

```bash
CGRP=$(cat /proc/self/cgroup | awk -F: '$2=="memory"{print "/sys/fs/cgroup/memory" $3; exit}')
# e.g. /sys/fs/cgroup/memory/user.slice/user-1000.slice/user@1000.service
```

You can artificially constrain the container's available memory to simulate pressure:

```bash
# Simulate 4.5 GB cap (saves current value first):
ORIGINAL=$(cat "$CGRP/memory.limit_in_bytes")
sudo sh -c "echo $((4500*1024*1024)) > '$CGRP/memory.limit_in_bytes'"

# Restore unlimited:
sudo sh -c "echo -1 > '$CGRP/memory.limit_in_bytes'"
# (kernel converts -1 to the max sentinel: 9223372036854771712)
```

**Limitation (cgroup v1):** This triggers the kernel OOM killer when the cgroup *exceeds* the limit, but does **not** change what `/proc/meminfo` reports. The watchdog's `MemAvailable`-based logic won't observe the constraint. Use `test-pressure.sh` (which allocates actual memory) to test MemAvailable-triggered responses. The cgroup limit is useful for testing the kernel OOM path and verifying `oom_score_adj` rankings.
