// utils.js — shared low-level helpers (no vscode dependency)
// ─────────────────────────────────────────────────────────────────────────────
// Imported by extension.js, installer.js, and commands.js.
// Keeping these here eliminates three separate copies of the same logic and
// ensures /proc/meminfo is read identically everywhere (critical: never read
// SwapFree — Crostini kernel reports ~18.4 exabytes as a uint64 overflow).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { exec } = require('child_process');

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const MODE_FILE  = path.join(XDG_CONFIG, 'mem-watchdog', 'mode');
const CFG_FILE   = path.join(XDG_CONFIG, 'mem-watchdog', 'config.sh');
const KILL_APPROVAL_REQ_FILE = path.join(XDG_CONFIG, 'mem-watchdog', 'kill-approval-request');
const KILL_APPROVAL_RESP_FILE = path.join(XDG_CONFIG, 'mem-watchdog', 'kill-approval-response');

const DEFAULT_WARN_KB  = 3400000;
const DEFAULT_EMERG_KB = 3800000;

let _modeCache = { ts: 0, value: '' };

// ── cgroup.procs path — derived once at module load ───────────────────────────
// Used by checkServiceStatus() to check service liveness without fork/exec.
//
// Structure on Crostini (systemd user session, cgroup v1):
//   /proc/self/cgroup → '11:name=systemd:/user.slice/.../app.slice/app-org.chromium.Chromium-NNN.scope'
//   The running process is inside VS Code's Chromium scope. We walk up to the
//   shared app.slice ancestor, then append /mem-watchdog.service/cgroup.procs.
//
// The path is stable for the lifetime of the VS Code session — systemd does not
// rename the app.slice subtree between service start/stop cycles.
// Non-empty file = service active (has PIDs); empty = stopped/restarting; ENOENT = pre-install.
let _cgroupPath = null;
try {
    const selfCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const cgLine     = selfCgroup.split('\n').find(l => l.includes('name=systemd'));
    if (cgLine) {
        const rel        = cgLine.split(':')[2];
        const appSliceAt = rel.indexOf('/app.slice');
        if (appSliceAt >= 0) {
            _cgroupPath =
                '/sys/fs/cgroup/systemd' +
                rel.slice(0, appSliceAt + '/app.slice'.length) +
                '/mem-watchdog.service/cgroup.procs';
        }
    }
} catch (_) { /* non-systemd or non-cgroup-v1 environment — _cgroupPath stays null */ }

/**
 * Read /proc/meminfo and return { totalKB, availableKB, pct } or null.
 *
 * Reads ONLY MemTotal and MemAvailable — NEVER SwapFree.
 * On Crostini, SwapFree is a uint64 overflow sentinel (~18.4 exabytes) that
 * crashes any tool that passes it to strtol(). bash integer arithmetic ignores
 * it safely; this function avoids the field entirely.
 *
 * @returns {{ totalKB: number, availableKB: number, pct: number } | null}
 */
function readMeminfo() {
    try {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        // Two anchored multiline-flag regexes: ~30× faster and ~12× less heap
        // per call vs the split+loop approach (bench_meminfo.js: 156 ms vs
        // 4795 ms per 500k calls). Anchored ^ with /m ensures we never match a
        // false prefix inside a numeric value field.
        // NEVER read SwapFree — Crostini kernel reports ~18.4 exabytes (uint64
        // overflow sentinel) which crashes any tool using strtol().
        const mt  = raw.match(/^MemTotal:\s+(\d+)/m);
        const ma  = raw.match(/^MemAvailable:\s+(\d+)/m);
        const totalKB     = mt ? parseInt(mt[1], 10) : 0;
        const availableKB = ma ? parseInt(ma[1], 10) : 0;
        const pct = totalKB > 0 ? (availableKB / totalKB) * 100 : 0;
        return { totalKB, availableKB, pct };
    } catch (_) {
        return null;
    }
}

// ── PSI reader ────────────────────────────────────────────────────────────────

/**
 * Read /proc/pressure/memory full avg10, scaled ×100 for integer math.
 * e.g. avg10=3.45 → returns 345.
 * Returns 0 on any read/parse error.
 *
 * @returns {number}
 */
