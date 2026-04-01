'use strict';

const vscode = require('vscode');

const commands = require('./commands');
const optimizer = require('./optimizer');
const lowMemProfile = require('./lowMemProfile');
const {
    readMeminfo,
    readPsi,
    sh,
    readWatchdogMode,
    readRssThresholds,
    determineState,
    stateDescription,
} = require('./utils');

// ── Chat API detection ────────────────────────────────────────────────────────
// The Chat API (vscode.chat.createChatParticipant) requires VS Code ≥ 1.93.
// The extension's engines.vscode is ^1.74.0 so the API may not be available.
// This runtime guard avoids hard failures on older builds.
function hasChatApi() {
    return !!(vscode.chat && typeof vscode.chat.createChatParticipant === 'function');
}

// ── Tuning profiles ───────────────────────────────────────────────────────────
// Values are percent for MemAvailable thresholds (stage triggers).
// Aligned with daemon defaults (v20260330.1): MemAvail-primary, no RSS triggers.
const PROFILES = {
    balanced:     { sigterm: 25, sigkill: 15 },
    conservative: { sigterm: 28, sigkill: 18 },
    playwright:   { sigterm: 22, sigkill: 12 },
};

function detectProfile(prompt = '') {
    const p = prompt.toLowerCase();
    if (/(playwright|headed|automation|browser-heavy)/.test(p)) { return 'playwright'; }
    if (/(conservative|safe|minimal|low\s*risk)/.test(p)) { return 'conservative'; }
    if (/(balanced|default|normal)/.test(p)) { return 'balanced'; }
    return null;
}

async function applyProfile(profile) {
    const cfg = vscode.workspace.getConfiguration('memWatchdog');
    const next = PROFILES[profile];
    if (!next) { return false; }

    await cfg.update('sigtermThresholdPct', next.sigterm, vscode.ConfigurationTarget.Global);
    await cfg.update('sigkillThresholdPct', next.sigkill, vscode.ConfigurationTarget.Global);
    return true;
}

// ── Status rendering ──────────────────────────────────────────────────────────

async function renderStatus() {
    const mem = readMeminfo();
    const psi = readPsi();
    const svc = await sh('systemctl --user is-active mem-watchdog 2>/dev/null || echo unknown');
    const serviceStatus = (svc.stdout || 'unknown').trim();
    const uptime = await sh('systemctl --user show mem-watchdog -p ActiveEnterTimestamp --value 2>/dev/null || true');
    const uptimeText = (uptime.stdout || '').trim() || 'unknown';
    const mode = readWatchdogMode();
    const { warnKB, emergKB } = readRssThresholds();
    const vsRssResult = await sh('ps -C code -o rss= 2>/dev/null');
    const vscodeRssKB = (vsRssResult.stdout || '')
        .split('\n')
        .filter(Boolean)
        .reduce((s, n) => s + (parseInt(n, 10) || 0), 0);

    const state = determineState({
        serviceStatus,
        mode,
        vscodeRssKB,
        warnKB,
        emergKB,
    });
    const stateDesc = stateDescription(state);

    if (!mem) {
        return `### Mem Watchdog Status\n\n` +
            `- Service: **${serviceStatus}**\n` +
            `- Service uptime: **${uptimeText}**\n` +
            `- State: **${state}** — ${stateDesc}\n` +
            `- /proc/meminfo: unreadable\n` +
            `- PSI full avg10: ${(psi / 100).toFixed(2)}%\n`;
    }

    return [
        '### Mem Watchdog Status',
        '',
        `- Service: **${serviceStatus}**`,
        `- Service uptime: **${uptimeText}**`,
        `- State: **${state}** — ${stateDesc}`,
        `- RAM free: **${mem.pct.toFixed(1)}%** (${Math.round(mem.availableKB / 1024)} MB available)`,
        `- VS Code RSS: **${Math.round(vscodeRssKB / 1024)} MB**`,
        `- WARN / EMERG: **${Math.round(warnKB / 1024)} / ${Math.round(emergKB / 1024)} MB**`,
        `- PSI full avg10: **${(psi / 100).toFixed(2)}%**`,
        '',
        'Use `/memwatchdog logs` for recent journal actions, or `/memwatchdog tune <profile>`.',
    ].join('\n');
}

// ── Request handler ───────────────────────────────────────────────────────────

