// extension.js — Mem Watchdog VS Code extension entry point
// ─────────────────────────────────────────────────────────────────────────────
// On activation:
//   1. Writes VS Code settings → ~/.config/mem-watchdog/config.sh (configWriter.js)
//      MUST run before install — the daemon sources this file at startup.
//   2. Installs / upgrades the daemon (installer.js)
//      If the config changed and the daemon was already current (no hash-based
//      restart), forces a daemon restart to pick up the new config.
//   2b. Install / refresh user-level Copilot skill (skillInstaller.js)
//   3. Registers 7 commands (commands.js)
//   4. Watches for settings changes → rewrites config + restarts daemon
//   5. Runs the status bar status poller every 2 s (original logic preserved)
//   6. Deferred self-update check via GitHub Releases API (updateChecker.js)
//   7. Optional @memwatchdog chat participant (chatParticipant.js)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode       = require('vscode');

const installer    = require('./installer');
const configWriter = require('./configWriter');
const commands     = require('./commands');
const updateChecker = require('./updateChecker');
const { installGlobalSkill } = require('./skillInstaller');
const { registerChatParticipant } = require('./chatParticipant');
const {
    readMeminfo,
    sh,
    checkServiceStatus,
    readWatchdogMode,
    readRssThresholds,
    determineState,
    stateDescription,
} = require('./utils');

// ── Status bar poll interval ──────────────────────────────────────────────────
// Single source of truth — referenced by setInterval and the tooltip text.
const POLL_INTERVAL_MS = 2000;

// ── Activation/runtime singletons ───────────────────────────────────────────
// Defensive guard: activate() should run once per extension host process.
// If VS Code triggers activation again in the same process, avoid creating a
// second status-bar item and timer.
let _activated = false;
let _statusItem = null;
let _statusTimer = null;
let _chatGuardTimer = null;

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

function disposeRuntimeUi() {
    if (_statusTimer) {
        clearInterval(_statusTimer);
        _statusTimer = null;
    }
    if (_chatGuardTimer) {
        clearInterval(_chatGuardTimer);
        _chatGuardTimer = null;
    }
    if (_statusItem) {
        try { _statusItem.dispose(); } catch {}
        _statusItem = null;
    }
}

