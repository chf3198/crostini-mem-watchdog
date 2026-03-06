# Mem Watchdog

**Prevents VS Code from being OOM-killed on ChromeOS Crostini** by running an independent systemd daemon that monitors memory pressure and kills Chrome/Playwright processes before the Linux kernel decides to kill VS Code instead.

> **Why this exists:** `earlyoom` crashes immediately on Crostini with exit code 104 — a `strtol()` overflow caused by a bogus `SwapFree` sentinel value in the kernel's `/proc/meminfo`. It has never provided protection on this platform. This extension installs a bash-based replacement that avoids the broken value entirely and adds VS Code-aware RSS thresholds that earlyoom cannot provide.

---

## Status Bar

A live memory indicator in the bottom bar updates every 2 seconds:

| Appearance | Meaning |
|---|---|
| `✓ RAM 76% free` — green | Healthy — watchdog active, plenty of RAM |
| `⚠ RAM 22% free` — amber | Pressure — Chrome termination may be coming |
| `🔥 RAM 14% free` — red | Critical — SIGKILL threshold approaching |
| `✗ watchdog: inactive` — red | Service not running |

**Click the status bar item** to open the full Memory Dashboard.

---

## Commands

Access all commands via `Ctrl+Shift+P` → **Mem Watchdog:**

| Command | Description |
|---|---|
| **Show Memory Dashboard** | Full snapshot in an output channel: system RAM, PSI stall index, VS Code RSS by PID, Chrome RSS totals, service status, last 8 journal lines |
| **Playwright Pre-flight Check** | Pass/fail modal: RAM%, VS Code RSS, Chrome presence, watchdog state. Offers "Kill Chrome Now" inline if Chrome is running. |
| **Kill Chrome / Playwright Now** | Immediately sends `SIGTERM` to all `chrome`, `chromium`, and `node.*playwright` processes |
| **Restart Service** | `systemctl --user restart mem-watchdog` with live status feedback |

---

## Self-Installing Daemon

On first VS Code activation, the extension automatically:

1. Copies the bundled `mem-watchdog.sh` to `~/.local/bin/`
2. Installs `mem-watchdog.service` to `~/.config/systemd/user/`
3. Runs `systemctl --user enable --now mem-watchdog`

On subsequent activations, a **SHA-256 hash comparison** detects whether the bundled daemon version differs from what's installed — upgrading silently only when needed.

---

## Kill Hierarchy

The daemon acts on these conditions (checked every 2 seconds):

| Condition | Action |
|---|---|
| `MemAvailable ≤ 15%` (~945 MB on 6 GB) | `SIGKILL` Chrome / Playwright |
| `MemAvailable ≤ 25%` (~1.6 GB on 6 GB) | `SIGTERM` Chrome / Playwright |
| PSI `full avg10 > 25%` | `SIGTERM` Chrome (sustained memory stall) |
| VS Code RSS > 2.5 GB | `SIGTERM` Chrome + desktop notification |
| VS Code RSS > 3.5 GB | `SIGKILL` Chrome; if no Chrome → `SIGTERM` the highest-RSS extension host process to save the VS Code window |

**Startup mode:** when new VS Code PIDs appear, the daemon switches to **0.5 s polling for 90 s** and drops the RSS emergency threshold to 2.0 GB — catching the extension-host spike that caused the crash this tool was built to prevent (0 → 4 GB RSS in under 2 seconds during startup).

---

## Settings

Configure all thresholds via **VS Code Settings → Mem Watchdog**. Changes take effect immediately — the extension rewrites `~/.config/mem-watchdog/config.sh` and restarts the daemon automatically.

| Setting | Default | Description |
|---|---|---|
| `sigtermThresholdPct` | `25` | `SIGTERM` Chrome when `MemAvailable` falls below this % of total RAM |
| `sigkillThresholdPct` | `15` | Escalate to `SIGKILL` below this % |
| `psiThresholdPct` | `25` | `SIGTERM` on PSI `full avg10` above this % |
| `vscodeRssWarnMB` | `2500` | Warn + `SIGTERM` Chrome when total VS Code RSS exceeds this many MB |
| `vscodeRssEmergencyMB` | `3500` | `SIGKILL` Chrome (or `SIGTERM` extension host) above this MB |

> All settings use `scope: "machine"` — they do **not** sync across machines via Settings Sync. A threshold tuned for 6 GB RAM would be dangerously wrong on a 16 GB machine.

---

## RAM Tuning Guide

| System RAM | `vscodeRssWarnMB` | `vscodeRssEmergencyMB` |
|---|---|---|
| 4 GB | `1500` | `2000` |
| 6 GB *(default)* | `2500` | `3500` |
| 8 GB | `3500` | `5000` |
| 16 GB | `6000` | `10000` |

---

## Architecture

The daemon is intentionally a **separate systemd process** — not a thread inside the extension host. VS Code's JS runtime can freeze under OOM pressure; if the watchdog ran inside it, the watchdog would freeze too. The extension manages the daemon; it does not replace it.

```
VS Code Extension (this)            Systemd Daemon (independent process)
────────────────────────            ──────────────────────────────────────
• Auto-installs daemon         →    ~/.local/bin/mem-watchdog.sh
• Writes config on change      →    ~/.config/mem-watchdog/config.sh
• Status bar + 4 commands           • Polls /proc/meminfo + PSI every 2 s
• Upgrade detection via hash        • Kills Chrome on threshold breach
• Settings → config sync            • Survives VS Code freezing / crashing
                                    • oom_score_adj tuning every loop
```

