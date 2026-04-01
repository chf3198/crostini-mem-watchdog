// commands.js — command handler implementations
// ─────────────────────────────────────────────────────────────────────────────
// Registered in extension.js activate(). Each handler corresponds to one
// `contributes.commands` entry in package.json.
//
// Commands:
//   memWatchdog.showDashboard        — full memory snapshot in an output channel
//   memWatchdog.preflightCheck       — RAM / Chrome / watchdog pass-fail summary
//   memWatchdog.killDisposable       — immediate SIGTERM to disposable-process targets
//   memWatchdog.restartService       — systemctl --user restart mem-watchdog
//   memWatchdog.optimizeMemory       — audit+apply low-memory settings profile
//   memWatchdog.createLowMemProfile  — guide VS Code profile creation for reduced extension load
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode = require('vscode');
const { readMeminfo, readPsi, sh } = require('./utils');
const optimizer = require('./optimizer');
const lowMemProfile = require('./lowMemProfile');
const chatContinuity = require('./chatContinuity');

// ── Shared output channel (created lazily) ────────────────────────────────────
let _channel = null;
let _lastRescuePromptKey = '';
function channel() {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('Mem Watchdog');
    }
    return _channel;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Compute total RSS in kB for all processes matching a name pattern. */
async function totalRss(pattern) {
    const { stdout } = await sh(`ps -C ${pattern} -o rss= 2>/dev/null || true`);
    if (!stdout) { return 0; }
    return stdout.split('\n').reduce((s, n) => s + (parseInt(n, 10) || 0), 0);
}

// ── Command: Show Memory Dashboard ───────────────────────────────────────────

async function showDashboard() {
    const ch = channel();
    ch.clear();
    ch.show(true /* preserve focus */);
    ch.appendLine('══════════════════════════════════════════════════════════════');
    ch.appendLine('  Mem Watchdog — Memory Dashboard');
    ch.appendLine(`  ${new Date().toLocaleString()}`);
    ch.appendLine('══════════════════════════════════════════════════════════════');

    // ── RAM summary ───────────────────────────────────────────────────────────
    const mi = readMeminfo();
    if (mi && mi.totalKB) {
        const totalMB = Math.round(mi.totalKB     / 1024);
        const availMB = Math.round(mi.availableKB / 1024);
        const usedMB  = totalMB - availMB;
        const pct     = Math.round(mi.pct);
        ch.appendLine('');
        ch.appendLine('  ── System RAM ──');
        ch.appendLine(`  Total:     ${totalMB} MB`);
        ch.appendLine(`  Available: ${availMB} MB  (${pct}% free)`);
        ch.appendLine(`  Used:      ${usedMB} MB`);
    }

    // ── PSI ────────────────────────────────────────────────────────────────────
    const psi = readPsi();
    ch.appendLine('');
    ch.appendLine('  ── Memory Pressure (PSI full avg10) ──');
    ch.appendLine(`  ${(psi / 100).toFixed(2)}%${psi >= 2500 ? '  ⚠ HIGH' : ''}`);

    // ── VS Code RSS ───────────────────────────────────────────────────────────
    const vscodeMB = Math.round(await totalRss('code') / 1024);
    const { stdout: vscodePids } = await sh('ps -C code -o pid=,comm=,rss= 2>/dev/null || true');
    ch.appendLine('');
    ch.appendLine('  ── VS Code (total RSS) ──');
    ch.appendLine(`  ${vscodeMB} MB`);
    if (vscodePids) {
        for (const line of vscodePids.split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            const rss   = parseInt(parts[2] || '0', 10);
            ch.appendLine(`    PID ${parts[0].padEnd(7)} ${(parts[1] || '').padEnd(20)} ${Math.round(rss / 1024)} MB`);
        }
    }

    // ── Chrome / Playwright ───────────────────────────────────────────────────
    const { stdout: chromePids } = await sh("ps -eo pid,comm,rss --no-headers 2>/dev/null | grep -E '(chrome|chromium|playwright)' || true");
    ch.appendLine('');
    ch.appendLine('  ── Chrome / Playwright ──');
    if (chromePids) {
        let totalChromeMB = 0;
        for (const line of chromePids.split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            const rss   = parseInt(parts[2] || '0', 10);
            totalChromeMB += rss;
            ch.appendLine(`    PID ${parts[0].padEnd(7)} ${(parts[1] || '').padEnd(20)} ${Math.round(rss / 1024)} MB`);
        }
        ch.appendLine(`  Total: ${Math.round(totalChromeMB / 1024)} MB`);
    } else {
        ch.appendLine('  (none running)');
    }

    // ── Watchdog service ──────────────────────────────────────────────────────
    const svc = await sh('systemctl --user is-active mem-watchdog 2>/dev/null || echo inactive');
    ch.appendLine('');
    ch.appendLine('  ── Watchdog Service ──');
    ch.appendLine(`  Status: ${svc.stdout}${svc.stdout === 'active' ? '  ✓' : '  ✗'}`);

    // ── Recent journal lines ───────────────────────────────────────────────────
    const { stdout: journal } = await sh('journalctl --user -u mem-watchdog -n 8 --no-pager --output=short-monotonic 2>/dev/null || true');
    if (journal) {
        ch.appendLine('');
        ch.appendLine('  ── Recent Journal (last 8 lines) ──');
        for (const line of journal.split('\n').filter(Boolean)) {
            ch.appendLine('  ' + line);
        }
    }

    ch.appendLine('');
    ch.appendLine('══════════════════════════════════════════════════════════════');
}

