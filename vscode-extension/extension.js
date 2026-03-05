// extension.js — plain JavaScript VS Code extension, no build step required
// Monitors: mem-watchdog systemd service state + live RAM from /proc/meminfo
// Updates: every 2 seconds via setInterval in activate()
'use strict';

const vscode = require('vscode');
const { exec } = require('child_process'); // built-in Node — no npm install
const fs = require('fs');                  // built-in Node — no npm install

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

function activate(context) {
    // createStatusBarItem(id, alignment, priority)
    //   id        — unique string within this extension
    //   alignment — StatusBarAlignment.Left (1) or .Right (2)
    //   priority  — higher = further toward the outer edge of that side
    const item = vscode.window.createStatusBarItem(
        'mem-watchdog-status',
        vscode.StatusBarAlignment.Left,
        100
    );
    item.name = 'Mem Watchdog'; // label shown in the status bar right-click menu

    // Show immediately so the item is visible from the first frame
    item.show();

    // First paint right away, then poll every 2 seconds
    update(item);
    const timer = setInterval(() => update(item), 2000);

    // Push both the status bar item and the timer into subscriptions.
    // VS Code calls .dispose() on every subscription when the extension
    // is deactivated — this clears the item and stops the interval.
    context.subscriptions.push(item);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {
    // Subscriptions are disposed automatically via context.subscriptions.
    // Nothing additional required here.
}

module.exports = { activate, deactivate };
