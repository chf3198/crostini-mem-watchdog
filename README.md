# crostini-mem-watchdog

> A production-grade memory watchdog for VS Code on ChromeOS Crostini — because `earlyoom` hard-crashes here and the kernel OOM killer has no taste.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-ChromeOS%20Crostini-green)](https://chromeos.dev/en/linux)
[![Shell](https://img.shields.io/badge/shell-bash-orange)](mem-watchdog.sh)

---

## The Problem

On ChromeOS Crostini (Debian in an LXC container), the ChromeOS kernel reports a bogus `SwapFree` value when no swap is configured:

```
/proc/meminfo → SwapFree: 18446744073709551360 kB   ← uint64 overflow
```

`earlyoom` v1.7 passes this value to C's `strtol()`, which overflows fatally → **exit code 104 → crash-loop every 3 seconds → zero OOM protection**.

Additionally, Crostini containers run with `CapEff=0`, meaning `swapon`, `fallocate`-based swapfiles, and most `/dev` block devices are unavailable. **You cannot add swap in a standard Crostini container.**

This watchdog solves both problems cleanly.

---

## What It Does

| Trigger | Action |
|---|---|
| RAM free ≤ 25% | SIGTERM Chrome / Playwright |
| RAM free ≤ 15% | SIGKILL Chrome / Playwright |
| PSI full avg10 > 25% | SIGTERM Chrome (sustained pressure) |
| VS Code RSS > 2.5 GB | SIGTERM Chrome + desktop alert |
| VS Code RSS > 3.5 GB | SIGKILL Chrome; if no Chrome → SIGTERM extension host to save VS Code window |
| Every loop | Set `oom_score_adj=0` on VS Code (counters Electron's 200–300 default) |
| Every loop | Set `oom_score_adj=1000` on Chrome (kernel kills it first) |

- Checks every **2 seconds** (4s was confirmed too slow — missed a 4 GB spike in <4s)
- Reads only `MemAvailable`, `MemTotal`, and `/proc/pressure/memory` — all safe on Crostini
- **Never reads `SwapFree`** — the value that kills earlyoom
- Logs via `logger -t mem-watchdog` → journald (no `/tmp` writes)
- Desktop notifications via `notify-send`, throttled to 1 per 5 minutes per severity

---

## Architecture

```
mem-watchdog.sh              ← core daemon (bash, no deps beyond coreutils)
mem-watchdog.service         ← systemd user service unit
watchdog-tray.sh             ← optional: yad system tray icon (needs yad)
vscode-extension/            ← optional: VS Code status bar widget
  extension.js
  package.json
  mem-watchdog-status-*.vsix ← pre-built, installable directly
install.sh                   ← one-command installer
test-watchdog.sh             ← 12-test validation suite
```

### Why a user service (not system)?

Crostini's Debian container uses a **non-root user service manager** (`systemctl --user`). The watchdog only needs access to `/proc/meminfo`, `/proc/<pid>/status`, and `kill` — no root required.

---

## Requirements

- ChromeOS Crostini (Debian 11 Bookworm or later)
- `bash` ≥ 5.0 (default in Debian 11+)
- `systemd` user session active (`loginctl show-session` should show `Type=unspecified` or `x11`)
- `notify-send` (optional, for desktop alerts — part of `libnotify-bin`)
- `yad` (optional, for tray icon only — `sudo apt install yad`)
- VS Code 1.74+ (optional, for VS Code extension)

---

## Installation

### Automatic (recommended)

```bash
git clone https://github.com/chf3198/crostini-mem-watchdog.git
cd crostini-mem-watchdog
bash install.sh
```

The installer will:
1. Copy `mem-watchdog.sh` → `~/.local/bin/mem-watchdog.sh`
2. Copy `mem-watchdog.service` → `~/.config/systemd/user/mem-watchdog.service`
3. Enable + start the service
4. Optionally install the VS Code extension

### Manual

```bash
# 1. Copy the daemon
cp mem-watchdog.sh ~/.local/bin/mem-watchdog.sh
chmod +x ~/.local/bin/mem-watchdog.sh

# 2. Install the service unit
mkdir -p ~/.config/systemd/user
cp mem-watchdog.service ~/.config/systemd/user/mem-watchdog.service

# 3. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now mem-watchdog

# 4. Verify
systemctl --user status mem-watchdog
journalctl --user -u mem-watchdog -f
```

---

## Configuration

All thresholds are variables at the top of `mem-watchdog.sh`. Edit before installing:

| Variable | Default | Description |
|---|---|---|
| `SIGTERM_THRESHOLD` | `25` | % free RAM → SIGTERM Chrome |
| `SIGKILL_THRESHOLD` | `15` | % free RAM → SIGKILL Chrome |
| `PSI_THRESHOLD` | `25` | PSI full avg10 % → SIGTERM Chrome |
| `INTERVAL` | `2` | Seconds between checks |
| `VSCODE_RSS_WARN_KB` | `2500000` | ~2.5 GB — VS Code RSS warning level |
| `VSCODE_RSS_EMERG_KB` | `3500000` | ~3.5 GB — VS Code RSS emergency level |
| `NOTIFY_INTERVAL` | `300` | Seconds between desktop notifications |
| `OOM_VSCODE_ADJ` | `0` | `oom_score_adj` set on VS Code PIDs |
| `OOM_CHROME_ADJ` | `1000` | `oom_score_adj` set on Chrome PIDs |

---

## Tuning for Your RAM

| Total RAM | Recommended `VSCODE_RSS_WARN_KB` | Recommended `VSCODE_RSS_EMERG_KB` |
|---|---|---|
| 4 GB | `1500000` | `2000000` |
| 6 GB (default) | `2500000` | `3500000` |
| 8 GB | `3500000` | `5000000` |
| 16 GB | `6000000` | `10000000` |

---

## VS Code Extension

The `vscode-extension/` directory contains a status bar widget that shows live RAM% and VS Code RSS in the bottom bar of VS Code.

```
💾 RAM: 67% | VS Code: 1.2 GB    ← green
💾 RAM: 82% | VS Code: 2.4 GB    ← yellow
💾 RAM: 94% | VS Code: 3.1 GB    ← red
```

### Install the extension

```bash
# Option A: install the pre-built .vsix
code --install-extension vscode-extension/mem-watchdog-status-0.0.1.vsix

# Option B: build from source (requires @vscode/vsce)
npm install -g @vscode/vsce
cd vscode-extension && vsce package
code --install-extension mem-watchdog-status-0.0.1.vsix
```

---

## Validation

Run the included test suite to verify everything is working:

```bash
bash test-watchdog.sh
```

All 12 tests should pass in ~3 seconds. Tests verify:
- Service is active with a bash MainPID
- No stray dry-run processes
- V8 heap is set correctly in `argv.json`
- VS Code `oom_score_adj` ≤ 100 (not Electron's default 200–300)
- `/proc/meminfo` and PSI are readable
- SwapFree overflow is handled safely
- No `/tmp` write references in the daemon
- SIGTERM works
- Journal output is present

---

## Crash Analysis: The Event That Prompted This

On 2026-03-05 at 13:02:25, VS Code (process 778) was OOM-killed with:

```
anon-rss:4087536kB oom_score_adj:0
```

The extension host had spiked from normal to ~4 GB in under 4 seconds. The previous watchdog interval was 4 seconds — it fired at 13:02:32, **7 seconds after the crash**. No Chrome was running, so there was nothing to kill anyway.

**All three root causes were fixed:**
1. Interval: 4s → 2s
2. RSS threshold: 4 GB → 3.5 GB (earlier intervention)
3. Last-resort: SIGTERM the extension host itself if no Chrome present

---

## Why Not earlyoom?

`earlyoom` is the standard recommendation for this problem, but on Crostini it:
1. Reads `SwapFree` from `/proc/meminfo`
2. Passes the value to `strtol()` in C
3. Gets `18446744073709551360` — which overflows `long`
4. Crashes with exit code 104 immediately on startup
5. Systemd restarts it every 3 seconds → **earlyoom is crash-looping and providing zero protection**

This is a [known upstream issue](https://github.com/rfjakob/earlyoom/issues) with uint64 overflow on kernels that report max `uint64` instead of 0 for unavailable swap. The fix has not landed in the Debian package.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Issues and PRs welcome. This tool is specifically designed for ChromeOS Crostini but the approach works on any swap-less Linux environment where earlyoom fails.

If you're running a different RAM configuration, please open an issue with your `free -h` output — it helps calibrate default thresholds.
