'use strict';
// bench_service_check.js — compare exec vs cgroup.procs for service status
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { promisify } = require('util');
const { exec } = require('child_process');
const execP = promisify(exec);

// ── Approach A: current — child_process.exec systemctl ───────────────────────
async function checkServiceExec() {
    const { stdout } = await execP('systemctl --user is-active mem-watchdog', { timeout: 5000 })
        .catch(e => ({ stdout: (e.stdout || '').trim() }));
    return (stdout || '').trim() || 'unknown';
}

// ── Approach B: cgroup.procs read — no exec, no fork ─────────────────────────
// Derives path once, caches it.
let _cgroupPath = null;

function deriveCgroupPath() {
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
    for (const line of raw.split('\n')) {
        if (!line.includes('name=systemd')) continue;
        const rel = line.split(':')[2]; // e.g. /user.slice/.../app.slice/something.service
        // Walk up to app.slice level, then append mem-watchdog.service
        const appSliceDir = '/sys/fs/cgroup/systemd' + rel.replace(/\/[^/]+\.service[^/]*$/, '');
        return path.join(appSliceDir, 'mem-watchdog.service', 'cgroup.procs');
    }
    return null;
}

function checkServiceCgroup() {
    try {
        if (!_cgroupPath) _cgroupPath = deriveCgroupPath();
        if (!_cgroupPath) return 'unknown';
        const content = fs.readFileSync(_cgroupPath, 'utf8').trim();
        return content.length > 0 ? 'active' : 'inactive';
    } catch (_) {
        return 'unknown';
    }
}

// ── Approach C: MainPID cached + /proc/<pid> liveness ────────────────────────
// Read MainPID once (via execSync at startup), then just check /proc/<pid>/cmdline
let _mainPid = 0;

function refreshMainPid() {
    try {
        _mainPid = parseInt(
            execSync('systemctl --user show mem-watchdog -p MainPID --value',
                { encoding: 'utf8', timeout: 3000 }).trim(), 10
        ) || 0;
    } catch (_) { _mainPid = 0; }
}

function checkServiceProcFs() {
    try {
        if (!_mainPid) { refreshMainPid(); }
        if (!_mainPid) return 'inactive';
        fs.accessSync('/proc/' + _mainPid + '/cmdline', fs.constants.F_OK);
        return 'active';
    } catch (_) {
        _mainPid = 0; // PID died — force refresh next tick
        return 'inactive';
    }
}

// ── Benchmarks ────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== Service status check benchmark ===\n');

    // Warm up
    await checkServiceExec();
    checkServiceCgroup();
    refreshMainPid(); checkServiceProcFs();

    // Print paths/results
    console.log('cgroup path:', _cgroupPath || deriveCgroupPath());
    console.log('cgroup result:', checkServiceCgroup());
    console.log('procfs result:', checkServiceProcFs());
    console.log('exec result:  (async, shown at end)\n');

    const execResult = await checkServiceExec();
    console.log('exec result:  ', execResult);
    console.log();

    // ── Benchmark B: cgroup.procs ─────────────────────────────────────────────
    global.gc();
    const m0b = process.memoryUsage();
    const t0b = Date.now();
    const B_RUNS = 10000;
    for (let i = 0; i < B_RUNS; i++) { checkServiceCgroup(); }
    const dtB = Date.now() - t0b;
    global.gc();
    const m1b = process.memoryUsage();
    console.log(`B cgroup.procs x${B_RUNS}:`);
    console.log(`  avg latency : ${(dtB / B_RUNS * 1000).toFixed(2)} µs/call`);
    console.log(`  heapUsed Δ  : ${((m1b.heapUsed - m0b.heapUsed)/1024).toFixed(1)} KB (post-GC)`);
    console.log(`  rss Δ       : ${((m1b.rss      - m0b.rss     )/1024).toFixed(1)} KB (post-GC)`);
    console.log();

    // ── Benchmark C: /proc/<pid>/cmdline ──────────────────────────────────────
    global.gc();
    const m0c = process.memoryUsage();
    const t0c = Date.now();
    const C_RUNS = 10000;
    for (let i = 0; i < C_RUNS; i++) { checkServiceProcFs(); }
    const dtC = Date.now() - t0c;
    global.gc();
    const m1c = process.memoryUsage();
    console.log(`C /proc/PID x${C_RUNS}:`);
    console.log(`  avg latency : ${(dtC / C_RUNS * 1000).toFixed(2)} µs/call`);
    console.log(`  heapUsed Δ  : ${((m1c.heapUsed - m0c.heapUsed)/1024).toFixed(1)} KB (post-GC)`);
    console.log(`  rss Δ       : ${((m1c.rss      - m0c.rss     )/1024).toFixed(1)} KB (post-GC)`);
    console.log();

    // ── Benchmark A: exec (fewer runs — it's slow) ────────────────────────────
    global.gc();
    const m0a = process.memoryUsage();
    const t0a = Date.now();
    const A_RUNS = 100;
    for (let i = 0; i < A_RUNS; i++) { await checkServiceExec(); }
    const dtA = Date.now() - t0a;
    global.gc();
    const m1a = process.memoryUsage();
    console.log(`A exec() x${A_RUNS}:`);
    console.log(`  avg latency : ${(dtA / A_RUNS).toFixed(1)} ms/call`);
    console.log(`  heapUsed Δ  : ${((m1a.heapUsed - m0a.heapUsed)/1024).toFixed(1)} KB (post-GC)`);
    console.log(`  rss Δ       : ${((m1a.rss      - m0a.rss     )/1024).toFixed(1)} KB (post-GC)`);
    console.log();

    // ── Daily cost summary ────────────────────────────────────────────────────
    const callsPerDay = (24 * 3600 / 2); // one call every 2s
    console.log(`=== Daily cost (${callsPerDay.toLocaleString()} calls/day at 2s interval) ===`);
    console.log(`A exec:     ${(dtA / A_RUNS * callsPerDay / 1000).toFixed(0)} ms CPU/day`);
    console.log(`B cgroup:   ${(dtB / B_RUNS * callsPerDay).toFixed(0)} ms CPU/day`);
    console.log(`C procfs:   ${(dtC / C_RUNS * callsPerDay).toFixed(0)} ms CPU/day`);
}

main().catch(console.error);
