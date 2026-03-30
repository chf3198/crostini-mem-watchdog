// test/unit/configWriter.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for configWriter.js — writeConfig() validation logic and output.
//
// configWriter.js has NO 'vscode' dependency — it only uses fs, path, and os.
// The cfg parameter is just an object with a get() method; we pass a plain
// mock object. fs.writeFileSync and fs.mkdirSync are patched per-test so no
// actual files are written to disk.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { writeConfig, CONFIG_FILE } = require('../../configWriter');

// ── cfg factory ───────────────────────────────────────────────────────────────
// All defaults are the shipped values. Tests override only the fields they care about.
const DEFAULTS = {
    sigtermThresholdPct:   25,
    sigkillThresholdPct:   15,
    psiThresholdPct:       25,
};

function makeCfg(overrides = {}) {
    const vals = { ...DEFAULTS, ...overrides };
    return { get: (key) => vals[key] };
}

// ── Content capture helper ────────────────────────────────────────────────────
// Each test sets this up via t.mock.method to capture what writeFileSync receives.
// Also mocks readFileSync to simulate a missing config file (so changed=true and
// writeFileSync is always invoked).  Tests that need to verify the `changed` flag
// with an existing file should mock readFileSync explicitly after calling this.
function captureWrite(t) {
    let captured = '';
    t.mock.method(fs, 'mkdirSync', () => {});
    t.mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT: simulated missing file'); });
    t.mock.method(fs, 'writeFileSync', (_path, content) => { captured = content; });
    return { get: () => captured };
}

// ── Validation: sigkill / sigterm hierarchy ───────────────────────────────────

describe('writeConfig — kill-threshold cross-field validation', () => {
    test('valid thresholds: no warnings, correct values written', (t) => {
        const out = captureWrite(t);
        const { warnings } = writeConfig(makeCfg());

        assert.equal(warnings.length, 0, 'no warnings for valid defaults');
        const content = out.get();
        assert.ok(content.includes('SIGTERM_THRESHOLD=25'), 'sigterm default written');
        assert.ok(content.includes('SIGKILL_THRESHOLD=15'), 'sigkill default written');
    });

    test('sigkillPct > sigtermPct: both reverted to defaults + 1 warning', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg({ sigkillThresholdPct: 30, sigtermThresholdPct: 20 }));

        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('sigkillThresholdPct'), 'warning names the bad field');
        assert.ok(warnings[0].includes('Reverting'), 'warning mentions revert');
    });

    test('sigkillPct > sigtermPct: written values are safe defaults (25/15)', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg({ sigkillThresholdPct: 30, sigtermThresholdPct: 20 }));

        const content = out.get();
        assert.ok(content.includes('SIGTERM_THRESHOLD=25'), 'reverted to default sigterm=25');
        assert.ok(content.includes('SIGKILL_THRESHOLD=15'), 'reverted to default sigkill=15');
    });

    test('sigkillPct === sigtermPct (equal = invalid): reverted + warning', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg({ sigkillThresholdPct: 20, sigtermThresholdPct: 20 }));
        assert.equal(warnings.length, 1);
    });
});







// ── File format ───────────────────────────────────────────────────────────────

describe('writeConfig — output file format', () => {
    test('output contains auto-generated header comment', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg());
        assert.ok(out.get().includes('Auto-generated'), 'header comment present');
    });

    test('output ends with newline', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg());
        assert.ok(out.get().endsWith('\n'), 'file must end with newline');
    });

    test('output contains all 3 expected variables', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg());
        const content = out.get();
        for (const v of ['SIGTERM_THRESHOLD', 'SIGKILL_THRESHOLD', 'PSI_THRESHOLD']) {
            assert.ok(content.includes(v), `missing variable: ${v}`);
        }
    });

    test('writeConfig returns { warnings, changed } for valid input', (t) => {
        captureWrite(t);
        const result = writeConfig(makeCfg());
        assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
        assert.equal(result.warnings.length, 0);
        assert.equal(typeof result.changed, 'boolean', 'changed must be a boolean');
        assert.equal(result.changed, true, 'changed=true when file is missing');
    });

    test('changed=false when existing config matches new content', (t) => {
        // Build the expected content string from defaults.
        const expected =
            '# Auto-generated by Mem Watchdog VS Code extension.\n' +
            '# Do not edit manually — changes will be overwritten on next VS Code startup.\n' +
            '# To adjust thresholds, use VS Code Settings > Mem Watchdog.\n' +
            'SIGTERM_THRESHOLD=25\n' +
            'SIGKILL_THRESHOLD=15\n' +
            'PSI_THRESHOLD=25\n';

        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'readFileSync', () => expected);
        t.mock.method(fs, 'writeFileSync', () => { throw new Error('should not be called'); });

        const result = writeConfig(makeCfg());
        assert.equal(result.changed, false, 'changed=false when content identical');
        assert.equal(result.warnings.length, 0);
    });

    test('changed=true when existing config differs from new content', (t) => {
        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'readFileSync', () => 'SIGTERM_THRESHOLD=99\n');
        let written = false;
        t.mock.method(fs, 'writeFileSync', () => { written = true; });

        const result = writeConfig(makeCfg());
        assert.equal(result.changed, true, 'changed=true when content differs');
        assert.ok(written, 'writeFileSync was called');
    });
});