---

## Requirements

- **Linux only** — `extensionKind: ["ui"]` prevents accidental activation on a remote machine via Remote SSH
- ChromeOS Crostini (Debian 12, kernel 6.6+) is the primary target; works on any Linux with systemd user services
- `systemctl --user` available (no `sudo` required)
- `notify-send` optional — enables desktop notifications when Chrome is killed

## Uninstall

Removing the extension stops and disables the `mem-watchdog` service. The daemon binary at `~/.local/bin/mem-watchdog.sh` is intentionally left in place — remove it manually if desired.


On activation the extension **self-installs** a `mem-watchdog` systemd user service that runs independently of VS Code. The daemon monitors `/proc/meminfo` and PSI pressure and kills Chrome/Playwright processes before the Linux kernel OOM-kills VS Code.

The status bar item updates every 2 seconds. Click it — or use the command palette — to access all features.

---

## Status Bar

| Display | Meaning |
|---|---|
| `✓ RAM 76% free` (green) | Healthy — watchdog active, > 35% RAM free |
| `⚠ RAM 22% free` (amber) | Pressure — 20–35% RAM free |
| `🔥 RAM 14% free` (red) | Critical — < 20% RAM free |
| `✗ watchdog: inactive` (red) | Service not running |

Click the item to open the Memory Dashboard.

---

## Commands

All commands are available from `Ctrl+Shift+P` → **Mem Watchdog: …**

| Command | What it does |
|---|---|
| **Show Memory Dashboard** | Full output-channel snapshot: RAM, PSI, VS Code RSS per-PID, Chrome RSS, service status, last 8 journal lines |
| **Playwright Pre-flight Check** | Pass/fail modal: RAM%, VS Code RSS, Chrome presence, watchdog state. Offers "Kill Chrome Now" if Chrome is running. |
| **Kill Chrome / Playwright Now** | Sends `SIGTERM` to all `chrome`, `chromium`, and `node.*playwright` processes immediately |
| **Restart Service** | `systemctl --user restart mem-watchdog` |

---

## Settings

All thresholds are configurable via **VS Code Settings → Mem Watchdog**. Changes take effect immediately — the extension rewrites `~/.config/mem-watchdog/config.sh` and restarts the daemon automatically.

| Setting | Default | Description |
|---|---|---|
| `sigtermThresholdPct` | `25` | `SIGTERM` Chrome when `MemAvailable` < this % |
| `sigkillThresholdPct` | `15` | Escalate to `SIGKILL` below this % |
| `psiThresholdPct` | `25` | `SIGTERM` on PSI `full avg10` above this % |
| `vscodeRssWarnMB` | `2500` | Warn + `SIGTERM` Chrome when VS Code RSS exceeds this MB |
| `vscodeRssEmergencyMB` | `3500` | `SIGKILL` Chrome (or `SIGTERM` extension host) above this MB |

All settings have `scope: "machine"` — they do not sync across machines with different RAM sizes.

---

## How It Works

**The daemon is a separate systemd process.** VS Code's JS extension host can freeze under OOM pressure — the daemon's independence is the protection. The extension manages the daemon; it does not replace it.

On every VS Code startup:
1. The bundled `mem-watchdog.sh` is SHA-256 compared to the installed version. If different, it is upgraded and the service is restarted.
2. VS Code Settings are written to `~/.config/mem-watchdog/config.sh`. The daemon sources this file at startup so thresholds take effect without reinstalling.
3. OOM scores are adjusted: `oom_score_adj=0` for VS Code, `oom_score_adj=1000` for Chrome (kernel kills it first).

**Startup mode:** When new VS Code PIDs are detected, the daemon switches to 0.5 s polling for 90 s and drops the RSS emergency threshold to 2.0 GB — preventing the crash pattern where the extension host spikes 0 → 4+ GB during startup.

---

## Requirements

- **Linux only** (`extensionKind: ["ui"]` — will not activate on a remote machine)
- ChromeOS Crostini (Debian 12, kernel 6.6+) recommended; works on any Linux with systemd user services
- `systemctl --user` available (no `sudo` required)
- `notify-send` optional — desktop notifications when Chrome is killed

---

## Install

```bash
cd vscode-extension
npm run build
npm install -g @vscode/vsce
vsce package
code --install-extension mem-watchdog-status-0.2.0.vsix
```

Reload the window (`Developer: Reload Window`). The daemon installs and starts automatically on first activation.

## Uninstall

Uninstalling the extension stops and disables the `mem-watchdog` service. The daemon binary at `~/.local/bin/mem-watchdog.sh` is intentionally left in place — remove it manually if desired.

## License

**[PolyForm Noncommercial 1.0.0](https://github.com/chf3198/crostini-mem-watchdog/blob/main/LICENSE)** — free for personal, educational, and non-commercial use.

Commercial use requires a paid license. See [COMMERCIAL-LICENSE.md](https://github.com/chf3198/crostini-mem-watchdog/blob/main/COMMERCIAL-LICENSE.md) or contact [curtisfranks@gmail.com](mailto:curtisfranks@gmail.com).
