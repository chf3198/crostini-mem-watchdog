<div align="center">

# 🛡️ Mem Watchdog

**VS Code OOM protection for ChromeOS Crostini**

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/CurtisFranks.mem-watchdog-status?label=VS%20Marketplace&color=00d4aa)](https://marketplace.visualstudio.com/items?itemName=CurtisFranks.mem-watchdog-status)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/CurtisFranks.mem-watchdog-status?color=00d4aa)](https://marketplace.visualstudio.com/items?itemName=CurtisFranks.mem-watchdog-status)
[![License: PolyForm NC](https://img.shields.io/badge/License-PolyForm%20NC%201.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-ChromeOS%20Crostini-4285f4)](https://chromeos.dev/en/linux)
[![Tests](https://img.shields.io/badge/bash-12%2F12-brightgreen)](test-watchdog.sh)
[![Tests](https://img.shields.io/badge/js-54%2F54-brightgreen)](vscode-extension/package.json)

*`earlyoom` hard-crashes on Crostini (exit 104, every 3 seconds, zero protection). This replaces it with a VS Code-aware watchdog that kills Chrome before the kernel OOM-kills VS Code.*

</div>


---

## ⚡ Quick Install

**Via VS Code Marketplace** (recommended — auto-installs and manages the daemon):

```
ext install CurtisFranks.mem-watchdog-status
```

Or search **"Mem Watchdog"** in the VS Code Extensions panel. The extension installs the systemd daemon automatically on first activation.

**Shell-only** (no VS Code required):

```bash
git clone https://github.com/chf3198/crostini-mem-watchdog.git
cd crostini-mem-watchdog && bash install.sh
```

---

## The Problem

ChromeOS Crostini runs VS Code inside a Debian LXC container. Three independent OOM pathways can kill it:

| # | Pathway | What kills VS Code |
|---|---|---|
| 1 | Container RAM exhausted | Linux kernel OOM killer — SIGKILL on the highest-RSS process (VS Code) |
| 2 | ChromeOS balloon driver shrinks the VM | ChromeOS host memory pressure |
| 3 | V8 heap exhausted at a hard cap | V8 OOM handler — allocation failure in the extension host |

**ChromeOS zram swap only covers Pathway #2.** The container kernel's OOM killer has no knowledge of host-level swap. `free -h` showing `Swap: 0B` inside the container is *not cosmetic* — it is the kernel's actual memory budget for OOM scoring.

### Why earlyoom fails here

The Crostini kernel reports a `uint64` overflow sentinel for `SwapFree` when no swap is configured:

```
/proc/meminfo → SwapFree: 18446744073709551360 kB   ← 2^64 − 256
```

`earlyoom` passes this to C's `strtol()` → signed overflow → **exit code 104 → crash-loop every 3 seconds → zero protection**. This is the silent default state on every Crostini machine where earlyoom appears "running."

This watchdog reads only `MemAvailable` and `MemTotal` — both correct on this kernel — and never touches `SwapFree`.

---

## What It Does

| Trigger | Action |
|---|---|
| `MemAvailable ≤ 15%` | `SIGKILL` Chrome / Playwright |
| `MemAvailable ≤ 25%` | `SIGTERM` Chrome / Playwright |
| PSI `full avg10 > 25%` | `SIGTERM` Chrome (sustained memory stall) |
| VS Code RSS > 2.5 GB | `SIGTERM` Chrome + desktop notification |
| VS Code RSS > 3.5 GB | `SIGKILL` Chrome; if no Chrome → `SIGTERM` highest-RSS extension host to save the VS Code window |
| Every loop | Set `oom_score_adj=0` on VS Code PIDs (counters Electron's 200–300 default) |
| Every loop | Set `oom_score_adj=1000` on Chrome PIDs (kernel kills it first) |

- Checks every **2 seconds** (4s was confirmed too slow — missed a 4 GB spike in < 4s on 2026-03-05)
- **Startup mode**: 0.5 s polling for 90 s after new VS Code PIDs detected — catches extension-host spikes during startup
- Reads only `MemAvailable`, `MemTotal`, and `/proc/pressure/memory` (PSI) — all safe on Crostini
- Logs via `logger -t mem-watchdog` → journald (no `/tmp` writes)
- Desktop notifications via `notify-send`, throttled to 1 per 5 minutes per severity level

---

## Architecture

```
crostini-mem-watchdog/
├── mem-watchdog.sh              ← core daemon (bash, coreutils only)
├── mem-watchdog.service         ← systemd user service unit
├── install.sh                   ← shell-only installer (no VS Code required)
├── test-watchdog.sh             ← 12-test validation suite
├── test-pressure.sh             ← live memory pressure tests
├── watchdog-tray.sh             ← optional: yad system tray icon
└── vscode-extension/            ← VS Code extension (primary install path)
    ├── extension.js             ← activate(): install → config → commands → status bar
    ├── installer.js             ← SHA-256 hash-based auto-install/upgrade
    ├── configWriter.js          ← VS Code Settings → ~/.config/mem-watchdog/config.sh
    ├── commands.js              ← dashboard, preflight, killChrome, restartService
    ├── utils.js                 ← readMeminfo(), readPsi(), sh(), checkServiceStatus() — shared helpers
    ├── lifecycle.js             ← vscode:uninstall: stop + disable service
    └── scripts/prepare.js       ← vscode:prepublish: bundles daemon files into resources/
```

**The daemon must remain a separate systemd process.** VS Code's extension host can freeze under OOM pressure — the daemon's independence is the protection. The VS Code extension manages the daemon; it does not replace it.

**Config sourcing:** `mem-watchdog.sh` sources `~/.config/mem-watchdog/config.sh` (if present) after its own defaults. VS Code Settings writes this file. The daemon script itself is never modified at runtime, which makes SHA-256 hash-based upgrade detection exact.

---

## Configuration

**Preferred:** VS Code Settings → **Mem Watchdog** — changes apply on next daemon restart.

**Manual fallback:** top-of-file variables in `mem-watchdog.sh`:

| Variable | Default | Description |
|---|---|---|
| `SIGTERM_THRESHOLD` | `25` | % free RAM → SIGTERM Chrome |
| `SIGKILL_THRESHOLD` | `15` | % free RAM → SIGKILL Chrome |
| `PSI_THRESHOLD` | `25` | PSI full avg10 % → SIGTERM Chrome |
| `INTERVAL` | `2` | Seconds between normal checks |
| `STARTUP_INTERVAL` | `0.5` | Seconds between checks in startup mode |
| `STARTUP_DURATION` | `90` | Seconds to stay in startup mode after new VS Code PIDs |
| `VSCODE_RSS_WARN_KB` | `2500000` | ~2.5 GB — VS Code RSS warning level |
| `VSCODE_RSS_EMERG_KB` | `3500000` | ~3.5 GB — VS Code RSS emergency level |
| `NOTIFY_INTERVAL` | `300` | Seconds between desktop notifications per severity |

### Tuning for Your RAM

| Total RAM | `VSCODE_RSS_WARN_KB` | `VSCODE_RSS_EMERG_KB` |
|---|---|---|
| 4 GB | `1500000` | `2000000` |
| 6 GB *(default)* | `2500000` | `3500000` |
| 8 GB | `3500000` | `5000000` |
| 16 GB | `6000000` | `10000000` |

---

## Validation

All 4 gates must pass before any change is published:

```bash
bash test-watchdog.sh              # 12 bash tests (~3 s) — service, OOM scores, PSI, SwapFree safety, SIGTERM
cd vscode-extension && npm test    # 54 JS unit tests (~1 s) — extension state machine, pileup guard, utils
bash -n mem-watchdog.sh            # bash syntax check
shellcheck --shell=bash -e SC1091,SC2317 mem-watchdog.sh watchdog-tray.sh install.sh
```

```bash
bash test-pressure.sh    # live: allocates memory, verifies watchdog fires (requires < 40% RAM free)
```

---

## Crash That Started This

On **2026-03-05 at 13:02:25**, VS Code process 778 was OOM-killed:

```
[ 2610.439831] code invoked oom-killer
[ 2610.522581] Out of memory: Killed process 778 (code)
               total-vm:1463369736kB, anon-rss:4087536kB, oom_score_adj:0
```

The extension host spiked from normal RSS to **~4 GB in under 4 seconds** during startup. The watchdog's interval was 4 s — it fired at 13:02:32, **7 seconds after the crash**. No Chrome was running, so there was nothing to kill anyway.

Three fixes:
1. **Interval**: 4 s → 2 s normal, 0.5 s during startup mode
2. **RSS threshold**: lowered to 3.5 GB emergency (earlier intervention)  
3. **Last resort**: if no Chrome to kill, SIGTERM the highest-RSS `code` process to save the VS Code window

---

## Requirements

- ChromeOS Crostini (Debian 11+) or any Linux with systemd user services
- `bash` ≥ 5.0
- `notify-send` optional (desktop alerts — `sudo apt install libnotify-bin`)
- `yad` optional (system tray icon — `sudo apt install yad`)
- VS Code 1.74+ optional (for the extension)

---

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for personal, educational, and non-commercial use.

Commercial use (including internal company tooling) requires a paid license. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) or contact [curtisfranks@gmail.com](mailto:curtisfranks@gmail.com).