function readPsi() {
    try {
        const raw = fs.readFileSync('/proc/pressure/memory', 'utf8');
        const m = raw.match(/full avg10=([\d.]+)/);
        return m ? Math.round(parseFloat(m[1]) * 100) : 0;
    } catch (_) {
        return 0;
    }
}

// ── Shell helper ──────────────────────────────────────────────────────────────

/**
 * Promise wrapper around child_process.exec. Resolves — never rejects.
 * ok = true when exit code is 0.
 *
 * @param {string} cmd
 * @param {object} [opts]  — merged into exec options; timeout defaults to 15 s
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
function sh(cmd, opts = {}) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
            resolve({
                ok:     !err,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
            });
        });
    });
}

// ── Service status check ──────────────────────────────────────────────────────

/**
 * Check if mem-watchdog.service is active. Zero-fork hot-path check.
 *
 * Primary path: reads cgroup.procs — a kernel pseudo-file, no exec, no shell.
 *   ~14 µs/call vs ~8.7 ms/call for exec (600× cheaper).
 *   Survives OOM pressure: fork() fails with ENOMEM at near-zero free RAM,
 *   making exec-based checks unreachable precisely when the status indicator
 *   matters most.
 *
 * Fallback: `systemctl --user is-active` if the cgroup path is unavailable
 *   (non-standard cgroup hierarchy, remote extension host, Windows, etc.).
 *
 * @returns {Promise<'active' | 'inactive' | 'unknown'>}
 */
async function checkServiceStatus() {
    if (_cgroupPath) {
        try {
            const content = fs.readFileSync(_cgroupPath, 'utf8');
            return content.trimEnd().length > 0 ? 'active' : 'inactive';
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Service cgroup not yet created — daemon not installed or never started.
                return 'inactive';
            }
            // Any other error (EPERM, unexpected): fall through to exec.
        }
    }
    const { stdout } = await sh('systemctl --user is-active mem-watchdog');
    return stdout || 'unknown';
}

/**
 * Read watchdog mode from ~/.config/mem-watchdog/mode with a 1s cache.
 * Returns 'SLEEP' when the file contains SLEEP, else ''.
 *
 * @returns {string}
 */
function readWatchdogMode() {
    const now = Date.now();
    if (now - _modeCache.ts < 1000) {
        return _modeCache.value;
    }
    let mode = '';
    try {
        mode = (fs.readFileSync(MODE_FILE, 'utf8') || '').trim();
    } catch {
        mode = '';
    }
    _modeCache = { ts: now, value: mode };
    return mode;
}

/**
 * Parse optional RSS warn/emergency thresholds from config.sh.
 * Falls back to extension-safe defaults when unset.
 *
 * @returns {{ warnKB: number, emergKB: number }}
 */
function readRssThresholds() {
    let warnKB = DEFAULT_WARN_KB;
    let emergKB = DEFAULT_EMERG_KB;
    try {
        const raw = fs.readFileSync(CFG_FILE, 'utf8');
        const warn = raw.match(/^VSCODE_RSS_WARN_KB=(\d+)/m);
        const emerg = raw.match(/^VSCODE_RSS_EMERG_KB=(\d+)/m);
        if (warn) { warnKB = parseInt(warn[1], 10) || warnKB; }
        if (emerg) { emergKB = parseInt(emerg[1], 10) || emergKB; }
    } catch {
        // keep defaults
    }
    return { warnKB, emergKB };
}

/**
 * Read pending daemon kill-approval request from disk.
 * Request file format: key=value per line.
 * Returns null when file does not exist or is malformed.
 *
 * @returns {null | {
 *   id: string,
 *   ts: number,
 *   signal: string,
 *   mode: string,
 *   reason: string,
 *   pct?: number,
 *   mem_available_kb?: number,
 *   mem_total_kb?: number,
 *   psi_full_x100?: number,
 *   vscode_rss_kb?: number,
 * }}
 */