async function update(item) {
    if (_updating) { _stats.dropped++; return; }
    _updating = true;
    try {
        const mem        = readMeminfo();
        const svcStatus  = await checkServiceStatus();
        const mode       = readWatchdogMode();
        const { warnKB, emergKB } = readRssThresholds();

        const vscodeRssKB = mem ? (mem.totalKB - mem.availableKB) : 0;
        const state = determineState({
            serviceStatus: svcStatus,
            mode,
            vscodeRssKB,
            warnKB,
            emergKB,
        });
        const desc = stateDescription(state);

        // ── Full state cache — skip all IPC when nothing has changed ──────
        // Covers text, color, backgroundColor, and tooltip in one guard.
        // Same-tick assignments are coalesced by VS Code into one $setEntry
        // call; this cache prevents that call entirely during stable periods.
        const stateKey = mem
            ? `${state}|${svcStatus}|${mode}|${mem.pct.toFixed(0)}|${Math.round(mem.availableKB / 1024)}`
            : `${state}|${svcStatus}|${mode}|null`;

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

            switch (state) {
                case 'OFF':
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    item.color = undefined;
                    item.text = '$(error) OFF';
                    break;
                case 'SLEEPING':
                    item.backgroundColor = undefined;
                    item.color = new vscode.ThemeColor('charts.yellow');
                    item.text = '$(clock) SLEEPING';
                    break;
                case 'ATTACKING':
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    item.color = undefined;
                    item.text = '$(flame) ATTACKING';
                    break;
                case 'RECOVERING':
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    item.color = undefined;
                    item.text = '$(pulse) RECOVERING';
                    break;
                case 'ALERT':
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    item.color = undefined;
                    item.text = '$(warning) ALERT';
                    break;
                default:
                    item.backgroundColor = undefined;
                    item.color = new vscode.ThemeColor('testing.iconPassed');
                    item.text = '$(shield) GUARDING';
                    break;
            }

            // ── Tooltip with detail table ─────────────────────────────────
            if (mem) {
                const availMB = Math.round(mem.availableKB / 1024);
                const totalGB = (mem.totalKB / 1024 / 1024).toFixed(1);
                const usedMB = Math.round(vscodeRssKB / 1024);
                const warnMB = Math.round(warnKB / 1024);
                const emergMB = Math.round(emergKB / 1024);
                item.tooltip = new vscode.MarkdownString(
                    `**mem-watchdog** \`${svcStatus}\`\n\n` +
                    `**State:** \`${state}\` — ${desc}\n\n` +
                    `| | |\n|:---|---:|\n` +
                    `| Available | ${availMB} MB |\n` +
                    `| VS Code RSS (est.) | ${usedMB} MB |\n` +
                    `| WARN / EMERG | ${warnMB} / ${emergMB} MB |\n` +
                    `| Total     | ${totalGB} GB |\n` +
                    `| Free %    | ${mem.pct.toFixed(1)}% |\n\n` +
                    `_Polls every ${POLL_INTERVAL_MS / 1000} s_`
                );
            } else {
                item.tooltip = `mem-watchdog: ${svcStatus} — ${state} — /proc/meminfo unreadable`;
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
    if (_activated) {
        return;
    }
    _activated = true;

    // ── 1. Sync VS Code settings → config file ────────────────────────────────
    // MUST run before install/upgrade: the daemon sources this file at startup.
    // If the config file is written AFTER the daemon restarts, it runs with the
    // PREVIOUS session's stale values (crash confirmed 2026-03-27, issue #95).
    let configChanged = false;
    try {
        const cfgResult = configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog'));
        configChanged = cfgResult.changed;
        if (cfgResult.warnings && cfgResult.warnings.length > 0) {
            vscode.window.showWarningMessage(
                'Mem Watchdog: invalid settings corrected to safe defaults — check Developer Console for details.'
            );
        }
    } catch (err) {
        // Non-fatal; daemon falls back to its built-in defaults
        console.error('[memWatchdog] configWriter error:', err.message);
    }

    // ── 2. Install / upgrade the daemon ──────────────────────────────────────
    try {
        const outcome = await installer.installOrUpgrade(context);
        if (outcome === 'installed') {
            vscode.window.showInformationMessage('Mem Watchdog: daemon installed and service started ✓');
        } else if (outcome === 'upgraded') {
            vscode.window.showInformationMessage('Mem Watchdog: daemon upgraded and service restarted ✓');
        } else if (outcome === 'current' && configChanged) {
            // Daemon file unchanged but config file was updated — restart so
            // the daemon re-sources the fresh config.  Without this, the daemon
            // runs with whatever config it loaded at its last start, which may
            // be from a previous extension version with different defaults.
            const { ok, stderr } = await sh('systemctl --user restart mem-watchdog');
            if (!ok) {
                console.error('[memWatchdog] config-triggered restart failed:', stderr);
            }
        }
        // 'current' + !configChanged → no notification; service is running correctly
    } catch (err) {
        vscode.window.showErrorMessage(`Mem Watchdog: install failed — ${err.message}`);
    }

    // ── 2b. Install / refresh user-level Copilot skill ─────────────────────
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

    // ── 3. Register commands ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('memWatchdog.showDashboard',  commands.showDashboard),
        vscode.commands.registerCommand('memWatchdog.preflightCheck', commands.preflightCheck),
        vscode.commands.registerCommand('memWatchdog.killDisposable', commands.killDisposable),
        vscode.commands.registerCommand('memWatchdog.restartService', commands.restartService),
        vscode.commands.registerCommand('memWatchdog.optimizeMemory', commands.optimizeMemory),
        vscode.commands.registerCommand('memWatchdog.createLowMemProfile', commands.createLowMemProfile),
        vscode.commands.registerCommand('memWatchdog.chatRescue', commands.chatRescue),
        { dispose: commands.dispose },
    );

    // ── 4. Settings change listener ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (!e.affectsConfiguration('memWatchdog')) { return; }
            let cfgWarnings = [];
            try {
                const cfgResult = configWriter.writeConfig(vscode.workspace.getConfiguration('memWatchdog'));
                cfgWarnings = cfgResult.warnings || [];
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
    disposeRuntimeUi();

    const item = vscode.window.createStatusBarItem(
        'mem-watchdog-status',
        vscode.StatusBarAlignment.Left,
        100
    );
    item.name    = 'Mem Watchdog';
    item.command = 'memWatchdog.showDashboard'; // clicking opens dashboard
    item.show();
    _statusItem = item;

    update(item);
    const timer = setInterval(() => update(item), POLL_INTERVAL_MS);
    _statusTimer = timer;
    const chatGuardTimer = setInterval(() => {
        commands.maybePromptChatRescue().catch((err) => {
            console.error('[memWatchdog] chat guard error:', err.message);
        });
    }, 60_000);
    _chatGuardTimer = chatGuardTimer;

    context.subscriptions.push(item);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    context.subscriptions.push({ dispose: () => clearInterval(chatGuardTimer) });
    context.subscriptions.push({ dispose: () => { disposeRuntimeUi(); _activated = false; } });

    // ── 6. Deferred self-update check ─────────────────────────────────────────
    // Check GitHub Releases for a newer extension version after a 10 s delay.
    // Non-blocking, throttled to once per 24 h, silently ignores network errors.
    // This ensures users with extensions.autoUpdate:false still learn about
    // critical daemon fixes in newer versions.
    const updateTimer = setTimeout(() => updateChecker.checkForUpdate(context), 10_000);
    context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });

    // ── 7. Optional chat participant (if Chat API is available) ─────────────
    registerChatParticipant(context);
}

function deactivate() {
    disposeRuntimeUi();
    _activated = false;
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
