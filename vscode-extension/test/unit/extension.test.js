// test/unit/extension.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Stress tests for extension.js internal update() logic.
//
// Two groups of tests:
//
// 1. STATE MACHINE — verifies that the status bar item gets the correct
//    text/icon and background colour for each of the five distinct states:
//    healthy / warning-pressure / critical-RAM / service-down / meminfo-null
//
// 2. PILEUP GUARD (_updating flag) — the most operationally critical test.
//    Under OOM pressure, systemctl calls can take seconds. Without the guard
//    a 2-second timer would stack up dozens of concurrent shell invocations,
//    each consuming another ~2 MB of VSCode RSS. The guard must:
//      a) Allow only ONE concurrent update() — confirmed by counting sh() calls
//      b) Self-reset in finally{} — sequential calls must all run independently
//
// MOCKING STRATEGY (identical to commands.test.js):
//   'vscode'  → mockVscode helper (Module._resolveFilename patch)
//   './utils' → require.cache injection with mutable mockState
//   'process.env.MEM_WATCHDOG_TEST=1' → exposes update() via module._test
//
// NOTE: node:test runs each file as a separate child process, so extension.js
// is freshly loaded here with _updating=false and the clean mock state below.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const path   = require('path');

// ── Step 1: mock 'vscode' ─────────────────────────────────────────────────────
// Must happen before require('../../extension') below.
const { setup: vsSetup, mockWindow } = require('../helpers/mockVscode');
vsSetup();

// ── Step 2: mock './utils' ────────────────────────────────────────────────────
// extension.js destructures: const { readMeminfo, sh } = require('./utils')
// The mock state object is mutated per-test; the mock functions close over it
// so changes are visible to the already-loaded extension.js without re-require.

const utilsAbsPath = path.resolve(__dirname, '../../utils.js');

const mockState = {
    meminfo:     { totalKB: 6440000, availableKB: 4000000, pct: 62 }, // healthy default
    svcStatus:   'active',
    shDelay:     0,      // ms to delay each sh() / checkServiceStatus() call
    shCallCount: 0,      // incremented by mockSh (fallback exec path)
    checkCallCount: 0,   // incremented by mockCheckServiceStatus (cgroup.procs hot path)
    killRequest:  null,
    killDecision: null,
};

const mockReadMeminfo = () => mockState.meminfo;   // returns null | {totalKB,availableKB,pct}

async function mockSh(/* cmd */) {
    if (mockState.shDelay > 0) {
        await new Promise(r => setTimeout(r, mockState.shDelay));
    }
    mockState.shCallCount++;
    return {
        ok:     mockState.svcStatus === 'active',
        stdout: mockState.svcStatus,
        stderr: '',
    };
}

// checkServiceStatus() replaces checkService() + exec on the hot path.
// The mock mirrors shDelay so pileup-guard tests can still simulate slow checks.
async function mockCheckServiceStatus() {
    if (mockState.shDelay > 0) {
        await new Promise(r => setTimeout(r, mockState.shDelay));
    }
    mockState.checkCallCount++;
    return mockState.svcStatus;
}

function mockReadKillApprovalRequest() {
    return mockState.killRequest;
}

function mockWriteKillApprovalDecision(id, decision, deferSeconds) {
    mockState.killDecision = { id, decision, deferSeconds };
}

require.cache[utilsAbsPath] = {
    id: utilsAbsPath, filename: utilsAbsPath, loaded: true, paths: [],
    exports: {
        readMeminfo: mockReadMeminfo,
        sh: mockSh,
        checkServiceStatus: mockCheckServiceStatus,
        readKillApprovalRequest: mockReadKillApprovalRequest,
        writeKillApprovalDecision: mockWriteKillApprovalDecision,
        readWatchdogMode: () => '',
        readRssThresholds: () => ({ warnKB: 3400000, emergKB: 3800000 }),
        determineState: ({ serviceStatus, mode, vscodeRssKB, warnKB, emergKB }) => {
            if (serviceStatus !== 'active') { return 'OFF'; }
            if (mode === 'SLEEP') { return 'SLEEPING'; }
            if (vscodeRssKB >= emergKB) { return 'ATTACKING'; }
            if (vscodeRssKB >= warnKB) { return 'RECOVERING'; }
            if (vscodeRssKB >= Math.floor(warnKB * 0.8)) { return 'ALERT'; }
            return 'GUARDING';
        },
        stateDescription: (state) => state,
    },
};

