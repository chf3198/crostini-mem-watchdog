// test/unit/updateChecker.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for updateChecker.js — GitHub Releases self-update check.
//
// MOCKING STRATEGY:
//   updateChecker.js imports 'vscode' and 'https'.
//   - 'vscode'  → injected via mockVscode helper (Module._resolveFilename)
//   - 'https'   → real module; patched per-test via t.mock.method()
//
// IMPORTANT: updateChecker.js is required ONCE after mocks are in place.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

process.env.MEM_WATCHDOG_TEST = '1';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const https  = require('https');
const { EventEmitter } = require('events');

// ── Step 1: mock 'vscode' ─────────────────────────────────────────────────────
const { setup: vsSetup, mockWindow, mockVscode } = require('../helpers/mockVscode');
vsSetup();

// ── Step 2: require updateChecker with mocks in place ─────────────────────────
const { checkForUpdate, compareVersions, _test } = require('../../updateChecker');
const {
    STATE_KEY_LAST_CHECK,
    STATE_KEY_DISMISSED,
    CHECK_INTERVAL_MS,
} = _test;

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock context with globalState and extension metadata.
 * @param {string} localVersion - The local extension version (e.g., '0.3.5')
 * @param {Object} [stateOverrides] - Initial globalState key-value pairs
 */
function makeContext(localVersion, stateOverrides = {}) {
    const store = { ...stateOverrides };
    return {
        extension: {
            packageJSON: { version: localVersion },
        },
        globalState: {
            get(key, defaultValue) {
                return Object.prototype.hasOwnProperty.call(store, key)
                    ? store[key]
                    : defaultValue;
            },
            async update(key, val) { store[key] = val; },
            _store: store,
        },
    };
}

/**
 * Mock https.get to return a canned response.
 * @param {object} t - The test context (for t.mock.method)
 * @param {number} statusCode - HTTP status code
 * @param {object|null} body - JSON response body (null = empty)
 * @param {string} [error] - If set, emit an error event instead of responding
 */
function mockHttpsGet(t, statusCode, body, error) {
    t.mock.method(https, 'get', (options, cb) => {
        const req = new EventEmitter();
        req.destroy = () => {};

        if (error) {
            process.nextTick(() => req.emit('error', new Error(error)));
            return req;
        }

        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = () => {};
        res.setEncoding = () => {};

        process.nextTick(() => {
            cb(res);
            if (body !== null) {
                res.emit('data', JSON.stringify(body));
            }
            res.emit('end');
        });

        return req;
    });
}

// ── Per-test reset ────────────────────────────────────────────────────────────
function reset() {
    mockWindow.reset();
    mockVscode.commands.reset();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('compareVersions', () => {
    test('equal versions', () => {
        assert.equal(compareVersions('0.3.5', '0.3.5'), 0);
        assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    });

    test('a < b', () => {
        assert.equal(compareVersions('0.3.5', '0.3.6'), -1);
        assert.equal(compareVersions('0.3.9', '0.4.0'), -1);
        assert.equal(compareVersions('0.3.5', '1.0.0'), -1);
    });

    test('a > b', () => {
        assert.equal(compareVersions('0.3.6', '0.3.5'), 1);
        assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
    });

    test('unequal segment counts', () => {
        assert.equal(compareVersions('1.0', '1.0.0'), 0);
        assert.equal(compareVersions('1.0', '1.0.1'), -1);
        assert.equal(compareVersions('1.0.1', '1.0'), 1);
    });
});

describe('checkForUpdate — throttling', () => {
    beforeEach(() => reset());

    test('skips check if called within the last 24 hours', async (t) => {
        const recentTimestamp = Date.now() - (CHECK_INTERVAL_MS / 2); // 12 hours ago
        const ctx = makeContext('0.3.5', {
            [STATE_KEY_LAST_CHECK]: recentTimestamp,
        });

        // If https.get IS called, the mock will throw — ensuring the
        // function truly skipped the network call.
        t.mock.method(https, 'get', () => {
            throw new Error('should not have called https.get');
        });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'no notification when throttled');
    });

    test('proceeds with check if last check was > 24 hours ago', async (t) => {
        const oldTimestamp = Date.now() - CHECK_INTERVAL_MS - 1000; // >24h ago
        const ctx = makeContext('0.3.5', {
            [STATE_KEY_LAST_CHECK]: oldTimestamp,
        });

        mockHttpsGet(t, 200, { tag_name: 'v0.3.5' }); // same version — no notification

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'no notification when up-to-date');

        // Verify timestamp was updated
        const newTs = ctx.globalState._store[STATE_KEY_LAST_CHECK];
        assert.ok(newTs > oldTimestamp, 'timestamp should be updated after check');
    });
});

