// extension.js — Mem Watchdog VS Code extension entry point
// ─────────────────────────────────────────────────────────────────────────────
// On activation:
//   1. Installs / upgrades the daemon (installer.js)
//   2. Writes VS Code settings → ~/.config/mem-watchdog/config.sh (configWriter.js)
//   3. Registers 4 commands (commands.js)
//   4. Watches for settings changes → rewrites config + restarts daemon
//   5. Runs the status bar status poller every 2 s (original logic preserved)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode       = require('vscode');
const { exec }     = require('child_process');
const fs           = require('fs');

const installer    = require('./installer');
const configWriter = require('./configWriter');
const commands     = require('./commands');

// ── /proc/meminfo reader ──────────────────────────────────────────────────────

function readMeminfo() {
    // Returns { totalKB, availableKB, pct } or null on any read error.
    // Reads ONLY MemTotal and MemAvailable — these are correct on Crostini
    // even when SwapFree reports a uint64-overflow bogus value.
    try {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        let totalKB = 0, availableKB = 0;
        for (const line of raw.split('\n')) {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (!m) continue;
            if (m[1] === 'MemTotal')     totalKB     = parseInt(m[2], 10);
            if (m[1] === 'MemAvailable') availableKB = parseInt(m[2], 10);
        }
        const pct = totalKB > 0 ? (availableKB / totalKB) * 100 : 0;
        return { totalKB, availableKB, pct };
    } catch (_) {
        return null;
    }
}

// ── systemd service check ─────────────────────────────────────────────────────

function checkService(callback) {
    // exec() is async; callback receives the status string.
    // NOTE: systemctl exits non-zero for non-"active" states, so _err is
    // intentionally ignored — we read stdout regardless of exit code.
    exec('systemctl --user is-active mem-watchdog', (_err, stdout) => {
        callback(stdout.trim() || 'unknown');
        // Possible values: 'active', 'inactive', 'failed',
        //                  'activating', 'deactivating', 'unknown'
    });
}

// ── Status bar update ─────────────────────────────────────────────────────────

function update(item) {
    const mem = readMeminfo();

    checkService((svcStatus) => {
        const isRunning = svcStatus === 'active';

        // ── Background colour ─────────────────────────────────────────────
        // IMPORTANT: VS Code only supports two ThemeColor strings for
        // StatusBarItem.backgroundColor — no others will have any effect:
        //   'statusBarItem.errorBackground'   → red   (critical)
        //   'statusBarItem.warningBackground' → amber  (warning)
        // For the healthy/"green" state, set backgroundColor = undefined
        // and tint the foreground text/icon with item.color instead.

        if (!isRunning) {
            // ─ RED: service is not running — most urgent ─
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            item.color = undefined;
            item.text = `$(error) watchdog: ${svcStatus}`;

        } else if (!mem || mem.pct < 20) {
            // ─ RED: RAM critically low (< 20% free) ─
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            item.color = undefined;
            item.text = mem
                ? `$(flame) RAM ${mem.pct.toFixed(0)}% free`
                : `$(error) meminfo err`;

        } else if (mem.pct < 35) {
            // ─ YELLOW: RAM under pressure (20–35% free) ─
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            item.color = undefined;
            item.text = `$(warning) RAM ${mem.pct.toFixed(0)}% free`;

        } else {
            // ─ GREEN (foreground tint): healthy (> 35% free) ─
            item.backgroundColor = undefined; // clear any previous red/yellow
            item.color = new vscode.ThemeColor('testing.iconPassed'); // green in all built-in themes
            item.text = `$(check) RAM ${mem.pct.toFixed(0)}% free`;
        }

        // ── Tooltip with detail table ─────────────────────────────────────
        if (mem) {
            const availMB = Math.round(mem.availableKB / 1024);
            const totalGB = (mem.totalKB / 1024 / 1024).toFixed(1);
            item.tooltip = new vscode.MarkdownString(
                `**mem-watchdog** \`${svcStatus}\`\n\n` +
                `| | |\n|:---|---:|\n` +
                `| Available | ${availMB} MB |\n` +
                `| Total     | ${totalGB} GB |\n` +
                `| Free %    | ${mem.pct.toFixed(1)}% |\n\n` +
                `_Polls every 2 s_`
            );
        } else {
            item.tooltip = `mem-watchdog: ${svcStatus} — /proc/meminfo unreadable`;
        }
    });
}

// ── Extension entry points ────────────────────────────────────────────────────

async function activate(context) {
    // ── 1. Install / upgrade the daemon ──────────────────────────────────────
    try {
        const outcome = await installer.installOrUpgrade(context);
        if (outcome === 'installed') {
            vscode.window.showInformationMessage('Mem Watchdog: daemon installed and service started ✓');
        } else if (outcome === 'upgraded') {
            vscode.window.showInformationMessage('Mem Watchdog: daemon upgraded and service restarted ✓');
        }
        // 'current' → no notification; service is already running correctly
    } catch (err) {
        vscode.window.showErrorMessage(`Mem Watchdog: install failed — ${err.message}`);
    }

    // ── 2. Sync VS Code settings → config file ────────────────────────────────
    try {
        configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog'));
    } catch (err) {
        // Non-fatal; daemon falls back to its built-in defaults
        console.error('[memWatchdog] configWriter error:', err.message);
    }

    // ── 3. Register commands ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('memWatchdog.showDashboard',  commands.showDashboard),
        vscode.commands.registerCommand('memWatchdog.preflightCheck', commands.preflightCheck),
        vscode.commands.registerCommand('memWatchdog.killChrome',     commands.killChrome),
        vscode.commands.registerCommand('memWatchdog.restartService', commands.restartService),
        { dispose: commands.dispose },
    );

    // ── 4. Settings change listener ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('memWatchdog')) { return; }
            try {
                configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog'));
            } catch (err) {
                console.error('[memWatchdog] configWriter update error:', err.message);
            }
            // Restart so the daemon picks up the new config on its next startup
            exec('systemctl --user restart mem-watchdog 2>/dev/null', () => {});
        })
    );

    // ── 5. Status bar ─────────────────────────────────────────────────────────
    const item = vscode.window.createStatusBarItem(
        'mem-watchdog-status',
        vscode.StatusBarAlignment.Left,
        100
    );
    item.name    = 'Mem Watchdog';
    item.command = 'memWatchdog.showDashboard'; // clicking opens dashboard
    item.show();

    update(item);
    const timer = setInterval(() => update(item), 2000);

    context.subscriptions.push(item);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {
    // Subscriptions are disposed automatically via context.subscriptions.
}

module.exports = { activate, deactivate };
