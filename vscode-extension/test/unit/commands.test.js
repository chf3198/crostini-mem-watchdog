// test/unit/commands.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for commands.js — killDisposable(), restartService(), and the
// pkill exit-code interpretation that was fixed by removing '|| true'.
//
// MOCKING STRATEGY (CJS require.cache injection):
//   commands.js imports both 'vscode' and './utils'. Neither resolves in a
//   plain Node process. We inject both into require.cache BEFORE requiring
//   commands.js so its destructured const bindings capture our mock functions.
//
//   The utils mock uses a per-test result queue: tests pre-push sh() return
//   values, and the shared mockSh closure pops them in FIFO order. This lets
//   each test control what sh() returns without re-requiring the module.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

// ── Step 1: mock 'vscode' ─────────────────────────────────────────────────────
// Must happen before require('../../commands') below.
const { setup: vsSetup, mockWindow, mockWorkspace, mockVscode } = require('../helpers/mockVscode');
vsSetup();

// ── Step 2: mock './utils' ────────────────────────────────────────────────────
// commands.js does: const { readMeminfo, readPsi, sh } = require('./utils')
// We must populate require.cache at the resolved path before the first require.

const utilsAbsPath = path.resolve(__dirname, '../../utils.js');
const chatContinuityAbsPath = path.resolve(__dirname, '../../chatContinuity.js');

// Mutable queue — push desired return values before each test
const _shQueue   = [];
const _shCallLog = [];

async function mockSh(cmd) {
    _shCallLog.push(cmd);
    // Queued result overrides the default
    if (_shQueue.length > 0) { return _shQueue.shift(); }
    return { ok: true, stdout: '', stderr: '' };
}

// readMeminfo / readPsi return stable defaults; tests can override _mockMi if needed
let _mockMi   = { totalKB: 6440000, availableKB: 2000000, pct: 31 };
const mockReadMeminfo = () => _mockMi;
const mockReadPsi     = () => 0;

require.cache[utilsAbsPath] = {
    id:       utilsAbsPath,
    filename: utilsAbsPath,
    loaded:   true,
    paths:    [],
    exports:  { readMeminfo: mockReadMeminfo, readPsi: mockReadPsi, sh: mockSh },
};

