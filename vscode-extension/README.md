# Mem Watchdog — VS Code Extension

OOM protection for VS Code on ChromeOS Crostini (Debian, 6 GB RAM, no container swap).

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
code --install-extension mem-watchdog-status-0.1.0.vsix
```

Reload the window (`Developer: Reload Window`). The daemon installs and starts automatically on first activation.

## Uninstall

Uninstalling the extension stops and disables the `mem-watchdog` service. The daemon binary at `~/.local/bin/mem-watchdog.sh` is intentionally left in place — remove it manually if desired.
