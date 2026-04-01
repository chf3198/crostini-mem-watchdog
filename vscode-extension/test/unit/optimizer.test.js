// test/unit/optimizer.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for optimizer.js — VS Code memory optimization audit/apply logic.
//
// optimizer.js does NOT import 'vscode' — it receives the vscode API as a
// parameter.  No mock injection is needed at module-load time.
//
// argv.json tests use temp files via os.tmpdir() to avoid touching real config.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const {
    SETTINGS_PROFILE,
    ARGV_PROFILE,
    JS_FLAGS_DETAIL,
    parseJsFlags,
    diffJsFlags,
    mergeJsFlags,
    settingMatches,
    objectMissingKeys,
    auditSettings,
    auditArgv,
    applyArgv,
    renderReport,
} = require('../../optimizer');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal cfg object that mimics vscode.workspace.getConfiguration() */
function makeCfg(values) {
    return {
        get(key) {
            return Object.prototype.hasOwnProperty.call(values, key)
                ? values[key]
                : undefined;
        },
    };
}

/** Create a temp argv.json file, return its path */
function writeTmpArgv(content) {
    const tmpFile = path.join(os.tmpdir(), `argv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(content, null, 2), 'utf8');
    return tmpFile;
}

// ── settingMatches ────────────────────────────────────────────────────────────

describe('settingMatches', () => {
    test('matches identical primitives', () => {
        assert.equal(settingMatches(false, false), true);
        assert.equal(settingMatches(768, 768), true);
        assert.equal(settingMatches('off', 'off'), true);
        assert.equal(settingMatches('gutter', 'gutter'), true);
    });

    test('rejects different primitives', () => {
        assert.equal(settingMatches(true, false), false);
        assert.equal(settingMatches(512, 768), false);
        assert.equal(settingMatches('on', 'off'), false);
    });

    test('matches undefined to undefined', () => {
        assert.equal(settingMatches(undefined, undefined), true);
    });

    test('rejects undefined vs primitive', () => {
        assert.equal(settingMatches(undefined, false), false);
    });

    test('object target: matches when current has all profile keys', () => {
        const target = { '**/.git/objects/**': true, '**/node_modules/**': true };
        const current = { '**/.git/objects/**': true, '**/node_modules/**': true, '**/extra/**': true };
        assert.equal(settingMatches(current, target), true);
    });

    test('object target: rejects when current is missing a profile key', () => {
        const target = { '**/.git/objects/**': true, '**/node_modules/**': true };
        const current = { '**/.git/objects/**': true };
        assert.equal(settingMatches(current, target), false);
    });

    test('object target: rejects when current is null', () => {
        const target = { '**/node_modules/**': true };
        assert.equal(settingMatches(null, target), false);
    });

    test('object target: rejects when current is a primitive', () => {
        const target = { '**/node_modules/**': true };
        assert.equal(settingMatches('string', target), false);
    });
});

describe('objectMissingKeys', () => {
    test('returns target keys when current is non-object', () => {
        const target = { a: true, b: true };
        assert.deepEqual(objectMissingKeys(null, target), ['a', 'b']);
    });

    test('returns only mismatched/missing keys', () => {
        const target = { a: true, b: true, c: true };
        const current = { a: true, b: false };
        assert.deepEqual(objectMissingKeys(current, target), ['b', 'c']);
    });
});

// ── auditSettings ─────────────────────────────────────────────────────────────

describe('auditSettings', () => {
    test('all-matching config returns all applied, zero missing', () => {
        // Build a cfg with every profile value set correctly
        const values = {};
        for (const [key, profile] of Object.entries(SETTINGS_PROFILE)) {
            values[key] = profile.value;
        }
        const result = auditSettings(makeCfg(values));
        assert.equal(result.missing.length, 0, 'should have zero missing');
        assert.equal(result.applied.length, Object.keys(SETTINGS_PROFILE).length);
    });

    test('empty config returns all missing', () => {
        const result = auditSettings(makeCfg({}));
        assert.equal(result.applied.length, 0, 'should have zero applied');
        assert.equal(result.missing.length, Object.keys(SETTINGS_PROFILE).length);
    });

    test('partial config returns correct split', () => {
        const values = {
            'editor.minimap.enabled': false,
            'breadcrumbs.enabled': false,
            'telemetry.telemetryLevel': 'off',
        };
        const result = auditSettings(makeCfg(values));
        assert.equal(result.applied.length, 3);
        assert.equal(result.missing.length, Object.keys(SETTINGS_PROFILE).length - 3);
    });

    test('missing entries include key, value, savings, reason', () => {
        const result = auditSettings(makeCfg({}));
        const first = result.missing[0];
        assert.ok(first.key, 'should have key');
        assert.ok('value' in first, 'should have value');
        assert.ok(first.savings, 'should have savings');
        assert.ok(first.reason, 'should have reason');
    });

    test('missing entries include currentValue', () => {
        const values = { 'editor.minimap.enabled': true };  // wrong value
        const result = auditSettings(makeCfg(values));
        const minimapEntry = result.missing.find(m => m.key === 'editor.minimap.enabled');
        assert.ok(minimapEntry, 'minimap should be missing');
        assert.equal(minimapEntry.currentValue, true);
    });

    test('object-type setting with superset current still matches', () => {
        const values = {
            'files.watcherExclude': {
                ...SETTINGS_PROFILE['files.watcherExclude'].value,
                '**/custom-extra/**': true,
            },
        };
        const result = auditSettings(makeCfg(values));
        const watcherEntry = result.applied.find(a => a.key === 'files.watcherExclude');
        assert.ok(watcherEntry, 'files.watcherExclude should be applied');
    });

    test('files.watcherExclude reports missing keys for incomplete object', () => {
        const values = {
            'files.watcherExclude': {
                '**/.git/objects/**': true,
            },
        };
        const result = auditSettings(makeCfg(values));
        const watcherEntry = result.missing.find(m => m.key === 'files.watcherExclude');
        assert.ok(watcherEntry, 'files.watcherExclude should be missing when incomplete');
        assert.ok(Array.isArray(watcherEntry.missingKeys), 'missingKeys should be present');
        assert.ok(watcherEntry.missingKeys.includes('**/node_modules/**'));
    });
});

// ── auditArgv ─────────────────────────────────────────────────────────────────

describe('auditArgv', () => {
    test('fully matching argv.json returns all applied', () => {
        const content = {};
        for (const [key, profile] of Object.entries(ARGV_PROFILE)) {
            content[key] = profile.value;
        }
        const tmpFile = writeTmpArgv(content);
        try {
            const result = auditArgv(tmpFile);
            assert.equal(result.missing.length, 0);
            assert.equal(result.applied.length, Object.keys(ARGV_PROFILE).length);
            assert.ok(result.argvContent, 'should return parsed content');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('empty argv.json returns all missing', () => {
        const tmpFile = writeTmpArgv({});
        try {
            const result = auditArgv(tmpFile);
            assert.equal(result.applied.length, 0);
            assert.equal(result.missing.length, Object.keys(ARGV_PROFILE).length);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('missing file returns all missing with null content', () => {
        const result = auditArgv('/tmp/nonexistent-argv-test-file-12345.json');
        assert.equal(result.applied.length, 0);
        assert.equal(result.missing.length, Object.keys(ARGV_PROFILE).length);
        assert.equal(result.argvContent, null);
    });

    test('argv.json with comments is parsed correctly', () => {
        const tmpFile = path.join(os.tmpdir(), `argv-comment-${Date.now()}.json`);
        const raw = `// This is a VS Code argv file
{
    // Use software rendering
    "disable-hardware-acceleration": true,
    "js-flags": "${ARGV_PROFILE['js-flags'].value}"
}
`;
        fs.writeFileSync(tmpFile, raw, 'utf8');
        try {
            const result = auditArgv(tmpFile);
            assert.equal(result.applied.length, 2);
            assert.equal(result.missing.length, 0);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('argv.json with partial js-flags reports per-flag diff', () => {
        const tmpFile = writeTmpArgv({
            'disable-hardware-acceleration': true,
            'js-flags': '--max-old-space-size=2048',
        });
        try {
            const result = auditArgv(tmpFile);
            assert.equal(result.applied.length, 1, 'disable-hardware-acceleration should be applied');
            assert.equal(result.missing.length, 1, 'js-flags should be missing (partial)');

            const jsFlagsMissing = result.missing[0];
            assert.equal(jsFlagsMissing.key, 'js-flags');
            assert.ok(jsFlagsMissing.missingFlags, 'should have missingFlags array');
            assert.ok(jsFlagsMissing.presentFlags, 'should have presentFlags array');
            assert.ok(jsFlagsMissing.presentFlags.includes('--max-old-space-size=2048'),
                'existing flag should be in presentFlags');
            assert.ok(jsFlagsMissing.missingFlags.includes('--optimize-for-size'),
                '--optimize-for-size should be missing');
            assert.equal(jsFlagsMissing.missingFlags.length, 4,
                'should have 4 missing flags');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });
});

// ── applyArgv ─────────────────────────────────────────────────────────────────

describe('applyArgv', () => {
    test('writes missing entries to argv.json', () => {
        const tmpFile = writeTmpArgv({ existing: 'value' });
        try {
            const missing = [
                { key: 'disable-hardware-acceleration', value: true },
            ];
            const changed = applyArgv(missing, { existing: 'value' }, tmpFile);
            assert.equal(changed, true);

            const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
            assert.equal(written['disable-hardware-acceleration'], true);
            assert.equal(written.existing, 'value');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('returns false when no missing entries', () => {
        const changed = applyArgv([], {}, '/tmp/should-not-be-written.json');
        assert.equal(changed, false);
    });

    test('handles null argvContent gracefully', () => {
        const tmpFile = path.join(os.tmpdir(), `argv-null-${Date.now()}.json`);
        try {
            const missing = [
                { key: 'disable-hardware-acceleration', value: true },
                { key: 'js-flags', value: '--max-old-space-size=2048', missingFlags: ['--max-old-space-size=2048'] },
            ];
            const changed = applyArgv(missing, null, tmpFile);
            assert.equal(changed, true);

            const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
            assert.equal(written['disable-hardware-acceleration'], true);
            assert.equal(written['js-flags'], '--max-old-space-size=2048');
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* may not exist */ }
        }
    });

    test('merges individual js-flags into existing string', () => {
        const tmpFile = writeTmpArgv({ 'js-flags': '--max-old-space-size=2048' });
        try {
            const missing = [{
                key: 'js-flags',
                value: ARGV_PROFILE['js-flags'].value,
                missingFlags: ['--optimize-for-size', '--flush-baseline-code'],
            }];
            const changed = applyArgv(missing, { 'js-flags': '--max-old-space-size=2048' }, tmpFile);
            assert.equal(changed, true);

            const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
            const flags = written['js-flags'].split(/\s+/);
            assert.ok(flags.includes('--max-old-space-size=2048'), 'should preserve existing flag');
            assert.ok(flags.includes('--optimize-for-size'), 'should add optimize-for-size');
            assert.ok(flags.includes('--flush-baseline-code'), 'should add flush-baseline-code');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('written file ends with newline', () => {
        const tmpFile = writeTmpArgv({});
        try {
            const missing = [{ key: 'test-key', value: 'test-value' }];
            applyArgv(missing, {}, tmpFile);
            const raw = fs.readFileSync(tmpFile, 'utf8');
            assert.ok(raw.endsWith('\n'), 'file should end with newline');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });
});

// ── renderReport ──────────────────────────────────────────────────────────────

describe('renderReport', () => {
    test('fully optimized report contains checkmark', () => {
        const settings = { applied: [{ key: 'a', savings: '~1 MB' }], missing: [] };
        const argv     = { applied: [{ key: 'b', savings: '~2 MB' }], missing: [] };
        const report   = renderReport(settings, argv);

        assert.ok(report.includes('✅'), 'should have checkmark');
        assert.ok(report.includes('2/2'), 'should show 2/2');
        assert.ok(report.includes('fully optimized'), 'should say fully optimized');
    });

    test('report with missing entries lists them', () => {
        const settings = {
            applied: [],
            missing: [{ key: 'editor.minimap.enabled', value: false, savings: '~10 MB', reason: 'test' }],
        };
        const argv = {
            applied: [],
            missing: [{ key: 'disable-hardware-acceleration', value: true, savings: '~100 MB', reason: 'no GPU' }],
        };
        const report = renderReport(settings, argv);

        assert.ok(report.includes('editor.minimap.enabled'), 'should list settings entry');
        assert.ok(report.includes('disable-hardware-acceleration'), 'should list argv entry');
        assert.ok(report.includes('argv.json'), 'should have argv section header');
        assert.ok(report.includes('settings.json'), 'should have settings section header');
        assert.ok(report.includes('0/2'), 'should show 0/2');
    });

    test('report with only argv missing omits settings section', () => {
        const settings = { applied: [{ key: 'a', savings: '~1 MB' }], missing: [] };
        const argv     = {
            applied: [],
            missing: [{ key: 'x', value: true, savings: '~50 MB', reason: 'test' }],
        };
        const report = renderReport(settings, argv);

        assert.ok(report.includes('argv.json'), 'should have argv section');
        assert.ok(!report.includes('#### settings.json'), 'should NOT have settings section');
    });

    test('report with object-type missing value shows merge label', () => {
        const settings = {
            applied: [],
            missing: [{
                key: 'files.watcherExclude',
                value: { '**/node_modules/**': true },
                savings: '~50 MB',
                reason: 'test',
            }],
        };
        const argv = { applied: [], missing: [] };
        const report = renderReport(settings, argv);
        assert.ok(report.includes('(merge profile keys)'), 'should show merge label for objects');
    });
    test('report with js-flags missing shows per-flag detail', () => {
        const settings = { applied: [], missing: [] };
        const argv = {
            applied: [],
            missing: [{
                key: 'js-flags',
                value: ARGV_PROFILE['js-flags'].value,
                savings: '~400-500 MB aggregate',
                reason: 'test',
                missingFlags: ['--optimize-for-size', '--flush-baseline-code'],
                presentFlags: ['--max-old-space-size=2048'],
            }],
        };
        const report = renderReport(settings, argv);

        assert.ok(report.includes('js-flags'), 'should mention js-flags');
        assert.ok(report.includes('2 flag(s) to add'), 'should show flag count');
        assert.ok(report.includes('--optimize-for-size'), 'should list missing flag');
        assert.ok(report.includes('--flush-baseline-code'), 'should list missing flag');
        assert.ok(report.includes('Favors memory over speed'), 'should include flag detail reason');
    });
});

// ── js-flags helpers ──────────────────────────────────────────────────────────

describe('parseJsFlags', () => {
    test('parses space-separated flags', () => {
        const flags = parseJsFlags('--optimize-for-size --max-old-space-size=2048');
        assert.equal(flags.size, 2);
        assert.ok(flags.has('--optimize-for-size'));
        assert.ok(flags.has('--max-old-space-size=2048'));
    });

    test('handles empty string', () => {
        assert.equal(parseJsFlags('').size, 0);
    });

    test('handles null/undefined', () => {
        assert.equal(parseJsFlags(null).size, 0);
        assert.equal(parseJsFlags(undefined).size, 0);
    });

    test('handles extra whitespace', () => {
        const flags = parseJsFlags('  --a   --b  ');
        assert.equal(flags.size, 2);
    });

    test('handles non-string input', () => {
        assert.equal(parseJsFlags(42).size, 0);
        assert.equal(parseJsFlags(true).size, 0);
    });
});

describe('diffJsFlags', () => {
    test('all flags present returns empty missing', () => {
        const target = '--a --b --c';
        const current = '--a --b --c --d';
        const diff = diffJsFlags(current, target);
        assert.deepEqual(diff.missing, []);
        assert.equal(diff.present.length, 3);
    });

    test('some flags missing returns correct split', () => {
        const diff = diffJsFlags('--a --c', '--a --b --c --d');
        assert.deepEqual(diff.present, ['--a', '--c']);
        assert.deepEqual(diff.missing, ['--b', '--d']);
    });

    test('empty current returns all missing', () => {
        const diff = diffJsFlags('', '--a --b');
        assert.equal(diff.present.length, 0);
        assert.equal(diff.missing.length, 2);
    });

    test('handles value flags with = correctly', () => {
        const diff = diffJsFlags(
            '--max-old-space-size=2048',
            '--max-old-space-size=2048 --optimize-for-size'
        );
        assert.deepEqual(diff.present, ['--max-old-space-size=2048']);
        assert.deepEqual(diff.missing, ['--optimize-for-size']);
    });
});

describe('mergeJsFlags', () => {
    test('appends missing flags to existing string', () => {
        const result = mergeJsFlags('--a --b', ['--c', '--d']);
        assert.equal(result, '--a --b --c --d');
    });

    test('does not duplicate existing flags', () => {
        const result = mergeJsFlags('--a --b', ['--b', '--c']);
        assert.equal(result, '--a --b --c');
    });

    test('handles empty current string', () => {
        const result = mergeJsFlags('', ['--a', '--b']);
        assert.equal(result, '--a --b');
    });

    test('handles null current string', () => {
        const result = mergeJsFlags(null, ['--a']);
        assert.equal(result, '--a');
    });
});

describe('profile completeness', () => {
    test('every SETTINGS_PROFILE entry has value, savings, and reason', () => {
        for (const [key, entry] of Object.entries(SETTINGS_PROFILE)) {
            assert.ok('value' in entry, `${key} missing value`);
            assert.ok(entry.savings, `${key} missing savings`);
            assert.ok(entry.reason, `${key} missing reason`);
        }
    });

    test('every ARGV_PROFILE entry has value, savings, and reason', () => {
        for (const [key, entry] of Object.entries(ARGV_PROFILE)) {
            assert.ok('value' in entry, `${key} missing value`);
            assert.ok(entry.savings, `${key} missing savings`);
            assert.ok(entry.reason, `${key} missing reason`);
        }
    });

    test('SETTINGS_PROFILE has at least 20 entries', () => {
        assert.ok(Object.keys(SETTINGS_PROFILE).length >= 20,
            `Expected >=20 settings, got ${Object.keys(SETTINGS_PROFILE).length}`);
    });

    test('ARGV_PROFILE has at least 2 entries', () => {
        assert.ok(Object.keys(ARGV_PROFILE).length >= 2);
    });

    test('JS_FLAGS_DETAIL has an entry for every flag in ARGV_PROFILE js-flags', () => {
        const flags = ARGV_PROFILE['js-flags'].value.trim().split(/\s+/);
        for (const flag of flags) {
            assert.ok(JS_FLAGS_DETAIL[flag], `JS_FLAGS_DETAIL missing entry for ${flag}`);
            assert.ok(JS_FLAGS_DETAIL[flag].savings, `${flag} missing savings`);
            assert.ok(JS_FLAGS_DETAIL[flag].reason, `${flag} missing reason`);
        }
    });

    test('js-flags value contains exactly 5 flags', () => {
        const flags = ARGV_PROFILE['js-flags'].value.trim().split(/\s+/);
        assert.equal(flags.length, 5, `Expected 5 js-flags, got ${flags.length}`);
    });

    test('files.watcherExclude includes aggressive inotify reduction patterns', () => {
        const watcher = SETTINGS_PROFILE['files.watcherExclude'].value;
        const required = [
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/.next/**',
            '**/.cache/**',
            '**/.parcel-cache/**',
            '**/coverage/**',
            '**/.nyc_output/**',
            '**/__pycache__/**',
            '**/.pytest_cache/**',
            '**/vendor/**',
            '**/.vscode-test/**',
        ];
        for (const key of required) {
            assert.equal(watcher[key], true, `missing watcher pattern: ${key}`);
        }
    });
});
