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
    vscodeRssWarnMB:     3400,
    vscodeRssEmergencyMB: 3800,
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

// ── Validation: RSS MB hierarchy ─────────────────────────────────────────────

describe('writeConfig — RSS threshold cross-field validation', () => {
    test('valid RSS thresholds: no warnings', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg());
        assert.equal(warnings.length, 0);
    });

    test('warnMB > emergMB: both reverted to defaults + 1 warning', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg({ vscodeRssWarnMB: 4000, vscodeRssEmergencyMB: 3000 }));
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('vscodeRssWarnMB'), 'warning names the bad field');
    });

    test('warnMB === emergMB (equal = invalid): reverted + warning', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg({ vscodeRssWarnMB: 3500, vscodeRssEmergencyMB: 3500 }));
        assert.equal(warnings.length, 1);
    });

    test('warnMB > emergMB: written values are safe defaults (3400/3800 MB → KB)', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg({ vscodeRssWarnMB: 4000, vscodeRssEmergencyMB: 3000 }));

        const content = out.get();
        assert.ok(content.includes(`VSCODE_RSS_WARN_KB=${3400 * 1024}`),  'warn reverted to 3400 MB');
        assert.ok(content.includes(`VSCODE_RSS_EMERG_KB=${3800 * 1024}`), 'emerg reverted to 3800 MB');
    });
});

// ── Both validations fire ─────────────────────────────────────────────────────

describe('writeConfig — both cross-field checks invalid simultaneously', () => {
    test('two independent violations → two warnings in array', (t) => {
        captureWrite(t);
        const { warnings } = writeConfig(makeCfg({
            sigkillThresholdPct:  30, sigtermThresholdPct:  20,  // inverted
            vscodeRssWarnMB:    4000, vscodeRssEmergencyMB: 3000, // inverted
        }));
        assert.equal(warnings.length, 2, `expected 2 warnings, got ${warnings.length}`);
    });
});

// ── MB → KB conversion ────────────────────────────────────────────────────────

describe('writeConfig — MB to KB conversion', () => {
    test('warnMB × 1024 = written VSCODE_RSS_WARN_KB', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg({ vscodeRssWarnMB: 2500, vscodeRssEmergencyMB: 3500 }));

        const content = out.get();
        assert.ok(content.includes(`VSCODE_RSS_WARN_KB=${2500 * 1024}`));
    });

    test('emergMB × 1024 = written VSCODE_RSS_EMERG_KB', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg({ vscodeRssWarnMB: 2500, vscodeRssEmergencyMB: 3500 }));

        const content = out.get();
        assert.ok(content.includes(`VSCODE_RSS_EMERG_KB=${3500 * 1024}`));
    });

    test('custom valid values are written correctly', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg({
            vscodeRssWarnMB:    2000,
            vscodeRssEmergencyMB: 3000,
            sigtermThresholdPct: 30,
            sigkillThresholdPct: 20,
        }));

        const content = out.get();
        assert.ok(content.includes('SIGTERM_THRESHOLD=30'));
        assert.ok(content.includes('SIGKILL_THRESHOLD=20'));
        assert.ok(content.includes(`VSCODE_RSS_WARN_KB=${2000 * 1024}`));
        assert.ok(content.includes(`VSCODE_RSS_EMERG_KB=${3000 * 1024}`));
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

    test('output contains all 5 expected variables', (t) => {
        const out = captureWrite(t);
        writeConfig(makeCfg());
        const content = out.get();
        for (const v of ['SIGTERM_THRESHOLD', 'SIGKILL_THRESHOLD', 'PSI_THRESHOLD',
                         'VSCODE_RSS_WARN_KB', 'VSCODE_RSS_EMERG_KB']) {
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
        const warnKB  = 3400 * 1024;
        const emergKB = 3800 * 1024;
        const expected =
            '# Auto-generated by Mem Watchdog VS Code extension.\n' +
            '# Do not edit manually — changes will be overwritten on next VS Code startup.\n' +
            '# To adjust thresholds, use VS Code Settings > Mem Watchdog.\n' +
            'SIGTERM_THRESHOLD=25\n' +
            'SIGKILL_THRESHOLD=15\n' +
            'PSI_THRESHOLD=25\n' +
            `VSCODE_RSS_WARN_KB=${warnKB}\n` +
            `VSCODE_RSS_EMERG_KB=${emergKB}\n`;

        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'readFileSync', () => expected);
        t.mock.method(fs, 'writeFileSync', () => { throw new Error('should not be called'); });

        const result = writeConfig(makeCfg());
        assert.equal(result.changed, false, 'changed=false when content identical');
        assert.equal(result.warnings.length, 0);
    });

    test('changed=true when existing config differs from new content', (t) => {
        t.mock.method(fs, 'mkdirSync', () => {});
        t.mock.method(fs, 'readFileSync', () => 'VSCODE_RSS_WARN_KB=999999\n');
        let written = false;
        t.mock.method(fs, 'writeFileSync', () => { written = true; });

        const result = writeConfig(makeCfg());
        assert.equal(result.changed, true, 'changed=true when content differs');
        assert.ok(written, 'writeFileSync was called');
    });
});
