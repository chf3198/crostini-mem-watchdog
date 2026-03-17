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

const installer    = require('./installer');
const configWriter = require('./configWriter');
const commands     = require('./commands');
const { installGlobalSkill } = require('./skillInstaller');
const { registerChatParticipant } = require('./chatParticipant');
const { readMeminfo, sh, checkServiceStatus } = require('./utils');

// ── Status bar poll interval ──────────────────────────────────────────────────
// Single source of truth — referenced by setInterval and the tooltip text.
const POLL_INTERVAL_MS = 2000;

// ── Full status bar state cache ──────────────────────────────────────────────
// Key encodes all visible output (svcStatus + rounded pct% + availMB).
// When stable, skips ALL four StatusBarItem property assignments and their
// IPC round-trips to the renderer. VS Code coalesces same-tick assignments
// into one $setEntry call but serialises it regardless of value equality.
// At 2 s intervals this prevents ~43 000 redundant IPC calls per idle day.
let _lastStateKey = '';

// ── Status bar update ─────────────────────────────────────────────────────────
// Guard prevents overlapping updates when checkService() is slow under OOM
// pressure — ensures at most one outstanding systemctl call at any time.
let _updating = false;

// ── Per-update efficiency counters ────────────────────────────────────────────
// Always maintained (3 integer increments per call, nanosecond cost each).
// Exposed via module._test.getStats() in MEM_WATCHDOG_TEST mode.
//   dropped:     calls rejected by the _updating pileup guard
//   cacheHits:   times stateKey matched → all 4 StatusBarItem IPC calls skipped
//   cacheMisses: times stateKey differed → full IPC round-trip fired
const _stats = { dropped: 0, cacheHits: 0, cacheMisses: 0 };

async function update(item) {
    if (_updating) { _stats.dropped++; return; }
    _updating = true;
    try {
        const mem        = readMeminfo();
        const svcStatus  = await checkServiceStatus();
        const isRunning  = svcStatus === 'active';

        // ── Full state cache — skip all IPC when nothing has changed ──────
        // Covers text, color, backgroundColor, and tooltip in one guard.
        // Same-tick assignments are coalesced by VS Code into one $setEntry
        // call; this cache prevents that call entirely during stable periods.
        const stateKey = mem
            ? `${svcStatus}|${mem.pct.toFixed(0)}|${Math.round(mem.availableKB / 1024)}`
            : `${svcStatus}|null`;

        if (stateKey !== _lastStateKey) {
            _stats.cacheMisses++;
            _lastStateKey = stateKey;

            // ── Background colour ─────────────────────────────────────────
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

            // ── Tooltip with detail table ─────────────────────────────────
            if (mem) {
                const availMB = Math.round(mem.availableKB / 1024);
                const totalGB = (mem.totalKB / 1024 / 1024).toFixed(1);
                item.tooltip = new vscode.MarkdownString(
                    `**mem-watchdog** \`${svcStatus}\`\n\n` +
                    `| | |\n|:---|---:|\n` +
                    `| Available | ${availMB} MB |\n` +
                    `| Total     | ${totalGB} GB |\n` +
                    `| Free %    | ${mem.pct.toFixed(1)}% |\n\n` +
                    `_Polls every ${POLL_INTERVAL_MS / 1000} s_`
                );
            } else {
                item.tooltip = `mem-watchdog: ${svcStatus} — /proc/meminfo unreadable`;
            }
        } else {
            _stats.cacheHits++;
        }
    } finally {
        _updating = false;
    }
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

    // ── 1b. Install / refresh user-level Copilot skill ─────────────────────
    // Installs to ~/.copilot/skills/mem-watchdog-ops so the assistant can
    // carry watchdog-specific operational context across repositories.
    try {
        const skill = installGlobalSkill(context.extensionUri.fsPath);
        if (skill.state === 'installed') {
            vscode.window.showInformationMessage('Mem Watchdog: Copilot skill installed ✓');
        }
    } catch (err) {
        console.error('[memWatchdog] skillInstaller error:', err.message);
    }

    // ── 2. Sync VS Code settings → config file ────────────────────────────────
    try {
        const cfgWarnings = configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog'));
        if (cfgWarnings && cfgWarnings.length > 0) {
            vscode.window.showWarningMessage(
                'Mem Watchdog: invalid settings corrected to safe defaults — check Developer Console for details.'
            );
        }
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
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (!e.affectsConfiguration('memWatchdog')) { return; }
            let cfgWarnings = [];
            try {
                cfgWarnings = configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog')) || [];
            } catch (err) {
                console.error('[memWatchdog] configWriter update error:', err.message);
            }
            if (cfgWarnings.length > 0) {
                vscode.window.showWarningMessage(
                    'Mem Watchdog: invalid settings corrected to safe defaults — check Developer Console for details.'
                );
            }
            // Restart so the daemon picks up the new config, then verify it came back up
            const { ok, stderr } = await sh('systemctl --user restart mem-watchdog 2>&1');
            if (!ok) {
                vscode.window.showErrorMessage(
                    `Mem Watchdog: service restart failed after settings change — ${stderr}`
                );
            }
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
    const timer = setInterval(() => update(item), POLL_INTERVAL_MS);

    context.subscriptions.push(item);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });

    // ── 6. Optional chat participant (if Chat API is available) ─────────────
    registerChatParticipant(context);
}

function deactivate() {
    // Subscriptions are disposed automatically via context.subscriptions.
}

module.exports = { activate, deactivate };

// ── Test-only exports ─────────────────────────────────────────────────────────
// Not present in normal operation. Set MEM_WATCHDOG_TEST=1 before requiring
// this module to expose internal functions for unit tests without calling
// activate(). The guard prevents any production code path from accessing _test.
/* c8 ignore next */
if (process.env.MEM_WATCHDOG_TEST) {
    module.exports._test = {
        update,
        POLL_INTERVAL_MS,
        resetStateCache: () => { _lastStateKey = ''; },
        resetStats:      () => { _stats.dropped = 0; _stats.cacheHits = 0; _stats.cacheMisses = 0; },
        getStats:        () => ({ dropped: _stats.dropped, cacheHits: _stats.cacheHits, cacheMisses: _stats.cacheMisses }),
    };
}