const _rescueInvocations = [];
let _mockCandidate = {
    name: 'huge-session.json',
    filePath: '/tmp/huge-session.json',
    sizeBytes: 458 * 1024 * 1024,
    mtimeMs: Date.now(),
    workspaceId: 'inactive-workspace',
};
let _sessionIsActive = true;
require.cache[chatContinuityAbsPath] = {
    id: chatContinuityAbsPath,
    filename: chatContinuityAbsPath,
    loaded: true,
    paths: [],
    exports: {
        DEFAULT_SESSION_THRESHOLD_MB: 120,
        formatBytes: (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`,
        findRescueCandidate: () => _mockCandidate,
        sessionInActiveWorkspace: () => _sessionIsActive,
        rescueSession: async (_vscode, options) => {
            _rescueInvocations.push(options);
            return {
                ok: true,
                resumePath: '/tmp/resume.prompt.md',
                packPath: '/tmp/continuity-pack.md',
            };
        },
    },
};

// ── Step 3: require the module under test ─────────────────────────────────────
const commands = require('../../commands');

// ── Per-test reset ────────────────────────────────────────────────────────────
function reset() {
    _shQueue.length   = 0;
    _shCallLog.length = 0;
    mockWindow.reset();
    mockWorkspace.reset();
    mockVscode.commands.reset();
    mockVscode.extensions = { all: [] };
    _rescueInvocations.length = 0;
    _mockCandidate = {
        name: 'huge-session.json',
        filePath: '/tmp/huge-session.json',
        sizeBytes: 458 * 1024 * 1024,
        mtimeMs: Date.now(),
        workspaceId: 'inactive-workspace',
    };
    _sessionIsActive = true;
    _mockMi = { totalKB: 6440000, availableKB: 2000000, pct: 31 };
}

// ── killDisposable tests ─────────────────────────────────────────────────────
// This is the most important test group: verifies the pkill exit-code logic
// after the '|| true' bug was removed.
//
// pkill semantics (from pkill(1)):
//   Exit 0  → at least one process matched and was signalled   → ok: true
//   Exit 1  → no processes matched                             → ok: false
//
// Expected UI behaviour:
//   Both ok:true  → "SIGTERM sent to Chrome/Chromium + Playwright node"
//   Chrome only   → "SIGTERM sent to Chrome/Chromium"
//   Playwright only → "SIGTERM sent to Playwright node"
//   Both ok:false → "no Chrome or Playwright processes found"

describe('killDisposable — pkill exit-code interpretation', () => {
    beforeEach(() => reset());

    test('both pkill succeed: informationMessage lists both targets', async () => {
        _shQueue.push({ ok: true,  stdout: '', stderr: '' }); // chrome pkill
        _shQueue.push({ ok: true,  stdout: '', stderr: '' }); // playwright pkill

        await commands.killDisposable();

        assert.equal(mockWindow._infoMessages.length, 1, 'exactly one info message');
        const msg = mockWindow._infoMessages[0];
        assert.ok(msg.includes('Chrome/Chromium'),  `message should mention Chrome: "${msg}"`);
        assert.ok(msg.includes('Playwright node'),  `message should mention Playwright: "${msg}"`);
        assert.equal(mockWindow._errorMessages.length, 0, 'no error messages');
    });

    test('only chrome pkill succeeds: message mentions only Chrome', async () => {
        _shQueue.push({ ok: true,  stdout: '', stderr: '' }); // chrome found
        _shQueue.push({ ok: false, stdout: '', stderr: '' }); // playwright not found

        await commands.killDisposable();

        const msg = mockWindow._infoMessages[0];
        assert.ok(msg.includes('Chrome/Chromium'), 'Chrome mentioned');
        assert.ok(!msg.includes('Playwright node'), 'Playwright NOT mentioned');
    });

    test('only playwright pkill succeeds: message mentions only Playwright', async () => {
        _shQueue.push({ ok: false, stdout: '', stderr: '' }); // chrome not found
        _shQueue.push({ ok: true,  stdout: '', stderr: '' }); // playwright found

        await commands.killDisposable();

        const msg = mockWindow._infoMessages[0];
        assert.ok(!msg.includes('Chrome/Chromium'), 'Chrome NOT mentioned');
        assert.ok(msg.includes('Playwright node'), 'Playwright mentioned');
    });

    test('both pkill exit 1 (no processes): shows "no processes found" message', async () => {
        // This is the critical regression test: before removing '|| true',
        // ok was always true, making this path unreachable dead code.
        _shQueue.push({ ok: false, stdout: '', stderr: '' }); // chrome: exit 1
        _shQueue.push({ ok: false, stdout: '', stderr: '' }); // playwright: exit 1

        await commands.killDisposable();

        assert.equal(mockWindow._infoMessages.length, 1);
        const msg = mockWindow._infoMessages[0];
        assert.ok(
            msg.includes('no disposable') || msg.includes('no Chrome') || msg.includes('no chrome') || msg.includes('not found') || msg.includes('no processes'),
            `expected "no processes" message, got: "${msg}"`
        );
        assert.equal(mockWindow._errorMessages.length, 0, 'must be info, not error');
    });

    test('both pkill exit 1: does not show an error message', async () => {
        _shQueue.push({ ok: false, stdout: '', stderr: '' });
        _shQueue.push({ ok: false, stdout: '', stderr: '' });

        await commands.killDisposable();

        assert.equal(mockWindow._errorMessages.length, 0,
            '"no processes found" must use showInformationMessage, not showErrorMessage');
    });
});

// ── restartService tests ──────────────────────────────────────────────────────

describe('restartService', () => {
    beforeEach(() => reset());

    test('successful restart: shows info message with ✓', async () => {
        _shQueue.push({ ok: true, stdout: '', stderr: '' });

        await commands.restartService();

        assert.equal(mockWindow._infoMessages.length, 1);
        assert.ok(mockWindow._infoMessages[0].includes('✓') ||
                  mockWindow._infoMessages[0].toLowerCase().includes('restart'),
                  `expected success message, got: "${mockWindow._infoMessages[0]}"`);
        assert.equal(mockWindow._errorMessages.length, 0);
    });

    test('failed restart: shows error message with stderr', async () => {
        _shQueue.push({ ok: false, stdout: '', stderr: 'Unit not found.' });

        await commands.restartService();

        assert.equal(mockWindow._errorMessages.length, 1);
        const errMsg = mockWindow._errorMessages[0];
        assert.ok(errMsg.includes('Unit not found.'), `expected stderr in message: "${errMsg}"`);
        assert.equal(mockWindow._infoMessages.length, 0);
    });
});

describe('createLowMemProfile', () => {
    beforeEach(() => reset());

    test('guides profile creation from current profile', async () => {
        mockVscode.extensions = {
            all: [
                { id: 'eamodio.gitlens', packageJSON: { displayName: 'GitLens' } },
                { id: 'github.copilot', packageJSON: { displayName: 'GitHub Copilot' } },
            ],
        };
        mockWindow._infoChoices.push('Create From Current Profile');

        await commands.createLowMemProfile();

        assert.ok(mockVscode.commands._executedCommands.some(args => args[0] === 'workbench.profiles.actions.createFromCurrentProfile'));
        assert.ok(mockWindow._infoMessages.some(msg => msg.includes('MemWatchdog LowMem')));
    });

    test('applies recommended disable set in current profile', async () => {
        mockVscode.extensions = {
            all: [
                { id: 'eamodio.gitlens', packageJSON: { displayName: 'GitLens' } },
                { id: 'ms-azuretools.vscode-docker', packageJSON: { displayName: 'Docker' } },
            ],
        };
        mockWindow._infoChoices.push('Apply Recommended Set Here', 'Later');

        await commands.createLowMemProfile();

        assert.ok(mockVscode.commands._executedCommands.some(args => args[0] === 'extension.open' && args[1] === 'eamodio.gitlens'));
        assert.ok(mockVscode.commands._executedCommands.some(args => args[0] === 'extensions.disableGlobally'));
    });
});

describe('chatRescue', () => {
    beforeEach(() => reset());

    test('archives and reloads when user chooses Archive + Restart', async () => {
        mockWorkspace._configValues = {
            'chatGuard.sessionSizeMB': 120,
            'chatGuard.preserveCount': 3,
            'chatGuard.restartAfterRescue': true,
        };
        mockWindow._warnChoices.push('Archive + Restart');

        const result = await commands.chatRescue();

        assert.equal(result.ok, true);
        assert.equal(_rescueInvocations.length, 1);
        assert.ok(mockVscode.commands._executedCommands.some(args => args[0] === 'workbench.action.reloadWindow'));
    });

    test('archives without reload when user chooses Archive Only', async () => {
        mockWindow._warnChoices.push('Archive Only');

        const result = await commands.chatRescue();

        assert.equal(result.ok, true);
        assert.equal(_rescueInvocations.length, 1);
        assert.ok(!mockVscode.commands._executedCommands.some(args => args[0] === 'workbench.action.reloadWindow'));
    });

    test('maybePromptChatRescue preemptively archives inactive workspace sessions', async () => {
        _sessionIsActive = false;
        mockWorkspace._configValues = {
            'chatGuard.enabled': true,
            'chatGuard.sessionSizeMB': 120,
            'chatGuard.autoRescue': 'prompt',
        };

        const acted = await commands.maybePromptChatRescue({ preemptive: true });

        assert.equal(acted, true);
        assert.equal(_rescueInvocations.length, 1);
        assert.equal(_rescueInvocations[0].openResume, false);
        assert.equal(_rescueInvocations[0].session.workspaceId, 'inactive-workspace');
        assert.ok(!mockVscode.commands._executedCommands.some(args => args[0] === 'workbench.action.reloadWindow'));
    });

    test('maybePromptChatRescue skips when no candidate', async () => {
        _mockCandidate = null;
        const acted = await commands.maybePromptChatRescue({ preemptive: true });
        assert.equal(acted, false);
        assert.equal(_rescueInvocations.length, 0);
    });
});
