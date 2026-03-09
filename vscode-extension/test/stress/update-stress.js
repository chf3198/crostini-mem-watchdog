// test/stress/update-stress.js — Extension update() loop stress harness
// ─────────────────────────────────────────────────────────────────────────────
// Runs update() under 6 load profiles and logs every efficiency metric useful
// for CPU and memory post-analysis:
//
//   - dropped call rate     → pileup guard effectiveness under concurrent load
//   - IPC cache hit rate    → _lastStateKey cache effectiveness (IPC skips/day)
//   - heap Δ after GC       → per-call net memory growth (leak detection)
//   - µs/call               → total cost of one status-bar tick
//   - event-loop max lag    → measures synchronous blocking (readFileSync, etc.)
//   - V8 heap stats         → native/detached context counts (leak signals)
//
// Run:    node --expose-gc test/stress/update-stress.js
// Output: stdout summary  +  scratch/stress-<TIMESTAMP>.json
//
// The --expose-gc flag is required for accurate post-GC heap deltas.
// Without it the heap snapshot is taken before any GC has a chance to run and
// the reported delta includes allocations that would be collected immediately.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const fs   = require('fs');
const v8   = require('v8');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

// ── Mock 'vscode' (must happen before require('../../extension')) ─────────────
const { setup: vsSetup } = require('../helpers/mockVscode');
vsSetup();

// ── Mock './utils' ────────────────────────────────────────────────────────────
// Mirrors the injection technique used by extension.test.js.
const utilsAbsPath = path.resolve(__dirname, '../../utils.js');

const mockState = {
    meminfo:        { totalKB: 6626000, availableKB: 4395000, pct: 66 },
    svcStatus:      'active',
    shDelay:        0,
    checkCallCount: 0,
};

function mockReadMeminfo() { return mockState.meminfo; }

async function mockCheckServiceStatus() {
    if (mockState.shDelay > 0) {
        await new Promise(r => setTimeout(r, mockState.shDelay));
    }
    mockState.checkCallCount++;
    return mockState.svcStatus;
}

async function mockSh() {
    if (mockState.shDelay > 0) {
        await new Promise(r => setTimeout(r, mockState.shDelay));
    }
    return { ok: true, stdout: mockState.svcStatus, stderr: '' };
}

require.cache[utilsAbsPath] = {
    id: utilsAbsPath, filename: utilsAbsPath, loaded: true, paths: [],
    exports: { readMeminfo: mockReadMeminfo, sh: mockSh, checkServiceStatus: mockCheckServiceStatus },
};

// ── Load extension with test seam ─────────────────────────────────────────────
process.env.MEM_WATCHDOG_TEST = '1';
const ext = require('../../extension');
const { update, POLL_INTERVAL_MS, resetStateCache, resetStats, getStats } = ext._test;

// ── Output paths ──────────────────────────────────────────────────────────────
// scratch/ lives at the repo root, three levels above this file.
const SCRATCH  = path.resolve(__dirname, '../../../scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const STAMP    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const JSON_LOG = path.join(SCRATCH, `stress-${STAMP}.json`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeItem() {
    return { text: '', color: undefined, backgroundColor: undefined, tooltip: undefined };
}

// Run GC twice: first pass promotes surviving objects to old-gen; second pass
// gives a stable heap reading by collecting any weak references cleaned up
// during the first pass.
function gc2() {
    if (typeof global.gc === 'function') { global.gc(); global.gc(); }
}

const HR = '═'.repeat(68);
const hr = '─'.repeat(68);

function log(s = '') { process.stdout.write(s + '\n'); }

// ── Reset all state between scenarios ────────────────────────────────────────
function resetAll(overrides = {}) {
    resetStateCache();
    resetStats();
    Object.assign(mockState, {
        meminfo:        { totalKB: 6626000, availableKB: 4395000, pct: 66 },
        svcStatus:      'active',
        shDelay:        0,
        checkCallCount: 0,
    }, overrides);
}

// ── State patterns for sequential scenarios ───────────────────────────────────
// Return a meminfo object for call index i. Used to drive the IPC cache
// hit/miss ratio to specific values for each scenario.

// Alternates healthy ↔ warning every 50 calls (~98% cache hit rate per window).
const stateToggle50 = i => {
    const pct = (Math.floor(i / 50) % 2 === 0) ? 66 : 25;
    return { totalKB: 6626000, availableKB: Math.round(6626000 * pct / 100), pct };
};

// Cycles through all three RAM-level states (healthy/warning/critical) every
// 100 calls: 99/100 = 99% cache hit rate within each window.
const stateAllLevels = i => {
    const levels = [66, 25, 14];
    const pct    = levels[Math.floor(i / 100) % levels.length];
    return { totalKB: 6626000, availableKB: Math.round(6626000 * pct / 100), pct };
};

