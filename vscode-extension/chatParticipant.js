'use strict';

const vscode = require('vscode');

const commands = require('./commands');
const { readMeminfo, readPsi, sh } = require('./utils');

function hasChatApi() {
    return !!(vscode.chat && typeof vscode.chat.createChatParticipant === 'function');
}

function detectProfile(prompt = '') {
    const p = prompt.toLowerCase();
    if (/(playwright|headed|automation|browser-heavy)/.test(p)) { return 'playwright'; }
    if (/(conservative|safe|minimal|low\s*risk)/.test(p)) { return 'conservative'; }
    if (/(balanced|default|normal)/.test(p)) { return 'balanced'; }
    return null;
}

async function applyProfile(profile) {
    const cfg = vscode.workspace.getConfiguration('memWatchdog');

    // Values are MB in settings.
    const profiles = {
        balanced:     { warn: 2500, emerg: 3500, sigterm: 25, sigkill: 15 },
        conservative: { warn: 2200, emerg: 3200, sigterm: 28, sigkill: 18 },
        playwright:   { warn: 3000, emerg: 4200, sigterm: 30, sigkill: 20 },
    };

    const next = profiles[profile];
    if (!next) { return false; }

    await cfg.update('vscodeRssWarnMB', next.warn, vscode.ConfigurationTarget.Global);
    await cfg.update('vscodeRssEmergencyMB', next.emerg, vscode.ConfigurationTarget.Global);
    await cfg.update('sigtermThresholdPct', next.sigterm, vscode.ConfigurationTarget.Global);
    await cfg.update('sigkillThresholdPct', next.sigkill, vscode.ConfigurationTarget.Global);
    return true;
}

async function renderStatus() {
    const mem = readMeminfo();
    const psi = readPsi();
    const svc = await sh('systemctl --user is-active mem-watchdog 2>/dev/null || echo unknown');
    const vscodeRssKB = (await sh('ps -C code -o rss= 2>/dev/null')).stdout
        .split('\n')
        .filter(Boolean)
        .reduce((s, n) => s + (parseInt(n, 10) || 0), 0);

    if (!mem) {
        return `### Mem Watchdog Status\n\n- Service: **${svc.stdout || 'unknown'}**\n- /proc/meminfo: unreadable\n- PSI full avg10: ${(psi / 100).toFixed(2)}%\n`;
    }

    return [
        '### Mem Watchdog Status',
        '',
        `- Service: **${svc.stdout || 'unknown'}**`,
        `- RAM free: **${mem.pct.toFixed(1)}%** (${Math.round(mem.availableKB / 1024)} MB available)`,
        `- VS Code RSS: **${Math.round(vscodeRssKB / 1024)} MB**`,
        `- PSI full avg10: **${(psi / 100).toFixed(2)}%**`,
        '',
        'Use `/memwatchdog logs` for recent journal actions, or `/memwatchdog tune <profile>`.',
    ].join('\n');
}

async function requestHandler(request, context, stream) {
    const command = request.command || 'status';
    const prompt = request.prompt || '';

    if (command === 'status') {
        stream.markdown(await renderStatus());
        stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        stream.button({ command: 'memWatchdog.restartService', title: 'Restart Service' });
        return { metadata: { command } };
    }

    if (command === 'logs') {
        const { stdout } = await sh('journalctl --user -u mem-watchdog -n 40 --no-pager --output=short-monotonic 2>/dev/null || true');
        stream.markdown('### Recent mem-watchdog journal\n');
        stream.markdown('```text\n' + (stdout || '(no logs found)') + '\n```');
        stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        return { metadata: { command } };
    }

    if (command === 'act') {
        const p = prompt.toLowerCase();
        if (p.includes('kill') || p.includes('chrome')) {
            await commands.killChrome();
            stream.markdown('Sent `SIGTERM` to Chrome/Playwright targets.');
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
            stream.markdown('The extension settings listener will restart the service to load the new config.');
            stream.button({ command: 'memWatchdog.showDashboard', title: 'Open Dashboard' });
        } else {
            stream.markdown('Could not apply profile.');
        }
        return { metadata: { command } };
    }

    stream.markdown(await renderStatus());
    return { metadata: { command: 'status' } };
}

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
                ];
            }
            if (last === 'logs') {
                return [
                    { prompt: '/memwatchdog status', label: 'Refresh status snapshot' },
                    { prompt: '/memwatchdog act restart service', label: 'Restart service' },
                ];
            }
            return [
                { prompt: '/memwatchdog status', label: 'Show status' },
                { prompt: '/memwatchdog tune balanced', label: 'Apply balanced profile' },
            ];
        }
    };

    context.subscriptions.push(participant);
}

module.exports = {
    registerChatParticipant,
    _test: {
        detectProfile,
    },
};