// ── Step 3: set env var, require extension with _test hook ────────────────────
process.env.MEM_WATCHDOG_TEST = '1';
const ext = require('../../extension');
const { update, POLL_INTERVAL_MS, resetStateCache, resetStats, getStats } = ext._test;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Plain object that mimics the StatusBarItem properties update() writes to.
// ThemeColor instances land on .backgroundColor / .color — tests inspect .id.
function makeItem() {
    return { text: '', color: undefined, backgroundColor: undefined, tooltip: undefined };
}

function resetState(overrides = {}) {
    Object.assign(mockState, {
        meminfo:        { totalKB: 6440000, availableKB: 4000000, pct: 62 },
        svcStatus:      'active',
        shDelay:        0,
        shCallCount:    0,
        checkCallCount: 0,
        killRequest:    null,
        killDecision:   null,
    }, overrides);
    mockWindow.reset();
}

// ── State machine ─────────────────────────────────────────────────────────────
// Five distinct states, each with a unique combination of icon + background.
// If any branch is wrong the test catches it immediately, before a user reports
// a confusing status bar colour in the wild.

describe('update() — status bar state machine', () => {
    beforeEach(() => { resetState(); resetStateCache(); });

    test('healthy: GUARDING with green tint and shield icon', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 4000000, pct: 62 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('GUARDING') && item.text.includes('$(shield)'),
            `expected GUARDING shield state, got: "${item.text}"`);
        assert.equal(item.backgroundColor, undefined,
            'healthy state must clear backgroundColor (no red or yellow)');
        assert.ok(item.color && item.color.id === 'testing.iconPassed',
            `expected green testing.iconPassed colour, got: ${JSON.stringify(item.color)}`);
    });

    test('alert pressure: ALERT with warning background', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 3640000, pct: 56 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(warning)') && item.text.includes('ALERT'),
            `expected ALERT warning state, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.warningBackground',
            `expected warningBackground at alert state, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('critical pressure: ATTACKING with error background', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 200000, pct: 3 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(flame)') && item.text.includes('ATTACKING'),
            `expected ATTACKING flame state, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.errorBackground',
            `expected errorBackground at attacking state, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('service inactive: OFF with error background', async () => {
        resetState({ svcStatus: 'inactive' });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(error)') && item.text.includes('OFF'),
            `expected OFF error state when service is inactive, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.errorBackground',
            `expected errorBackground when service inactive, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('meminfo null (active): still renders a safe state text', async () => {
        resetState({ meminfo: null });
        const item = makeItem();
        await update(item);
        assert.ok(
            item.text.length > 0,
            `expected state text when meminfo null, got: "${item.text}"`
        );
    });
});

// ── Pileup guard ──────────────────────────────────────────────────────────────
// This is the OOM-pressure safety test. Under memory pressure, the service
// check (checkServiceStatus) can stall for 500 ms+ in the exec() fallback.
// Without the _updating guard, a 2 s timer would stack up dozens of concurrent
// service checks, each consuming extra RSS.
//
// Critical invariant: for N concurrent update() calls, checkServiceStatus() is
// called EXACTLY ONCE. All other N-1 callers must bail at `if (_updating) return;`.

describe('update() — _updating pileup guard', () => {
    beforeEach(() => { resetState(); resetStateCache(); resetStats(); });

    test('20 concurrent calls: checkServiceStatus() called exactly 1 time (guard blocks 19)', async () => {
        // 50 ms simulates a slow service check (e.g., exec() fallback under pressure).
        // All 20 calls are queued before the event loop can return from the first.
        resetState({ shDelay: 50 });
        const item = makeItem();

        const memBefore  = process.memoryUsage();
        const t0         = performance.now();

        await Promise.all(
            Array.from({ length: 20 }, () => update(item))
        );

        const elapsed_ms = performance.now() - t0;
        const memAfter   = process.memoryUsage();
        const s          = getStats();

        // Logged with [stress:] prefix for easy grep/post-analysis
        console.log(
            `  [stress:pileup-20] elapsed=${elapsed_ms.toFixed(1)}ms` +
            ` | check=${mockState.checkCallCount}/20 dropped=${s.dropped}` +
            ` | cache miss=${s.cacheMisses} hit=${s.cacheHits}` +
            ` | heap Δ=${((memAfter.heapUsed - memBefore.heapUsed) / 1024).toFixed(0)}KB` +
            ` | rss Δ=${((memAfter.rss - memBefore.rss) / 1024).toFixed(0)}KB`
        );

        assert.equal(
            mockState.checkCallCount, 1,
            `pileup guard failed: checkServiceStatus() was called ${mockState.checkCallCount} times for 20 concurrent update() calls (expected 1)`
        );
        // Verify exactly 19 calls were silently dropped — confirming the guard
        // fires and does not allow duplicate work under concurrent timer callbacks.
        assert.equal(
            s.dropped, 19,
            `pileup guard dropped ${s.dropped} calls for 20 concurrent invocations — expected exactly 19 blocked`
        );
    });

    test('5 sequential calls (awaited): guard resets — checkServiceStatus() called 5 times', async () => {
        // Verifies the guard self-resets in finally{}.
        // If _updating were never cleared, all calls after the first would drop.
        resetState();
        const item = makeItem();

        const memBefore  = process.memoryUsage();
        const t0         = performance.now();

        for (let i = 0; i < 5; i++) {
            await update(item);
        }

        const elapsed_ms = performance.now() - t0;
        const memAfter   = process.memoryUsage();
        const s          = getStats();

        console.log(
            `  [stress:sequential-5] elapsed=${elapsed_ms.toFixed(1)}ms` +
            ` | check=${mockState.checkCallCount}/5 dropped=${s.dropped}` +
            ` | cache miss=${s.cacheMisses} hit=${s.cacheHits}` +
            ` | heap Δ=${((memAfter.heapUsed - memBefore.heapUsed) / 1024).toFixed(0)}KB`
        );

        assert.equal(
            mockState.checkCallCount, 5,
            `guard did not reset: checkServiceStatus() called ${mockState.checkCallCount} times for 5 sequential calls (expected 5)`
        );
        // Verify zero dropped — sequential calls must never hit the guard
        // (each call fully resolves before the next starts).
        assert.equal(
            s.dropped, 0,
            `sequential calls must not be dropped; got ${s.dropped} dropped (guard did not reset after each call?)`
        );
    });
});

// ── Resilience ────────────────────────────────────────────────────────────────

describe('update() — resilience under adverse conditions', () => {
    beforeEach(() => { resetState(); resetStateCache(); });

    test('does not throw when readMeminfo() returns null — /proc/meminfo ENOENT', async () => {
        resetState({ meminfo: null });
        const item = makeItem();
        await assert.doesNotReject(
            update(item),
            'update() must not throw when /proc/meminfo is unreadable'
        );
    });

    test('POLL_INTERVAL_MS === 2000 — must match daemon INTERVAL=2 in mem-watchdog.sh', () => {
        // If someone changes the daemon interval without updating the extension
        // (or vice versa), the status bar refresh rate and the tooltip text
        // ("Polls every 2 s") diverge from reality.
        assert.equal(POLL_INTERVAL_MS, 2000,
            'JS poll interval must match daemon INTERVAL=2; update both together');
    });
});

// ── Tooltip cache ─────────────────────────────────────────────────────────────
// Assigning item.tooltip every 2 s triggers an IPC round-trip to the renderer
// even when the content is unchanged (VS Code does not diff MarkdownString
// objects). The _lastTooltipKey cache prevents this when pct and svcStatus
// are stable, which is the common case on a healthy system.

describe('update() — tooltip IPC cache', () => {
    beforeEach(() => { resetState(); resetStateCache(); });

    test('cache-hit: tooltip object is NOT replaced on second call with same values', async () => {
        const item = makeItem();
        await update(item);
        const firstTooltip = item.tooltip;
        assert.ok(firstTooltip, 'first call must set tooltip');
        await update(item);
        assert.strictEqual(item.tooltip, firstTooltip,
            'tooltip must not be recreated when svcStatus and pct are unchanged (IPC cache)');
    });

    test('cache-miss: tooltip IS replaced when pct changes by ≥ 1%', async () => {
        const item = makeItem();
        await update(item);                               // pct = 62 → key set
        const firstTooltip = item.tooltip;
        resetState({ meminfo: { totalKB: 6440000, availableKB: 2000000, pct: 31 } });
        await update(item);                               // pct = 31 → different key
        assert.notStrictEqual(item.tooltip, firstTooltip,
            'tooltip must be recreated when pct crosses a 1%-rounding boundary');
    });
});

describe('update() — interactive kill approval prompt', () => {
    beforeEach(() => { resetState(); resetStateCache(); });

    test('writes allow decision when operator selects allow item', async () => {
        resetState({
            killRequest: {
                id: 'req-1',
                ts: 123,
                signal: 'TERM',
                mode: 'normal',
                reason: 'RSS warn path',
                pct: 24,
                mem_available_kb: 1600000,
                psi_full_x100: 345,
                vscode_rss_kb: 3600000,
            },
        });
        mockWindow._quickPickChoices.push('allow');

        const item = makeItem();
        await update(item);

        assert.ok(mockWindow._lastQuickPick, 'createQuickPick() should have been called');
        assert.ok(
            mockWindow._lastQuickPick.title.includes('Mem Watchdog'),
            `QuickPick title should include 'Mem Watchdog', got: "${mockWindow._lastQuickPick.title}"`
        );
        assert.ok(
            mockWindow._lastQuickPick.items.length >= 3,
            `QuickPick should have at least 3 items, got: ${mockWindow._lastQuickPick.items.length}`
        );
        // Allow item should carry the human-readable reason in its description
        const allowItem = mockWindow._lastQuickPick.items.find((i) => i.value === 'allow');
        assert.ok(allowItem, 'allow item must exist');
        assert.ok(allowItem.detail && allowItem.detail.length > 0, 'allow item must have a detail (tooltip equivalent)');
        assert.deepEqual(mockState.killDecision, { id: 'req-1', decision: 'allow', deferSeconds: undefined });
    });

    test('writes defer decision when operator selects defer item', async () => {
        resetState({
            killRequest: {
                id: 'req-2',
                ts: 124,
                signal: 'TERM',
                mode: 'normal',
                reason: 'Stage 3 reclaim',
            },
        });
        mockWindow._quickPickChoices.push('defer');

        const item = makeItem();
        await update(item);

        const deferItem = mockWindow._lastQuickPick.items.find((i) => i.value === 'defer');
        assert.ok(deferItem, 'defer item must exist');
        assert.ok(deferItem.detail && deferItem.detail.length > 0, 'defer item must have a detail (tooltip equivalent)');
        assert.deepEqual(mockState.killDecision, { id: 'req-2', decision: 'defer', deferSeconds: 120 });
    });

    test('defaults to allow when dismissed (Escape / no choice)', async () => {
        resetState({
            killRequest: {
                id: 'req-3',
                ts: 125,
                signal: 'TERM',
                mode: 'normal',
                reason: '',
            },
        });
        // Nothing pushed to _quickPickChoices → simulates Escape/dismiss
        const item = makeItem();
        await update(item);

        assert.ok(mockWindow._lastQuickPick, 'createQuickPick() should have been called even on dismiss');
        assert.deepEqual(mockState.killDecision, { id: 'req-3', decision: 'allow', deferSeconds: undefined },
            'dismiss must default to allow to preserve the safety posture');
    });

    test('shows explanation message and allows when help item is selected', async () => {
        resetState({
            killRequest: {
                id: 'req-4',
                ts: 126,
                signal: 'TERM',
                mode: 'normal',
                reason: 'ACCEL rss_delta=412MB',
            },
        });
        mockWindow._quickPickChoices.push('help');

        const item = makeItem();
        await update(item);

        assert.ok(mockWindow._infoMessages.length >= 1,
            'help choice must show an informationMessage explanation');
        assert.ok(mockWindow._infoMessages[0].length > 40,
            'explanation message should be substantive, not empty');
        // After help, decision should default to allow so the daemon is unblocked
        assert.deepEqual(mockState.killDecision, { id: 'req-4', decision: 'allow', deferSeconds: undefined },
            'help choice must fall through to allow to unblock the daemon');
    });
});
