// utils.js — shared low-level helpers (no vscode dependency)
// ─────────────────────────────────────────────────────────────────────────────
// Imported by extension.js, installer.js, and commands.js.
// Keeping these here eliminates three separate copies of the same logic and
// ensures /proc/meminfo is read identically everywhere (critical: never read
// SwapFree — Crostini kernel reports ~18.4 exabytes as a uint64 overflow).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const { exec } = require('child_process');

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

module.exports = { readMeminfo, readPsi, sh, checkServiceStatus };
