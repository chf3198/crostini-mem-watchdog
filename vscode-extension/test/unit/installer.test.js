// test/unit/installer.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for installer.js — installOrUpgrade() decision logic.
//
// MOCKING STRATEGY:
//   installer.js imports 'vscode', './utils', 'fs', 'path', 'crypto'.
//   - 'vscode'  → injected via mockVscode helper (Module._resolveFilename patch)
//   - './utils' → injected into require.cache at the resolved absolute path
//   - 'fs', 'crypto' → real modules; patched per-test via t.mock.method() on
//     the shared module instances (same approach as utils.test.js)
//
// WHY NOT MOCK fs AT CACHE INJECTION TIME:
//   installer.js holds a direct reference to 'fs' and 'crypto' module objects.
//   t.mock.method patches those objects in-place, which IS visible to the
//   already-loaded module — no re-require needed.
//
// IMPORTANT: installer.js is required ONCE at module load time (below).
//   The vscode and utils mocks must be set up before that require().
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ── Step 1: mock 'vscode' ─────────────────────────────────────────────────────
const { setup: vsSetup, mockWindow } = require('../helpers/mockVscode');
vsSetup();

// ── Step 2: mock './utils' ────────────────────────────────────────────────────
const utilsAbsPath = path.resolve(__dirname, '../../utils.js');

const _installerShQueue   = [];
const _installerShCallLog = [];

async function mockSh(cmd) {
    _installerShCallLog.push(cmd);
    if (_installerShQueue.length > 0) { return _installerShQueue.shift(); }
    return { ok: true, stdout: '', stderr: '' };
}

require.cache[utilsAbsPath] = {
    id: utilsAbsPath, filename: utilsAbsPath, loaded: true, paths: [],
    exports: { sh: mockSh },
};

// ── Step 3: require installer.js with mocks in place ─────────────────────────
const { installOrUpgrade } = require('../../installer');

// ── Context factory ───────────────────────────────────────────────────────────
function makeContext(storedHash = null) {
    const store = { [storedHash !== null ? 'installedDaemonHash' : '']: storedHash };
    return {
        extensionUri: { fsPath: '/fake/ext' },
        globalState: {
            get(key)          { return store[key] || null; },
            update(key, val)  { store[key] = val; return Promise.resolve(); },
        },
    };
}