async function requestHandler(request, _context, stream) {
    const command = request.command || 'status';
    const prompt = request.prompt || '';

    if (command === 'status') {
        stream.markdown(await renderStatus());
        stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        stream.button({ command: 'memWatchdog.restartService', title: 'Restart Service' });
        return { metadata: { command } };
    }

    if (command === 'logs') {
        const { stdout } = await sh(
            'journalctl --user -u mem-watchdog -n 40 --no-pager --output=short-monotonic 2>/dev/null || true'
        );
        stream.markdown('### Recent mem-watchdog journal\n');
        stream.markdown('```text\n' + (stdout || '(no logs found)') + '\n```');
        stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        return { metadata: { command } };
    }

    if (command === 'act') {
        const p = prompt.toLowerCase();
        if (p.includes('kill') || p.includes('chrome')) {
            await commands.killDisposable();
            stream.markdown('Sent `SIGTERM` to disposable-process targets.');
        } else if (p.includes('restart') || p.includes('service')) {
            await commands.restartService();
            stream.markdown('Restarted `mem-watchdog` service (or attempted restart).');
        } else {
            await commands.showDashboard();
            stream.markdown('Opened the Mem Watchdog dashboard.');
        }
        return { metadata: { command } };
    }

    if (command === 'tune') {
        const profile = detectProfile(prompt);
        if (!profile) {
            stream.markdown(
                'Specify a profile: `balanced`, `conservative`, or `playwright`.\n\n' +
                'Examples:\n' +
                '- `/memwatchdog tune balanced`\n' +
                '- `/memwatchdog tune conservative`\n' +
                '- `/memwatchdog tune playwright`'
            );
            return { metadata: { command } };
        }

        const ok = await applyProfile(profile);
        if (ok) {
            stream.markdown(`Applied **${profile}** profile to Mem Watchdog settings.`);
            stream.markdown(
                'The extension settings listener will restart the service to load the new config.'
            );
            stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        } else {
            stream.markdown('Could not apply profile.');
        }
        return { metadata: { command } };
    }

    if (command === 'optimize') {
        const cfg = vscode.workspace.getConfiguration();
        const settingsAudit = optimizer.auditSettings(cfg);
        const argvAudit     = optimizer.auditArgv();
        const extensionAudit = lowMemProfile.analyzeInstalledExtensions(vscode.extensions?.all || []);
        const report        = optimizer.renderReport(settingsAudit, argvAudit, extensionAudit);

        stream.markdown(report);

        const totalMissing = settingsAudit.missing.length + argvAudit.missing.length;
        if (totalMissing > 0) {
            stream.button({ command: 'memWatchdog.optimizeMemory', title: 'Apply Optimizations' });
        }
        if (extensionAudit.recommendProfile) {
            stream.button({ command: 'memWatchdog.createLowMemProfile', title: 'Guide LowMem Profile' });
        }
        stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        return { metadata: { command } };
    }

    if (command === 'lowmem') {
        const extensionAudit = lowMemProfile.analyzeInstalledExtensions(vscode.extensions?.all || []);
        stream.markdown(lowMemProfile.renderLowMemReport(extensionAudit));
        stream.button({ command: 'memWatchdog.createLowMemProfile', title: 'Guide LowMem Profile' });
        stream.button({ command: 'memWatchdog.optimizeMemory', title: 'Optimize Settings' });
        return { metadata: { command } };
    }

    if (command === 'rescue') {
        await commands.chatRescue();
        stream.markdown('Started the oversized chat rescue flow. Mem Watchdog will archive the active large session, generate a continuity pack, and reload the window if you confirm restart.');
        return { metadata: { command } };
    }

    // Unrecognised command → default to status
    stream.markdown(await renderStatus());
    return { metadata: { command: 'status' } };
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerChatParticipant(context) {
    if (!hasChatApi()) { return; }

    const participant = vscode.chat.createChatParticipant(
        'mem-watchdog-status.memWatchdogAssistant',
        requestHandler,
    );

    participant.followupProvider = {
        provideFollowups(result) {
            const last = result?.metadata?.command;
            if (last === 'status') {
                return [
                    { prompt: '/memwatchdog logs', label: 'Show recent logs' },
                    { prompt: '/memwatchdog tune conservative', label: 'Apply conservative profile' },
                    { prompt: '/memwatchdog optimize', label: 'Audit VS Code memory settings' },
                    { prompt: '/memwatchdog lowmem', label: 'Plan a LowMem profile' },
                    { prompt: '/memwatchdog rescue', label: 'Rescue oversized chat history' },
                ];
            }
            if (last === 'logs') {
                return [
                    { prompt: '/memwatchdog status', label: 'Refresh status snapshot' },
                    { prompt: '/memwatchdog act restart service', label: 'Restart service' },
                ];
            }
            if (last === 'optimize') {
                return [
                    { prompt: '/memwatchdog status', label: 'Show status' },
                    { prompt: '/memwatchdog tune balanced', label: 'Apply balanced profile' },
                    { prompt: '/memwatchdog lowmem', label: 'Plan a LowMem profile' },
                ];
            }
            if (last === 'lowmem') {
                return [
                    { prompt: '/memwatchdog optimize', label: 'Optimize settings' },
                    { prompt: '/memwatchdog status', label: 'Show status' },
                    { prompt: '/memwatchdog rescue', label: 'Rescue oversized chat history' },
                ];
            }
            return [
                { prompt: '/memwatchdog status', label: 'Show status' },
                { prompt: '/memwatchdog optimize', label: 'Audit VS Code memory settings' },
                { prompt: '/memwatchdog lowmem', label: 'Plan a LowMem profile' },
                { prompt: '/memwatchdog rescue', label: 'Rescue oversized chat history' },
            ];
        },
    };

    context.subscriptions.push(participant);
}

module.exports = {
    registerChatParticipant,
    PROFILES,
};

// ── Test-only exports ─────────────────────────────────────────────────────────
/* c8 ignore next */
if (process.env.MEM_WATCHDOG_TEST) {
    module.exports._test = {
        hasChatApi,
        detectProfile,
        applyProfile,
        renderStatus,
        requestHandler,
    };
}