// ── Run one scenario ──────────────────────────────────────────────────────────
async function runScenario(cfg) {
    const {
        name,
        description,
        totalCalls,
        concurrent   = false,  // fire all calls at once
        shDelay      = 0,
        statePattern = null,   // fn(i) → meminfo for call i; null = stable state
    } = cfg;

    resetAll({ shDelay });
    const item = makeItem();

    // ── Pre-scenario GC + heap baseline ──────────────────────────────────────
    gc2();
    const memBefore = process.memoryUsage();
    const v8Before  = v8.getHeapStatistics();

    // ── Event-loop lag histogram (sequential only) ────────────────────────────
    // monitorEventLoopDelay uses a uv_timer_t on the main event loop — no OS
    // thread, no Worker (confirmed: process.getActiveResourcesInfo() shows a
    // 'Timeout', not a 'Worker'). RSS is part of the main process heap.
    // At resolution=1ms, detects synchronous blocking events ≥ 1 ms.
    // A value of 0 means "no blocking detected at this resolution" — not
    // "zero overhead". Sub-ms operations won't accumulate lag.
    // Not enabled for concurrent scenarios (async awaits are the dominant cost).
    let hist = null;
    if (!concurrent) {
        hist = monitorEventLoopDelay({ resolution: 1 });
        hist.enable();
    }

    // ── Run ───────────────────────────────────────────────────────────────────
    const t0 = performance.now();

    if (concurrent) {
        await Promise.all(Array.from({ length: totalCalls }, () => update(item)));
    } else {
        for (let i = 0; i < totalCalls; i++) {
            if (statePattern) { mockState.meminfo = statePattern(i); }
            await update(item);
        }
    }

    const elapsed = performance.now() - t0;
    if (hist) { hist.disable(); }

    // ── Post-scenario GC + heap snapshot ─────────────────────────────────────
    gc2();
    const memAfter = process.memoryUsage();
    const v8After  = v8.getHeapStatistics();

    const s          = getStats();
    const cacheTotal = s.cacheHits + s.cacheMisses;

    const result = {
        name,
        description,
        timestamp:           new Date().toISOString(),
        poll_interval_ms:    POLL_INTERVAL_MS,
        // Call accounting
        total_calls:         totalCalls,
        check_calls:         mockState.checkCallCount,
        dropped:             s.dropped,
        dropped_pct:         totalCalls > 0 ? +(s.dropped / totalCalls * 100).toFixed(2) : 0,
        // IPC cache
        cache_hits:          s.cacheHits,
        cache_misses:        s.cacheMisses,
        cache_hit_pct:       cacheTotal > 0 ? +(s.cacheHits / cacheTotal * 100).toFixed(2) : 0,
        // Timing
        elapsed_ms:          +elapsed.toFixed(3),
        calls_per_sec:       +(totalCalls / (elapsed / 1000)).toFixed(1),
        us_per_call:         +(elapsed / totalCalls * 1000).toFixed(2),
        // Heap (post-GC delta — the only number that reflects real retained growth)
        heap_before_kb:      Math.round(memBefore.heapUsed / 1024),
        heap_after_kb:       Math.round(memAfter.heapUsed  / 1024),
        heap_delta_kb:       Math.round((memAfter.heapUsed  - memBefore.heapUsed)  / 1024),
        external_delta_kb:   Math.round((memAfter.external  - memBefore.external)  / 1024),
        rss_delta_kb:        Math.round((memAfter.rss        - memBefore.rss)       / 1024),
        // V8 internals
        v8_heap_used_kb:     Math.round(v8After.used_heap_size   / 1024),
        v8_heap_total_kb:    Math.round(v8After.total_heap_size  / 1024),
        v8_heap_limit_kb:    Math.round(v8After.heap_size_limit  / 1024),
        // Context leak signals: detached_contexts > 0 means V8 is holding
        // objects that should have been collected (e.g., a retained closure).
        native_contexts:     v8After.number_of_native_contexts,
        detached_contexts:   v8After.number_of_detached_contexts,
        // Event-loop lag (sequential scenarios only)
        // NaN occurs when no histogram samples were recorded (all ops completed
        // before the 1 ms resolution timer fired). Treat as 0 — no lag detected.
        el_max_lag_ms:       hist ? (Number.isFinite(hist.max)              ? +(hist.max                  / 1e6).toFixed(3) : 0) : null,
        el_mean_lag_ms:      hist ? (Number.isFinite(hist.mean)             ? +(hist.mean                 / 1e6).toFixed(3) : 0) : null,
        el_p99_lag_ms:       hist ? (Number.isFinite(hist.percentile(99))   ? +(hist.percentile(99)       / 1e6).toFixed(3) : 0) : null,
    };

    return result;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────
//
// Design rationale for each scenario:
//
//   stable-state    — measures the IPC cache at its most efficient (every tick
//                     after the first should be a cache hit) and the cost of
//                     checkServiceStatus() on the cgroup.procs fast path.
//
//   state-toggling  — measures cache hit rate when the RAM% oscillates, which
//                     is the realistic case as MemAvailable changes over time.
//
//   all-levels      — exercises all three UI background-colour code paths
//                     (healthy/warning/critical) to expose any per-path alloc.
//
//   pileup-50ms     — simulates the exec() fallback being slow (e.g. systemctl
//                     under light OOM pressure). Guard must block 49/50 calls.
//
//   pileup-200ms    — simulates extreme OOM pressure. Guard must block 199/200.
//                     Also measures how 200 pending Promises affect heap.
//
//   warm-2000       — steady-state baseline: 2000 sequential calls at 0 delay.
//                     Post-GC heap delta reveals any per-call retained objects.
//
const SCENARIOS = [
    {
        name:        'stable-state',
        description: '500 sequential calls, 0 ms, stable pct — 100% cache hit after call 1',
        totalCalls:  500,
        concurrent:  false,
        shDelay:     0,
        statePattern: null,
    },
    {
        name:        'state-toggling',
        description: '1000 sequential calls, 0 ms, pct toggles 66→25 every 50 calls — ~98% cache hit',
        totalCalls:  1000,
        concurrent:  false,
        shDelay:     0,
        statePattern: stateToggle50,
    },
    {
        name:        'all-ui-states',
        description: '600 sequential calls cycling healthy→warning→critical every 100 — ~99% cache hit',
        totalCalls:  600,
        concurrent:  false,
        shDelay:     0,
        statePattern: stateAllLevels,
    },
    {
        name:        'pileup-50ms',
        description: '50 concurrent calls, 50 ms delay (slow exec fallback) — guard must drop 49/50',
        totalCalls:  50,
        concurrent:  true,
        shDelay:     50,
        statePattern: null,
    },
    {
        name:        'pileup-200ms',
        description: '200 concurrent calls, 200 ms delay (extreme OOM pressure) — guard must drop 199/200',
        totalCalls:  200,
        concurrent:  true,
        shDelay:     200,
        statePattern: null,
    },
    {
        name:        'warm-2000',
        description: '2000 sequential calls, 0 ms, stable state — steady-state net heap growth',
        totalCalls:  2000,
        concurrent:  false,
        shDelay:     0,
        statePattern: null,
    },
];

// ── Print one scenario result ──────────────────────────────────────────────────
function printResult(r) {
    const checkFmt = `${r.check_calls}/${r.total_calls}`;
    const dropFmt  = `${r.dropped} (${r.dropped_pct.toFixed(1)}%)`;
    const hitTotal = r.cache_hits + r.cache_misses;
    const cacheFmt = `${r.cache_hits}/${hitTotal} (${r.cache_hit_pct.toFixed(1)}% hits)`;
    const heapSign = r.heap_delta_kb >= 0 ? '+' : '';
    const rssSign  = r.rss_delta_kb  >= 0 ? '+' : '';
    const extSign  = r.external_delta_kb >= 0 ? '+' : '';

    const elLine = r.el_max_lag_ms !== null
        ? `max=${r.el_max_lag_ms.toFixed(2)} ms   mean=${r.el_mean_lag_ms.toFixed(2)} ms   p99=${r.el_p99_lag_ms.toFixed(2)} ms`
        : 'n/a (concurrent — event-loop not blocked by async awaits)';

    log(`\n  ${hr.slice(0, 60)}`);
    log(`  Scenario : ${r.name}`);
    log(`  Desc     : ${r.description}`);
    log(`  ${hr.slice(0, 60)}`);
    log(`  elapsed  : ${r.elapsed_ms.toFixed(1).padStart(10)} ms   calls/sec: ${r.calls_per_sec.toFixed(0).padStart(7)}   µs/call: ${r.us_per_call.toFixed(1)}`);
    log(`  checks   : ${checkFmt.padStart(13)}    dropped: ${dropFmt}`);
    log(`  IPC cache: ${cacheFmt}`);
    log(`  heap Δ   : ${(heapSign + r.heap_delta_kb + ' KB').padStart(10)}  (before: ${r.heap_before_kb} KB → after: ${r.heap_after_kb} KB)`);
    log(`  RSS Δ    : ${(rssSign  + r.rss_delta_kb  + ' KB').padStart(10)}  external Δ: ${extSign + r.external_delta_kb} KB`);
    log(`  V8 heap  : used=${r.v8_heap_used_kb} KB   total=${r.v8_heap_total_kb} KB   limit=${r.v8_heap_limit_kb} KB`);
    log(`  V8 ctx   : native=${r.native_contexts}   detached=${r.detached_contexts}  (detached > 0 = retained-object leak risk)`);
    log(`  EL lag   : ${elLine}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    gc2();
    const rssBaseline  = Math.round(process.memoryUsage().rss      / 1024);
    const heapBaseline = Math.round(process.memoryUsage().heapUsed / 1024);

    log('');
    log(HR);
    log('  mem-watchdog — extension update() stress report');
    log(`  ${new Date().toLocaleString('en-GB', { hour12: false })}`);
    log(`  Node ${process.version}  PID ${process.pid}`);
    log(`  RSS baseline: ${rssBaseline} KB    heap baseline: ${heapBaseline} KB`);
    log(`  GC: ${typeof global.gc === 'function'
        ? 'available (--expose-gc) — heap deltas are post-GC retained growth'
        : '⚠ NOT available — run with: node --expose-gc for accurate heap deltas'}`);
    log(`  poll interval: ${POLL_INTERVAL_MS} ms   (${Math.round(86400000 / POLL_INTERVAL_MS).toLocaleString()} ticks/day)`);
    log(HR);

    const allResults = [];
    for (const cfg of SCENARIOS) {
        const result = await runScenario(cfg);
        allResults.push(result);
        printResult(result);
    }

    // ── Efficiency summary ────────────────────────────────────────────────────
    const stable  = allResults.find(r => r.name === 'stable-state');
    const toggle  = allResults.find(r => r.name === 'state-toggling');
    const p50     = allResults.find(r => r.name === 'pileup-50ms');
    const p200    = allResults.find(r => r.name === 'pileup-200ms');
    const warm    = allResults.find(r => r.name === 'warm-2000');
    const ticksPerDay = Math.round(86400000 / POLL_INTERVAL_MS);

    log('');
    log(HR);
    log('  EFFICIENCY SUMMARY');
    log(hr);

    if (stable) {
        log(`  checkServiceStatus() hot-path: ~${stable.us_per_call.toFixed(1)} µs/call (cgroup.procs, stable state)`);
        const ipcSavingsPerDay = Math.round((stable.cache_hit_pct / 100) * ticksPerDay);
        log(`  IPC calls saved/day (stable):  ${ipcSavingsPerDay.toLocaleString()} of ${ticksPerDay.toLocaleString()} ticks → ${stable.cache_hit_pct.toFixed(1)}% skipped`);
        if (stable.el_max_lag_ms !== null) {
            log(`  Event-loop max blocking:       ${stable.el_max_lag_ms.toFixed(2)} ms  (p99: ${stable.el_p99_lag_ms.toFixed(2)} ms)`);
        }
    }

    if (toggle) {
        log(`  IPC cache (oscillating state): ${toggle.cache_hit_pct.toFixed(1)}% hit rate`);
    }

    if (p50) {
        const guardEff = p50.total_calls > 1
            ? (p50.dropped / (p50.total_calls - 1) * 100).toFixed(1) : 'n/a';
        log(`  Pileup guard (50 ms):  ${guardEff}% of excess calls blocked (${p50.dropped}/${p50.total_calls - 1})`);
    }

    if (p200) {
        const guardEff = p200.total_calls > 1
            ? (p200.dropped / (p200.total_calls - 1) * 100).toFixed(1) : 'n/a';
        log(`  Pileup guard (200 ms): ${guardEff}% of excess calls blocked (${p200.dropped}/${p200.total_calls - 1})`);
    }

    if (warm) {
        const perCall = warm.heap_delta_kb / warm.total_calls;
        log(`  Steady-state heap (${warm.total_calls} calls): ${warm.heap_delta_kb >= 0 ? '+' : ''}${warm.heap_delta_kb} KB net post-GC`);
        log(`  Per-call net retained:         ${perCall >= 0 ? '+' : ''}${perCall.toFixed(3)} KB/call`);
        if (warm.detached_contexts > 0) {
            log(`  ⚠ detached_contexts=${warm.detached_contexts} — V8 is retaining objects that should be collected`);
        }
    }

    // ── Write JSON report ─────────────────────────────────────────────────────
    const report = {
        generated_at:      new Date().toISOString(),
        node_version:      process.version,
        pid:               process.pid,
        poll_interval_ms:  POLL_INTERVAL_MS,
        rss_baseline_kb:   rssBaseline,
        heap_baseline_kb:  heapBaseline,
        gc_available:      typeof global.gc === 'function',
        scenarios:         allResults,
    };

    fs.writeFileSync(JSON_LOG, JSON.stringify(report, null, 2));

    log('');
    log(`  Full JSON report: ${JSON_LOG}`);
    log(HR);
}

main().catch(err => {
    console.error('update-stress.js fatal:', err);
    process.exit(1);
});
