// test/unit/utils.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for utils.js — readMeminfo(), readPsi(), sh().
//
// utils.js has no 'vscode' dependency, so no module mock is needed.
// fs.readFileSync is patched per-test via t.mock.method() which auto-restores
// after each test. Both this file and utils.js hold a reference to the same
// 'fs' module instance, so the patch IS visible to readMeminfo/readPsi.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// utils.js has no vscode dep — require directly
const {
    readMeminfo,
    readPsi,
    sh,
    readWatchdogMode,
    readRssThresholds,
    readKillApprovalRequest,
    writeKillApprovalDecision,
    determineState,
    stateDescription,
} = require('../../utils');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Realistic /proc/meminfo on a 6.3 GB Crostini system
const MEMINFO_NORMAL = [
    'MemTotal:        6440000 kB',
    'MemFree:          800000 kB',
    'MemAvailable:    1610000 kB',   // 1610000 / 6440000 ≈ 25.0%
    'Buffers:          100000 kB',
    'Cached:           500000 kB',
    'SwapCached:            0 kB',
    'SwapTotal:             0 kB',
    'SwapFree:              0 kB',
].join('\n');

// Crostini SwapFree uint64 overflow sentinel — earlyoom fatal crash source
// JavaScript silently converts this to 1.8446744073709552e+19 (float)
const MEMINFO_OVERFLOW = [
    'MemTotal:        6440000 kB',
    'MemFree:          800000 kB',
    'MemAvailable:    1610000 kB',
    'SwapCached:            0 kB',
    'SwapTotal:             0 kB',
    'SwapFree:  18446744073709551360 kB',
].join('\n');

const MEMINFO_MINIMAL = [
    'MemTotal:        4000000 kB',
    'MemAvailable:    1000000 kB',   // exactly 25%
].join('\n');

const MEMINFO_ZERO_TOTAL = [
    'MemTotal:              0 kB',
    'MemAvailable:          0 kB',
].join('\n');

// Realistic /proc/pressure/memory on an active system
const PSI_NORMAL = [
    'some avg10=0.05 avg60=0.02 avg300=0.01 total=12345',
    'full avg10=3.45 avg60=1.20 avg300=0.50 total=67890',
].join('\n');

const PSI_NO_FULL_LINE  = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0';
const PSI_ZERO_PRESSURE = 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0';
const PSI_HIGH_PRESSURE = 'full avg10=26.78 avg60=10.00 avg300=5.00 total=9999999';

// ── readMeminfo ───────────────────────────────────────────────────────────────

describe('readMeminfo', () => {
    test('normal: correct totalKB, availableKB, pct', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/meminfo') { return MEMINFO_NORMAL; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        const r = readMeminfo();
        assert.ok(r !== null, 'should not return null');
        assert.equal(r.totalKB,     6440000);
        assert.equal(r.availableKB, 1610000);
        // pct ≈ 25.0% — allow ±0.1 for floating-point
        assert.ok(r.pct > 24.9 && r.pct < 25.1, `pct should be ~25, got ${r.pct}`);
    });

    test('SwapFree overflow: pct not corrupted (critical Crostini safety check)', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/meminfo') { return MEMINFO_OVERFLOW; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        const r = readMeminfo();
        assert.ok(r !== null, 'should not return null');
        // If SwapFree were used, pct would be a massive negative or overflow value
        assert.ok(r.pct > 0   && r.pct < 100, `pct should be 0-100, got ${r.pct}`);
        assert.equal(r.totalKB,     6440000,   'totalKB must use MemTotal only');
        assert.equal(r.availableKB, 1610000,   'availableKB must use MemAvailable only');
    });

    test('pct computed as availableKB / totalKB × 100', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/meminfo') { return MEMINFO_MINIMAL; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        const r = readMeminfo();
        assert.equal(r.totalKB,     4000000);
        assert.equal(r.availableKB, 1000000);
        assert.ok(Math.abs(r.pct - 25) < 0.001, `expected exactly 25, got ${r.pct}`);
    });

    test('returns null on read error (ENOENT)', (t) => {
        t.mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT'); });
        assert.equal(readMeminfo(), null);
    });

    test('MemTotal=0: pct is 0, not NaN or Infinity', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/meminfo') { return MEMINFO_ZERO_TOTAL; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        const r = readMeminfo();
        assert.ok(r !== null);
        assert.equal(r.pct, 0);
        assert.ok(Number.isFinite(r.pct), 'pct must be finite');
    });
});

// ── readPsi ───────────────────────────────────────────────────────────────────

describe('readPsi', () => {
    test('avg10=3.45 → 345 (scaled ×100 for integer arithmetic)', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/pressure/memory') { return PSI_NORMAL; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        assert.equal(readPsi(), 345);
    });

    test('avg10=0.00 → 0', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/pressure/memory') { return PSI_ZERO_PRESSURE; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        assert.equal(readPsi(), 0);
    });

    test('high pressure: avg10=26.78 → 2678', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/pressure/memory') { return PSI_HIGH_PRESSURE; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        assert.equal(readPsi(), 2678);
    });

    test('returns 0 when no "full" line present', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/proc/pressure/memory') { return PSI_NO_FULL_LINE; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        assert.equal(readPsi(), 0);
    });

    test('returns 0 on read error', (t) => {
        t.mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT'); });
        assert.equal(readPsi(), 0);
    });
});

// ── sh ────────────────────────────────────────────────────────────────────────
// Tests use real child_process (no mock needed) — fast commands only.