function readKillApprovalRequest() {
    try {
        const raw = fs.readFileSync(KILL_APPROVAL_REQ_FILE, 'utf8');
        const map = {};
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) { continue; }
            const i = trimmed.indexOf('=');
            if (i <= 0) { continue; }
            const k = trimmed.slice(0, i);
            const v = trimmed.slice(i + 1);
            map[k] = v;
        }
        if (!map.id || !map.ts || !map.signal) {
            return null;
        }
        const req = {
            id: String(map.id),
            ts: Number.parseInt(map.ts, 10) || 0,
            signal: String(map.signal),
            mode: String(map.mode || 'normal'),
            reason: String(map.reason || ''),
        };
        for (const numericKey of ['pct', 'mem_available_kb', 'mem_total_kb', 'psi_full_x100', 'vscode_rss_kb']) {
            if (Object.prototype.hasOwnProperty.call(map, numericKey)) {
                const n = Number.parseInt(map[numericKey], 10);
                if (Number.isFinite(n)) {
                    req[numericKey] = n;
                }
            }
        }
        return req;
    } catch {
        return null;
    }
}

/**
 * Persist operator decision for a pending kill-approval request.
 *
 * @param {string} requestId
 * @param {'allow'|'defer'} decision
 * @param {number} [deferSeconds]
 */
function writeKillApprovalDecision(requestId, decision, deferSeconds = 0) {
    const now = Math.floor(Date.now() / 1000);
    const lines = [
        `id=${requestId}`,
        `ts=${now}`,
        `decision=${decision}`,
    ];
    if (decision === 'defer') {
        lines.push(`defer_seconds=${Math.max(0, Math.floor(deferSeconds || 0))}`);
    }
    fs.mkdirSync(path.dirname(KILL_APPROVAL_RESP_FILE), { recursive: true });
    fs.writeFileSync(KILL_APPROVAL_RESP_FILE, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o644 });
}

/**
 * Determine thematic state from runtime signals.
 * Precedence: OFF > SLEEPING > ATTACKING > RECOVERING > ALERT > GUARDING
 *
 * @param {{ serviceStatus: string, mode?: string, vscodeRssKB?: number, warnKB?: number, emergKB?: number, lastActionAgeSec?: number }} input
 * @returns {'OFF'|'SLEEPING'|'ATTACKING'|'RECOVERING'|'ALERT'|'GUARDING'}
 */
function determineState(input) {
    const serviceStatus = input.serviceStatus || 'unknown';
    const mode = input.mode || '';
    const vscodeRssKB = input.vscodeRssKB || 0;
    const warnKB = input.warnKB || DEFAULT_WARN_KB;
    const emergKB = input.emergKB || DEFAULT_EMERG_KB;
    const lastActionAgeSec = Number.isFinite(input.lastActionAgeSec) ? input.lastActionAgeSec : Number.POSITIVE_INFINITY;

    if (serviceStatus !== 'active') { return 'OFF'; }
    if (mode === 'SLEEP') { return 'SLEEPING'; }
    if (lastActionAgeSec <= 10) { return 'ATTACKING'; }
    if (vscodeRssKB >= emergKB) { return 'ATTACKING'; }
    if (lastActionAgeSec <= 45) { return 'RECOVERING'; }
    if (vscodeRssKB >= warnKB) { return 'RECOVERING'; }
    if (vscodeRssKB >= Math.floor(warnKB * 0.8)) { return 'ALERT'; }
    return 'GUARDING';
}

/** @param {'OFF'|'SLEEPING'|'ATTACKING'|'RECOVERING'|'ALERT'|'GUARDING'} state */
function stateDescription(state) {
    switch (state) {
        case 'OFF': return 'Watchdog service is not running.';
        case 'SLEEPING': return 'Managed session active. Emergency protection remains active.';
        case 'ATTACKING': return 'Watchdog is actively reclaiming safety by terminating disposable targets.';
        case 'RECOVERING': return 'Recent intervention detected. Monitoring for recovery.';
        case 'ALERT': return 'Memory pressure is approaching warning levels.';
        default: return 'Watchdog is on patrol. All systems normal.';
    }
}

module.exports = {
    readMeminfo,
    readPsi,
    sh,
    checkServiceStatus,
    readWatchdogMode,
    readRssThresholds,
    readKillApprovalRequest,
    writeKillApprovalDecision,
    determineState,
    stateDescription,
};