// ── Per-test reset ────────────────────────────────────────────────────────────
function reset() {
    _installerShQueue.length   = 0;
    _installerShCallLog.length = 0;
    mockWindow.reset();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('installOrUpgrade — missing bundled file', () => {
    beforeEach(() => reset());

    test('bundled sh not found: returns "current" and shows warning', async (t) => {
        // existsSync(bundledSh) returns false → bail out early
        t.mock.method(fs, 'existsSync', () => false);

        const ctx    = makeContext(null);
        const result = await installOrUpgrade(ctx);

        assert.equal(result, 'current');
        assert.equal(mockWindow._warnMessages.length, 1,
            'should show exactly one warning when bundled file is missing');
        assert.ok(mockWindow._warnMessages[0].toLowerCase().includes('npm run build') ||
                  mockWindow._warnMessages[0].includes('resources'),
                  `warning should mention build step: "${mockWindow._warnMessages[0]}"`);
    });
});

describe('installOrUpgrade — hash comparison paths', () => {
    beforeEach(() => reset());

    // Helper: compute real SHA-256 of known content
    const BUNDLED_CONTENT  = Buffer.from('#!/usr/bin/env bash\n# v1\n');
    const BUNDLED_HASH     = crypto.createHash('sha256').update(BUNDLED_CONTENT).digest('hex');
    const INSTALLED_CONTENT = Buffer.from('#!/usr/bin/env bash\n# v1\n');   // same
    const OLD_CONTENT       = Buffer.from('#!/usr/bin/env bash\n# v0\n');   // different

    test('all hashes match: returns "current" without running systemctl', async (t) => {
        let existsCallCount = 0;
        t.mock.method(fs, 'existsSync', (p) => {
            existsCallCount++;
            return true; // both bundledSh and INSTALLED_SCRIPT exist
        });
        t.mock.method(fs, 'readFileSync', (p, opts) => {
            // sha256() calls readFileSync for both the bundled and installed paths
            if (typeof p === 'string' && p.includes('mem-watchdog.sh')) {
                return BUNDLED_CONTENT;
            }
            throw new Error(`unexpected readFileSync: ${p}`);
        });

        const ctx = makeContext(BUNDLED_HASH); // globalState has matching hash
        const result = await installOrUpgrade(ctx);

        assert.equal(result, 'current');
        // No systemctl calls when up-to-date
        const hasDaemonReload = _installerShCallLog.some(c => c.includes('daemon-reload'));
        assert.equal(hasDaemonReload, false, 'should not run daemon-reload when current');
    });

    test('globalState hash matches but disk file is different: triggers reinstall', async (t) => {
        t.mock.method(fs, 'existsSync', () => true);
        t.mock.method(fs, 'readFileSync', (p) => {
            // bundled file returns new content; installed file returns old content
            if (p === '/fake/ext/resources/mem-watchdog.sh') { return BUNDLED_CONTENT; }
            if (p.includes('.local/bin/mem-watchdog.sh'))     { return OLD_CONTENT; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        // Override file write operations to no-ops
        t.mock.method(fs, 'mkdirSync',    () => {});
        t.mock.method(fs, 'copyFileSync', () => {});
        t.mock.method(fs, 'chmodSync',    () => {});

        // globalState says bundled hash, but disk has old content → mismatch
        const ctx = makeContext(BUNDLED_HASH);
        const result = await installOrUpgrade(ctx);

        // Disk mismatch should trigger reinstall → 'upgraded' (not first install)
        assert.equal(result, 'upgraded');
        const hasDaemonReload = _installerShCallLog.some(c => c.includes('daemon-reload'));
        assert.equal(hasDaemonReload, true, 'daemon-reload should run after reinstall');
    });

    test('installed file does not exist: returns "installed"', async (t) => {
        let callCount = 0;
        t.mock.method(fs, 'existsSync', (p) => {
            callCount++;
            // bundledSh exists, INSTALLED_SCRIPT does not
            if (p === '/fake/ext/resources/mem-watchdog.sh') { return true; }
            return false; // INSTALLED_SCRIPT missing → isFirstInstall = true
        });
        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/fake/ext/resources/mem-watchdog.sh') { return BUNDLED_CONTENT; }
            if (p.includes('.local/bin/mem-watchdog.sh'))     { return null; } // sha256 will catch null
            throw new Error(`unexpected readFileSync: ${p}`);
        });
        t.mock.method(fs, 'mkdirSync',    () => {});
        t.mock.method(fs, 'copyFileSync', () => {});
        t.mock.method(fs, 'chmodSync',    () => {});

        const ctx = makeContext(null); // no stored hash → first install
        const result = await installOrUpgrade(ctx);

        assert.equal(result, 'installed');
        const hasEnable = _installerShCallLog.some(c => c.includes('enable'));
        assert.equal(hasEnable, true, 'enable should run on first install');
    });

    test('installed daemon newer than bundled: skips downgrade and stays current', async (t) => {
        const BUNDLED_OLDER = '#!/usr/bin/env bash\nWATCHDOG_VERSION=20260313.1\n';
        const INSTALLED_NEWER = '#!/usr/bin/env bash\nWATCHDOG_VERSION=20260313.2\n';
        const olderHash = crypto.createHash('sha256').update(BUNDLED_OLDER).digest('hex');

        t.mock.method(fs, 'existsSync', (p) => {
            if (p === '/fake/ext/resources/mem-watchdog.sh') { return true; }
            if (typeof p === 'string' && p.includes('.local/bin/mem-watchdog.sh')) { return true; }
            return true;
        });

        t.mock.method(fs, 'readFileSync', (p) => {
            if (p === '/fake/ext/resources/mem-watchdog.sh') { return BUNDLED_OLDER; }
            if (typeof p === 'string' && p.includes('.local/bin/mem-watchdog.sh')) { return INSTALLED_NEWER; }
            throw new Error(`unexpected readFileSync: ${p}`);
        });

        // Any file writes would indicate an unintended downgrade attempt.
        t.mock.method(fs, 'mkdirSync', () => { throw new Error('should not mkdir on downgrade skip'); });
        t.mock.method(fs, 'copyFileSync', () => { throw new Error('should not copy files on downgrade skip'); });
        t.mock.method(fs, 'chmodSync', () => { throw new Error('should not chmod on downgrade skip'); });

        const ctx = makeContext(olderHash);
        const result = await installOrUpgrade(ctx);

        assert.equal(result, 'current');
        const didRestart = _installerShCallLog.some(c => c.includes('restart mem-watchdog'));
        assert.equal(didRestart, false, 'should not restart service when guarding against downgrade');
    });
});
