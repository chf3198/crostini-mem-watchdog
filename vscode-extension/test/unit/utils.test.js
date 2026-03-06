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
const { readMeminfo, readPsi, sh } = require('../../utils');

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