describe('sh', () => {
    test('ok=true and stdout populated on success', async () => {
        const r = await sh('echo hello');
        assert.equal(r.ok, true);
        assert.equal(r.stdout, 'hello');
    });

    test('stdout is trimmed', async () => {
        const r = await sh('printf "  trimmed  "');
        assert.equal(r.stdout, 'trimmed');
    });

    test('ok=false on non-zero exit (false builtin)', async () => {
        const r = await sh('false');
        assert.equal(r.ok, false);
    });

    test('never rejects — resolves with ok=false on command-not-found', async () => {
        // Must not throw; must resolve
        const r = await sh('_no_such_command_xyz_12345_');
        assert.equal(r.ok, false);
        assert.equal(typeof r.stderr, 'string');
    });

    test('stderr is captured and trimmed', async () => {
        const r = await sh('echo errout >&2; false');
        assert.equal(r.ok, false);
        assert.equal(r.stderr, 'errout');
    });

    test('ok=true with empty stdout for silent command', async () => {
        const r = await sh('true');
        assert.equal(r.ok, true);
        assert.equal(r.stdout, '');
    });
});

describe('readWatchdogMode', () => {
    test('returns SLEEP when mode file contains SLEEP', (t) => {
        let now = 10_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p.endsWith('/.config/mem-watchdog/mode')) { return 'SLEEP\n'; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        assert.equal(readWatchdogMode(), 'SLEEP');
    });

    test('uses 1s cache window', (t) => {
        let now = 20_000;
        let reads = 0;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p.endsWith('/.config/mem-watchdog/mode')) { reads++; return 'SLEEP\n'; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });

        assert.equal(readWatchdogMode(), 'SLEEP');
        now += 500;
        assert.equal(readWatchdogMode(), 'SLEEP');
        assert.equal(reads, 1, 'second call inside cache window should not re-read file');
    });
});

describe('readRssThresholds', () => {
    test('parses warn/emerg from config when present', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p.endsWith('/.config/mem-watchdog/config.sh')) {
                return 'VSCODE_RSS_WARN_KB=3500000\nVSCODE_RSS_EMERG_KB=4100000\n';
            }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        const r = readRssThresholds();
        assert.equal(r.warnKB, 3500000);
        assert.equal(r.emergKB, 4100000);
    });

    test('falls back to defaults when config unreadable', (t) => {
        t.mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT'); });
        const r = readRssThresholds();
        assert.equal(r.warnKB, 3400000);
        assert.equal(r.emergKB, 3800000);
    });
});

describe('kill approval handshake helpers', () => {
    test('readKillApprovalRequest parses key/value request file', (t) => {
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p.endsWith('/.config/mem-watchdog/kill-approval-request')) {
                return [
                    'id=req-123',
                    'ts=1710000000',
                    'signal=TERM',
                    'mode=normal',
                    'reason=RSS warn path',
                    'pct=23',
                    'mem_available_kb=1500000',
                    'psi_full_x100=345',
                    'vscode_rss_kb=3600000',
                ].join('\n') + '\n';
            }
            throw new Error(`unexpected readFileSync: ${p}`);
        });

        const req = readKillApprovalRequest();
        assert.ok(req);
        assert.equal(req.id, 'req-123');
        assert.equal(req.signal, 'TERM');
        assert.equal(req.mode, 'normal');
        assert.equal(req.pct, 23);
        assert.equal(req.vscode_rss_kb, 3600000);
    });

    test('writeKillApprovalDecision writes allow decision', (t) => {
        let content = '';
        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'writeFileSync', (_p, c) => { content = c; });
        writeKillApprovalDecision('req-allow', 'allow');
        assert.ok(content.includes('id=req-allow'));
        assert.ok(content.includes('decision=allow'));
    });

    test('writeKillApprovalDecision writes defer seconds for defer decision', (t) => {
        let content = '';
        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'writeFileSync', (_p, c) => { content = c; });
        writeKillApprovalDecision('req-defer', 'defer', 120);
        assert.ok(content.includes('decision=defer'));
        assert.ok(content.includes('defer_seconds=120'));
    });
});

describe('determineState + stateDescription', () => {
    test('OFF when service not active', () => {
        assert.equal(determineState({ serviceStatus: 'inactive' }), 'OFF');
    });

    test('SLEEPING when mode is SLEEP', () => {
        assert.equal(determineState({ serviceStatus: 'active', mode: 'SLEEP' }), 'SLEEPING');
    });

    test('ATTACKING when rss exceeds emerg threshold', () => {
        assert.equal(determineState({ serviceStatus: 'active', vscodeRssKB: 3900000, emergKB: 3800000 }), 'ATTACKING');
    });

    test('RECOVERING when rss exceeds warn threshold', () => {
        assert.equal(determineState({ serviceStatus: 'active', vscodeRssKB: 3450000, warnKB: 3400000, emergKB: 3800000 }), 'RECOVERING');
    });

    test('ALERT near warn threshold', () => {
        assert.equal(determineState({ serviceStatus: 'active', vscodeRssKB: 2800000, warnKB: 3400000, emergKB: 3800000 }), 'ALERT');
    });

    test('GUARDING below alert threshold', () => {
        assert.equal(determineState({ serviceStatus: 'active', vscodeRssKB: 1500000, warnKB: 3400000, emergKB: 3800000 }), 'GUARDING');
    });

    test('description exists for each state', () => {
        const states = ['OFF', 'SLEEPING', 'ATTACKING', 'RECOVERING', 'ALERT', 'GUARDING'];
        for (const state of states) {
            const msg = stateDescription(state);
            assert.equal(typeof msg, 'string');
            assert.ok(msg.length > 0);
        }
    });
});