describe('checkForUpdate — version comparison', () => {
    beforeEach(() => reset());

    test('no notification when remote version equals local', async (t) => {
        const ctx = makeContext('0.3.6');
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0);
    });

    test('no notification when local is ahead of remote', async (t) => {
        const ctx = makeContext('0.4.0');
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0);
    });

    test('shows notification when remote version is newer', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 1);
        assert.ok(mockWindow._infoMessages[0].includes('0.3.6'), 'message mentions new version');
        assert.ok(mockWindow._infoMessages[0].includes('0.3.5'), 'message mentions current version');
    });
});

describe('checkForUpdate — button actions', () => {
    beforeEach(() => reset());

    test('"Update Now" opens extension search', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });
        mockWindow._infoChoices.push('Update Now');

        await checkForUpdate(ctx);
        assert.equal(mockVscode.commands._executedCommands.length, 1);
        assert.deepEqual(mockVscode.commands._executedCommands[0], [
            'workbench.extensions.search',
            'CurtisFranks.mem-watchdog-status',
        ]);
    });

    test('"Dismiss" stores dismissed version in globalState', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });
        mockWindow._infoChoices.push('Dismiss');

        await checkForUpdate(ctx);
        assert.equal(ctx.globalState._store[STATE_KEY_DISMISSED], '0.3.6');
    });

    test('dismissed version is not shown again', async (t) => {
        const ctx = makeContext('0.3.5', {
            [STATE_KEY_DISMISSED]: '0.3.6',
        });
        mockHttpsGet(t, 200, { tag_name: 'v0.3.6' });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'dismissed version skipped');
    });

    test('new version after dismissal shows notification again', async (t) => {
        const ctx = makeContext('0.3.5', {
            [STATE_KEY_DISMISSED]: '0.3.6', // previously dismissed 0.3.6
        });
        mockHttpsGet(t, 200, { tag_name: 'v0.3.7' }); // newer version

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 1, 'new version triggers notification');
    });
});

describe('checkForUpdate — error handling', () => {
    beforeEach(() => reset());

    test('network error is silently handled', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 0, null, 'ENOTFOUND');

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'no notification on network error');
        assert.equal(mockWindow._errorMessages.length, 0, 'no error shown to user');
    });

    test('non-200 status code is handled gracefully', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 404, null);

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'no notification on 404');
    });

    test('invalid JSON response is handled gracefully', async (t) => {
        const ctx = makeContext('0.3.5');
        // Send raw string instead of JSON via a custom mock
        t.mock.method(https, 'get', (options, cb) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            const res = new EventEmitter();
            res.statusCode = 200;
            res.setEncoding = () => {};

            process.nextTick(() => {
                cb(res);
                res.emit('data', 'not valid json{{{');
                res.emit('end');
            });
            return req;
        });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0, 'no notification on bad JSON');
    });

    test('response with no tag_name is handled gracefully', async (t) => {
        const ctx = makeContext('0.3.5');
        mockHttpsGet(t, 200, { name: 'release without tag_name' });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0);
    });

    test('request timeout is handled gracefully', async (t) => {
        const ctx = makeContext('0.3.5');
        // Simulate a timeout event
        t.mock.method(https, 'get', (options, cb) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            process.nextTick(() => req.emit('timeout'));
            return req;
        });

        await checkForUpdate(ctx);
        assert.equal(mockWindow._infoMessages.length, 0);
    });
});
