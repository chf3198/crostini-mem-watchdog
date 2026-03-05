# Mem Watchdog Status — VS Code Extension

A VS Code status bar widget that shows live memory stats and `mem-watchdog` service health.

## Status Bar Display

```
💾 RAM: 67% | VS Code: 1.2 GB    ← green  (≤ 75% RAM used)
💾 RAM: 82% | VS Code: 2.4 GB    ← yellow (≤ 90% RAM used)
💾 RAM: 94% | VS Code: 3.1 GB    ← red    (> 90% RAM used)
💾 ⚠ watchdog inactive           ← orange (service is not running)
```

Updates every **2 seconds**. Reads directly from `/proc/meminfo` and
`/proc/<pid>/status` — no external dependencies.

## Install

```bash
# From the repo root:
code --install-extension vscode-extension/mem-watchdog-status-0.0.1.vsix
```

Then reload the VS Code window (`Developer: Reload Window` from the command palette).

## Build From Source

```bash
cd vscode-extension
npm install -g @vscode/vsce
vsce package
code --install-extension mem-watchdog-status-0.0.1.vsix
```

## Requirements

- VS Code 1.74+
- `mem-watchdog` systemd user service must be installed and running
  (see repo root [`install.sh`](../install.sh))

## How It Works

1. On activation, queries `systemctl --user is-active mem-watchdog` via `child_process.exec`
2. Reads `/proc/meminfo` for `MemTotal` and `MemAvailable`
3. Finds all `code` PIDs via `/proc/*/status` and sums their `VmRSS`
4. Updates the status bar item every 2 seconds
5. Color-codes based on RAM% threshold: green/yellow/red/orange (inactive)