// ── Command: Playwright Pre-flight Check ─────────────────────────────────────

async function preflightCheck() {
    const mi  = readMeminfo();
    const pct = mi ? Math.round(mi.pct) : 0;
    const vsRSS   = Math.round(await totalRss('code')    / 1024);
    const { ok: svcOk } = await sh('systemctl --user is-active mem-watchdog 2>/dev/null');
    const chromeRunning  = (await sh("pgrep -fc '(chrome|chromium)' 2>/dev/null || echo 0")).stdout !== '0';

    const cfg          = vscode.workspace.getConfiguration('memWatchdog');
    const sigtermPct   = cfg.get('sigtermThresholdPct', 25);
    const rssWarnMB    = cfg.get('vscodeRssWarnMB', 2500);

    const checks = [
        { name: 'RAM available', pass: pct > sigtermPct, detail: `${pct}% free (threshold: >${sigtermPct}%)` },
        { name: 'VS Code RSS',   pass: vsRSS < rssWarnMB, detail: `${vsRSS} MB (warn at ≥${rssWarnMB} MB)` },
        { name: 'Chrome/MCP',    pass: !chromeRunning,    detail: chromeRunning ? 'running (will consume ~700 MB)' : 'not running ✓' },
        { name: 'Watchdog',      pass: svcOk,             detail: svcOk ? 'active ✓' : 'NOT running — install may be needed' },
    ];

    const allPass = checks.every(c => c.pass);
    const icon    = allPass ? '✅' : '⚠️';
    const summary = allPass
        ? 'All checks passed — safe to launch Playwright.'
        : 'One or more checks failed — see details.';

    const detail = checks.map(c => `${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');

    const choice = await vscode.window.showInformationMessage(
        `${icon} Pre-flight: ${summary}`,
        { detail, modal: true },
        ...(chromeRunning ? ['Kill Disposable Processes Now'] : []),
        'Show Dashboard'
    );

    if (choice === 'Kill Disposable Processes Now') { await killDisposable(); }
    if (choice === 'Show Dashboard')  { await showDashboard(); }
}

// ── Command: Kill Disposable Processes Now ───────────────────────────────────

async function killDisposable() {
    const results = await Promise.all([
        sh("pkill -SIGTERM -f '(chrome|chromium)' 2>/dev/null"),
        sh("pkill -SIGTERM -f 'node.*playwright' 2>/dev/null"),
    ]);

    const chromeSig  = results[0];
    const playSig    = results[1];

    // pkill exits 0 if ≥1 process was signaled, 1 if none matched — ok reflects this
    const chromeKilled = chromeSig.ok;
    const playKilled   = playSig.ok;

    if (!chromeKilled && !playKilled) {
        vscode.window.showInformationMessage('Mem Watchdog: no disposable processes found.');
    } else {
        const parts = [
            chromeKilled ? 'Chrome/Chromium' : null,
            playKilled   ? 'Playwright node' : null,
        ].filter(Boolean);
        vscode.window.showInformationMessage(`Mem Watchdog: SIGTERM sent to disposable targets (${parts.join(' + ')}).`);
    }
}

// ── Command: Restart Service ──────────────────────────────────────────────────

async function restartService() {
    const { ok, stderr } = await sh('systemctl --user restart mem-watchdog 2>&1');
    if (ok) {
        vscode.window.showInformationMessage('Mem Watchdog: service restarted ✓');
    } else {
        vscode.window.showErrorMessage(`Mem Watchdog: restart failed — ${stderr}`);
    }
}

// ── Command: Create / Guide Low-Memory Profile ───────────────────────────────

async function createLowMemProfile() {
    return lowMemProfile.createLowMemProfile(vscode);
}

// ── Command: Rescue oversized chat session ──────────────────────────────────

async function chatRescue(options = {}) {
    const cfg = vscode.workspace.getConfiguration('memWatchdog');
    const thresholdMB = cfg.get('chatGuard.sessionSizeMB', chatContinuity.DEFAULT_SESSION_THRESHOLD_MB);
    const keepArchives = cfg.get('chatGuard.preserveCount', 3);
    const restartAfterRescue = cfg.get('chatGuard.restartAfterRescue', true);
    const candidate = options.session || chatContinuity.findRescueCandidate({ thresholdMB });

    if (!candidate) {
        vscode.window.showInformationMessage(`Mem Watchdog: no active chat session exceeds ${thresholdMB} MB.`);
        return { ok: false, reason: 'no-candidate' };
    }

    const sizeText = chatContinuity.formatBytes(candidate.sizeBytes);
    const detail = [
        `Oversized session: ${candidate.name}`,
        `Size: ${sizeText}`,
        `Modified: ${new Date(candidate.mtimeMs).toLocaleString()}`,
        'Mem Watchdog can move it out of the active chat store, generate a continuity pack, and optionally reload VS Code before the extension host re-parses it.',
    ].join('\n');

    if (!options.skipConfirmation) {
        const choice = await vscode.window.showWarningMessage(
            `Mem Watchdog: rescue oversized Copilot chat session (${sizeText})?`,
            { modal: true, detail },
            'Archive + Restart',
            'Archive Only',
            'Cancel'
        );
        if (choice === 'Cancel' || !choice) {
            return { ok: false, reason: 'cancelled' };
        }
        options = {
            ...options,
            restart: choice === 'Archive + Restart',
        };
    }

    const result = await chatContinuity.rescueSession(vscode, {
        session: candidate,
        thresholdMB,
        keepArchives,
        openResume: true,
    });

    if (!result.ok) {
        vscode.window.showWarningMessage('Mem Watchdog: chat rescue did not find a session to archive.');
        return result;
    }

    const shouldRestart = options.restart ?? restartAfterRescue;
    vscode.window.showInformationMessage(
        `Mem Watchdog: archived ${candidate.name} and opened ${result.resumePath}. ${shouldRestart ? 'Reloading VS Code to break the restart loop.' : 'Continue from the opened resume prompt when ready.'}`
    );

    if (shouldRestart) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return { ok: true, ...result, restarted: shouldRestart };
}

async function maybePromptChatRescue() {
    const cfg = vscode.workspace.getConfiguration('memWatchdog');
    if (!cfg.get('chatGuard.enabled', true)) { return false; }

    const thresholdMB = cfg.get('chatGuard.sessionSizeMB', chatContinuity.DEFAULT_SESSION_THRESHOLD_MB);
    const rssWarnMB = cfg.get('vscodeRssWarnMB', 3400);
    const autoRescue = cfg.get('chatGuard.autoRescue', 'prompt');
    const candidate = chatContinuity.findRescueCandidate({ thresholdMB });
    if (!candidate) { return false; }

    const vscodeRssMB = Math.round(await totalRss('code') / 1024);
    const oversized = candidate.sizeBytes >= (thresholdMB * 1024 * 1024 * 2);
    if (vscodeRssMB < rssWarnMB && !oversized) { return false; }

    const promptKey = `${candidate.filePath}:${candidate.sizeBytes}:${candidate.mtimeMs}`;
    if (promptKey === _lastRescuePromptKey) { return false; }
    _lastRescuePromptKey = promptKey;

    if (autoRescue === 'auto') {
        await chatRescue({ session: candidate, skipConfirmation: true, restart: true });
        return true;
    }
    if (autoRescue !== 'prompt') { return false; }

    const choice = await vscode.window.showWarningMessage(
        `Mem Watchdog: Copilot chat session ${candidate.name} grew to ${chatContinuity.formatBytes(candidate.sizeBytes)} while VS Code is at ${vscodeRssMB} MB RSS.`,
        { modal: false, detail: 'Rescue archives the session out of active chat storage, generates a continuity pack, and can reload the window before the extension host re-parses the oversized JSON.' },
        'Rescue Now',
        'Later'
    );
    if (choice === 'Rescue Now') {
        await chatRescue({ session: candidate, skipConfirmation: true, restart: cfg.get('chatGuard.restartAfterRescue', true) });
        return true;
    }
    return false;
}

// ── Dispose ────────────────────────────────────────────────────────────────────
function dispose() {
    if (_channel) { _channel.dispose(); _channel = null; }
}

// ── Command: Optimize VS Code for Low Memory ─────────────────────────────────

async function optimizeMemory() {
    const cfg = vscode.workspace.getConfiguration();
    const settingsAudit = optimizer.auditSettings(cfg);
    const argvAudit     = optimizer.auditArgv();
    const extensionAudit = lowMemProfile.analyzeInstalledExtensions(vscode.extensions?.all || []);

    const totalMissing = settingsAudit.missing.length + argvAudit.missing.length;
    const totalApplied = settingsAudit.applied.length + argvAudit.applied.length;
    const totalChecked = totalApplied + totalMissing;

    if (totalMissing === 0) {
        if (extensionAudit.recommendProfile) {
            const choice = await vscode.window.showInformationMessage(
                `Mem Watchdog: settings are fully optimized, but ${extensionAudit.totalUserExtensions} user extensions are still installed. ${lowMemProfile.summarizeAnalysis(extensionAudit)}`,
                'Guide LowMem Profile',
                'Show Recommendations'
            );
            if (choice === 'Guide LowMem Profile') {
                await createLowMemProfile();
            } else if (choice === 'Show Recommendations') {
                await lowMemProfile.showRecommendedExtensions(vscode, extensionAudit);
            }
            return;
        }
        vscode.window.showInformationMessage(
            `Mem Watchdog: VS Code is fully optimized — ${totalApplied}/${totalChecked} settings match the low-memory profile. ✓`
        );
        return;
    }

    // Build a detail string for the confirmation dialog
    const detailLines = [];
    for (const m of argvAudit.missing) {
        detailLines.push(`[argv.json] ${m.key} → ${JSON.stringify(m.value)} (${m.savings})`);
    }
    for (const m of settingsAudit.missing) {
        const val = typeof m.value === 'object' ? '(merge profile)' : JSON.stringify(m.value);
        detailLines.push(`${m.key} → ${val} (${m.savings})`);
    }

    if (extensionAudit.recommendProfile) {
        detailLines.push('');
        detailLines.push(`[extensions] ${lowMemProfile.summarizeAnalysis(extensionAudit)}`);
    }

    const choice = await vscode.window.showInformationMessage(
        `Mem Watchdog: ${totalMissing} memory optimization(s) available (${totalApplied}/${totalChecked} already applied).`,
        { detail: detailLines.join('\n'), modal: true },
        'Apply All',
        'Show Details',
        ...(extensionAudit.recommendProfile ? ['Guide LowMem Profile'] : [])
    );

    if (choice === 'Guide LowMem Profile') {
        await createLowMemProfile();
        return;
    }

    if (choice === 'Show Details') {
        const ch = channel();
        ch.clear();
        ch.show(true);
        ch.appendLine('══════════════════════════════════════════════════════════════');
        ch.appendLine('  Mem Watchdog — Memory Optimization Audit');
        ch.appendLine(`  ${new Date().toLocaleString()}`);
        ch.appendLine('══════════════════════════════════════════════════════════════');
        ch.appendLine('');
        ch.appendLine(`  ${totalApplied}/${totalChecked} optimizations already applied.`);
        ch.appendLine(`  ${totalMissing} optimization(s) available:`);
        ch.appendLine('');

        if (argvAudit.missing.length > 0) {
            ch.appendLine('  ── argv.json (requires VS Code restart) ──');
            for (const m of argvAudit.missing) {
                ch.appendLine(`    ${m.key}: ${JSON.stringify(m.currentValue)} → ${JSON.stringify(m.value)}`);
                ch.appendLine(`      Savings: ${m.savings} — ${m.reason}`);
            }
            ch.appendLine('');
        }

        if (settingsAudit.missing.length > 0) {
            ch.appendLine('  ── settings.json ──');
            for (const m of settingsAudit.missing) {
                const cur = typeof m.currentValue === 'object' ? JSON.stringify(m.currentValue) : String(m.currentValue);
                const val = typeof m.value === 'object' ? '(merge profile keys)' : String(m.value);
                ch.appendLine(`    ${m.key}: ${cur} → ${val}`);
                ch.appendLine(`      Savings: ${m.savings} — ${m.reason}`);
            }
            ch.appendLine('');
        }

        ch.appendLine('  ── Already applied ──');
        for (const a of [...settingsAudit.applied, ...argvAudit.applied]) {
            ch.appendLine(`    ✓ ${a.key} (${a.savings})`);
        }
        ch.appendLine('');

        if (extensionAudit.recommendProfile) {
            ch.appendLine('  ── LowMem profile recommendation ──');
            ch.appendLine(`  ${lowMemProfile.summarizeAnalysis(extensionAudit)}`);
            if (extensionAudit.recommendedDisableIds.length > 0) {
                ch.appendLine(`  Heavy candidates: ${extensionAudit.recommendedDisableIds.join(', ')}`);
            }
            ch.appendLine('');
        }

        ch.appendLine('══════════════════════════════════════════════════════════════');
        return;
    }

    if (choice !== 'Apply All') { return; }

    // ── Apply settings ────────────────────────────────────────────────────────
    let settingsCount = 0;
    let argvChanged   = false;

    if (settingsAudit.missing.length > 0) {
        settingsCount = await optimizer.applySettings(vscode, settingsAudit.missing);
    }

    if (argvAudit.missing.length > 0) {
        argvChanged = optimizer.applyArgv(argvAudit.missing, argvAudit.argvContent);
    }

    const parts = [];
    if (settingsCount > 0) { parts.push(`${settingsCount} settings applied`); }
    if (argvChanged)        { parts.push('argv.json updated'); }

    if (argvChanged) {
        const restart = await vscode.window.showInformationMessage(
            `Mem Watchdog: ${parts.join(', ')}. VS Code restart required for argv.json changes.`,
            'Restart Now',
            'Later'
        );
        if (restart === 'Restart Now') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } else if (settingsCount > 0) {
        vscode.window.showInformationMessage(`Mem Watchdog: ${parts.join(', ')}. ✓`);
    }
}

module.exports = { showDashboard, preflightCheck, killDisposable, restartService, optimizeMemory, createLowMemProfile, chatRescue, maybePromptChatRescue, dispose };
