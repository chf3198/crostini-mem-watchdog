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
const path   = require('path');

// ── Step 1: mock 'vscode' ─────────────────────────────────────────────────────
// Must happen before require('../../extension') below.
const { setup: vsSetup } = require('../helpers/mockVscode');
vsSetup();

// ── Step 2: mock './utils' ────────────────────────────────────────────────────
// extension.js destructures: const { readMeminfo, sh } = require('./utils')
// The mock state object is mutated per-test; the mock functions close over it
// so changes are visible to the already-loaded extension.js without re-require.

const utilsAbsPath = path.resolve(__dirname, '../../utils.js');

const mockState = {
    meminfo:     { totalKB: 6440000, availableKB: 4000000, pct: 62 }, // healthy default
    svcStatus:   'active',
    shDelay:     0,      // ms to delay each sh() call (simulates slow systemctl)
    shCallCount: 0,      // incremented by mockSh — read by pileup-guard tests
};

const mockReadMeminfo = () => mockState.meminfo;   // returns null | {totalKB,availableKB,pct}

async function mockSh(/* cmd */) {
    if (mockState.shDelay > 0) {
        await new Promise(r => setTimeout(r, mockState.shDelay));
    }
    mockState.shCallCount++;
    // checkService() calls sh('systemctl --user is-active mem-watchdog')
    // and returns stdout directly.  ok=true means exit 0.
    return {
        ok:     mockState.svcStatus === 'active',
        stdout: mockState.svcStatus,
        stderr: '',
    };
}

require.cache[utilsAbsPath] = {
    id: utilsAbsPath, filename: utilsAbsPath, loaded: true, paths: [],
    exports: { readMeminfo: mockReadMeminfo, sh: mockSh },
};

// ── Step 3: set env var, require extension with _test hook ────────────────────
process.env.MEM_WATCHDOG_TEST = '1';
const ext = require('../../extension');
const { update, POLL_INTERVAL_MS, resetTooltipCache } = ext._test;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Plain object that mimics the StatusBarItem properties update() writes to.
// ThemeColor instances land on .backgroundColor / .color — tests inspect .id.
function makeItem() {
    return { text: '', color: undefined, backgroundColor: undefined, tooltip: undefined };
}

function resetState(overrides = {}) {
    Object.assign(mockState, {
        meminfo:     { totalKB: 6440000, availableKB: 4000000, pct: 62 },
        svcStatus:   'active',
        shDelay:     0,
        shCallCount: 0,
    }, overrides);
}

// ── State machine ─────────────────────────────────────────────────────────────
// Five distinct states, each with a unique combination of icon + background.
// If any branch is wrong the test catches it immediately, before a user reports
// a confusing status bar colour in the wild.

describe('update() — status bar state machine', () => {
    beforeEach(() => resetState());

    test('healthy (pct > 35, service active): green tint, check icon, NO errorBackground', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 4000000, pct: 62 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(check)'),
            `expected $(check) icon in healthy state, got: "${item.text}"`);
        assert.equal(item.backgroundColor, undefined,
            'healthy state must clear backgroundColor (no red or yellow)');
        assert.ok(item.color && item.color.id === 'testing.iconPassed',
            `expected green testing.iconPassed colour, got: ${JSON.stringify(item.color)}`);
    });

    test('warning pressure (20 < pct < 35, active): amber background, warning icon', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 1610000, pct: 25 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(warning)'),
            `expected $(warning) icon at 25% free, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.warningBackground',
            `expected warningBackground at 25% free, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('critical RAM (pct < 20, active): error background, flame icon', async () => {
        resetState({ meminfo: { totalKB: 6440000, availableKB: 900000, pct: 14 } });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(flame)'),
            `expected $(flame) icon at 14% free, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.errorBackground',
            `expected errorBackground at 14% free, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('service inactive: error background, error icon, status string in text', async () => {
        resetState({ svcStatus: 'inactive' });
        const item = makeItem();
        await update(item);
        assert.ok(item.text.includes('$(error)'),
            `expected $(error) icon when service is inactive, got: "${item.text}"`);
        assert.ok(item.text.includes('inactive'),
            `expected 'inactive' status string in text, got: "${item.text}"`);
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.errorBackground',
            `expected errorBackground when service inactive, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });

    test('meminfo null (active): error background, "meminfo err" text — /proc unreadable', async () => {
        resetState({ meminfo: null });
        const item = makeItem();
        await update(item);
        assert.ok(
            item.text.includes('meminfo err') || item.text.includes('$(error)'),
            `expected error text when meminfo null, got: "${item.text}"`
        );
        assert.ok(
            item.backgroundColor && item.backgroundColor.id === 'statusBarItem.errorBackground',
            `expected errorBackground when /proc/meminfo unreadable, got: ${JSON.stringify(item.backgroundColor)}`
        );
    });
});

// ── Pileup guard ──────────────────────────────────────────────────────────────
// This is the OOM-pressure safety test. Under memory pressure, systemctl can
// stall for 500 ms+. Without the _updating guard, a 2 s timer firing 10 times
// would spawn 10 concurrent `systemctl --user is-active` processes, consuming
// another ~5 MB RSS each and potentially cascading the OOM condition.
//
// Critical invariant: for N concurrent update() calls, sh() is called EXACTLY
// ONCE. All other N-1 callers must bail at `if (_updating) return;`.

describe('update() — _updating pileup guard', () => {
    beforeEach(() => resetState());

    test('20 concurrent calls: sh() called exactly 1 time (guard blocks 19)', async () => {
        // 50 ms simulates a slow systemctl under memory pressure.
        // All 20 calls are queued before the event loop can return from the first.
        resetState({ shDelay: 50 });
        const item = makeItem();

        await Promise.all(
            Array.from({ length: 20 }, () => update(item))
        );

        assert.equal(
            mockState.shCallCount, 1,
            `pileup guard failed: sh() was called ${mockState.shCallCount} times for 20 concurrent update() calls (expected 1)`
        );
    });

    test('5 sequential calls (awaited): guard resets — sh() called 5 times', async () => {
        // Verifies the guard self-resets in finally{}.
        // If _updating were never cleared, all calls after the first would drop.
        resetState();
        const item = makeItem();

        for (let i = 0; i < 5; i++) {
            await update(item);
        }

        assert.equal(
            mockState.shCallCount, 5,
            `guard did not reset: sh() called ${mockState.shCallCount} times for 5 sequential calls (expected 5)`
        );
    });
});

// ── Resilience ────────────────────────────────────────────────────────────────

describe('update() — resilience under adverse conditions', () => {
    beforeEach(() => resetState());

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
    beforeEach(() => { resetState(); resetTooltipCache(); });

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
