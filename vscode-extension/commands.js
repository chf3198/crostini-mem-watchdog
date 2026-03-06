// commands.js — command handler implementations
// ─────────────────────────────────────────────────────────────────────────────
// Registered in extension.js activate(). Each handler corresponds to one
// `contributes.commands` entry in package.json.
//
// Commands:
//   memWatchdog.showDashboard   — full memory snapshot in an output channel
//   memWatchdog.preflightCheck  — RAM / Chrome / watchdog pass-fail summary
//   memWatchdog.killChrome      — immediate SIGTERM to all Chrome/Playwright
//   memWatchdog.restartService  — systemctl --user restart mem-watchdog
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');

// ── Shared output channel (created lazily) ────────────────────────────────────
let _channel = null;
function channel() {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('Mem Watchdog');
    }
    return _channel;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        });
    });
}

/** Read /proc/meminfo and return parsed key→number(kB) map. */
function readMeminfo() {
    try {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        const out = {};
        for (const line of raw.split('\n')) {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (m) { out[m[1]] = parseInt(m[2], 10); }
        }
        return out;
    } catch (_) {
        return {};
    }
}

/** Compute total RSS in kB for all processes matching a name pattern. */
async function totalRss(pattern) {
    const { stdout } = await sh(`ps -C ${pattern} -o rss= 2>/dev/null || true`);
    if (!stdout) { return 0; }
    return stdout.split('\n').reduce((s, n) => s + (parseInt(n, 10) || 0), 0);
}

/** Read PSI full avg10 (×100 for integer math). */
function readPsi() {
    try {
        const raw = fs.readFileSync('/proc/pressure/memory', 'utf8');
        const m = raw.match(/full avg10=([\d.]+)/);
        return m ? Math.round(parseFloat(m[1]) * 100) : 0;
    } catch (_) {
        return 0;
    }
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
    if (mi.MemTotal) {
        const totalMB = Math.round(mi.MemTotal   / 1024);
        const availMB = Math.round(mi.MemAvailable / 1024);
        const usedMB  = totalMB - availMB;
        const pct     = Math.round(availMB * 100 / mi.MemTotal);
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
    const mi      = readMeminfo();
    const pct     = mi.MemTotal ? Math.round(mi.MemAvailable * 100 / mi.MemTotal) : 0;
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
        ...(chromeRunning ? ['Kill Chrome Now'] : []),
        'Show Dashboard'
    );

    if (choice === 'Kill Chrome Now') { await killChrome(); }
    if (choice === 'Show Dashboard')  { await showDashboard(); }
}

// ── Command: Kill Chrome / Playwright Now ────────────────────────────────────

async function killChrome() {
    const results = await Promise.all([
        sh("pkill -SIGTERM -f '(chrome|chromium)' 2>/dev/null || true"),
        sh("pkill -SIGTERM -f 'node.*playwright' 2>/dev/null || true"),
    ]);

    const chromeSig  = results[0];
    const playSig    = results[1];

    // pkill exits 1 if no matching processes — that's fine
    const chromeKilled = chromeSig.ok;
    const playKilled   = playSig.ok;

    if (!chromeKilled && !playKilled) {
        vscode.window.showInformationMessage('Mem Watchdog: no Chrome or Playwright processes found.');
    } else {
        const parts = [
            chromeKilled ? 'Chrome/Chromium' : null,
            playKilled   ? 'Playwright node' : null,
        ].filter(Boolean);
        vscode.window.showInformationMessage(`Mem Watchdog: SIGTERM sent to ${parts.join(' + ')}.`);
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

// ── Dispose ────────────────────────────────────────────────────────────────────
function dispose() {
    if (_channel) { _channel.dispose(); _channel = null; }
}

module.exports = { showDashboard, preflightCheck, killChrome, restartService, dispose };
