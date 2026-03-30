// test/unit/chatParticipant.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for chatParticipant.js — chat participant handler + profile logic.
//
// MOCKING STRATEGY:
//   chatParticipant.js imports 'vscode', './commands', './utils'.
//   - 'vscode'    → mockVscode with chat API stubs added
//   - './commands' → cache-injected mock with killChrome/restartService/showDashboard
//   - './utils'    → cache-injected mock with readMeminfo/readPsi/sh
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

process.env.MEM_WATCHDOG_TEST = '1';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

// ── Step 1: mock 'vscode' with chat API ───────────────────────────────────────
const { setup: vsSetup, mockVscode, mockWorkspace } = require('../helpers/mockVscode');
vsSetup();

// Add chat API stub and ConfigurationTarget to mockVscode
const _createdParticipants = [];
mockVscode.chat = {
    createChatParticipant(id, handler) {
        const p = { id, requestHandler: handler, followupProvider: null, dispose() {} };
        _createdParticipants.push(p);
        return p;
    },
};
mockVscode.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// Enhance mock workspace.getConfiguration to track updates
const _configUpdates = [];
const origGetConfig = mockWorkspace.getConfiguration.bind(mockWorkspace);
mockWorkspace.getConfiguration = function(section) {
    const base = origGetConfig(section);
    base.update = async function(key, value, target) {
        _configUpdates.push({ key, value, target });
    };
    return base;
};

// ── Step 2: mock './commands' ─────────────────────────────────────────────────
const commandsAbsPath = path.resolve(__dirname, '../../commands.js');
const _commandsCalled = [];

require.cache[commandsAbsPath] = {
    id: commandsAbsPath, filename: commandsAbsPath, loaded: true, paths: [],
    exports: {
        killChrome()     { _commandsCalled.push('killChrome'); return Promise.resolve(); },
        restartService() { _commandsCalled.push('restartService'); return Promise.resolve(); },
        showDashboard()  { _commandsCalled.push('showDashboard'); return Promise.resolve(); },
        preflightCheck() { _commandsCalled.push('preflightCheck'); return Promise.resolve(); },
        dispose()        {},
    },
};

// ── Step 3: mock './utils' ────────────────────────────────────────────────────
const utilsAbsPath = path.resolve(__dirname, '../../utils.js');

let _mockMeminfo = { totalKB: 6300 * 1024, availableKB: 4600 * 1024, pct: 73.0 };
let _mockPsi = 0;
let _mockShResults = {};

require.cache[utilsAbsPath] = {
    id: utilsAbsPath, filename: utilsAbsPath, loaded: true, paths: [],
    exports: {
        readMeminfo() { return _mockMeminfo; },
        readPsi()     { return _mockPsi; },
        async sh(cmd) {
            if (_mockShResults[cmd]) { return _mockShResults[cmd]; }
            if (cmd.includes('is-active')) { return { ok: true, stdout: 'active\n', stderr: '' }; }
            if (cmd.includes('ps -C code')) { return { ok: true, stdout: '2867200\n', stderr: '' }; }
            return { ok: true, stdout: '', stderr: '' };
        },
        checkServiceStatus() { return 'active'; },
    },
};

// ── Step 4: require chatParticipant.js ────────────────────────────────────────
const { registerChatParticipant, PROFILES } = require('../../chatParticipant');
const { _test } = require('../../chatParticipant');

// ── Stream mock ───────────────────────────────────────────────────────────────
function createMockStream() {
    const out = { markdowns: [], buttons: [] };
    return {
        _out: out,
        markdown(text) { out.markdowns.push(text); },
        button(btn)    { out.buttons.push(btn); },
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('chatParticipant — detectProfile()', () => {
    test('detects playwright profile', () => {
        assert.equal(_test.detectProfile('Use playwright headed mode'), 'playwright');
        assert.equal(_test.detectProfile('automation session'), 'playwright');
    });

    test('detects conservative profile', () => {
        assert.equal(_test.detectProfile('conservative tuning'), 'conservative');
        assert.equal(_test.detectProfile('safe mode'), 'conservative');
    });

    test('detects balanced profile', () => {
        assert.equal(_test.detectProfile('balanced settings'), 'balanced');
        assert.equal(_test.detectProfile('use default'), 'balanced');
    });

    test('returns null for unrecognised prompt', () => {
        assert.equal(_test.detectProfile('something unrelated'), null);
        assert.equal(_test.detectProfile(''), null);
    });
});

describe('chatParticipant — PROFILES', () => {
    test('has three profiles with expected keys', () => {
        assert.deepEqual(Object.keys(PROFILES).sort(), ['balanced', 'conservative', 'playwright']);
        for (const name of Object.keys(PROFILES)) {
            const p = PROFILES[name];
            assert.equal(typeof p.sigterm, 'number');
            assert.equal(typeof p.sigkill, 'number');
        }
    });

    test('balanced profile matches daemon defaults', () => {
        assert.equal(PROFILES.balanced.sigterm, 25);
        assert.equal(PROFILES.balanced.sigkill, 15);
    });
});

describe('chatParticipant — applyProfile()', () => {
    beforeEach(() => { _configUpdates.length = 0; });

    test('applies balanced profile settings', async () => {
        const ok = await _test.applyProfile('balanced');
        assert.equal(ok, true);
        assert.equal(_configUpdates.length, 2);
        assert.equal(_configUpdates[0].key, 'sigtermThresholdPct');
        assert.equal(_configUpdates[0].value, 25);
        assert.equal(_configUpdates[1].key, 'sigkillThresholdPct');
        assert.equal(_configUpdates[1].value, 15);
    });

    test('returns false for unknown profile', async () => {
        const ok = await _test.applyProfile('nonexistent');
        assert.equal(ok, false);
    });
});

describe('chatParticipant — requestHandler()', () => {
    beforeEach(() => {
        _commandsCalled.length = 0;
        _mockMeminfo = { totalKB: 6300 * 1024, availableKB: 4600 * 1024, pct: 73.0 };
        _mockPsi = 0;
    });

    test('/status renders status markdown with buttons', async () => {
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'status', prompt: '' }, {}, stream
        );
        assert.equal(result.metadata.command, 'status');
        assert.ok(stream._out.markdowns.some(m => m.includes('Mem Watchdog Status')));
        assert.ok(stream._out.markdowns.some(m => m.includes('RAM free')));
        assert.equal(stream._out.buttons.length, 2);
    });

    test('/status handles null meminfo gracefully', async () => {
        _mockMeminfo = null;
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'status', prompt: '' }, {}, stream
        );
        assert.equal(result.metadata.command, 'status');
        assert.ok(stream._out.markdowns.some(m => m.includes('unreadable')));
    });

    test('/logs renders journal output', async () => {
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'logs', prompt: '' }, {}, stream
        );
        assert.equal(result.metadata.command, 'logs');
        assert.ok(stream._out.markdowns.some(m => m.includes('journal')));
    });

    test('/act kill dispatches killChrome', async () => {
        const stream = createMockStream();
        await _test.requestHandler(
            { command: 'act', prompt: 'kill chrome now' }, {}, stream
        );
        assert.ok(_commandsCalled.includes('killChrome'));
    });

    test('/act restart dispatches restartService', async () => {
        const stream = createMockStream();
        await _test.requestHandler(
            { command: 'act', prompt: 'restart the service' }, {}, stream
        );
        assert.ok(_commandsCalled.includes('restartService'));
    });

    test('/act without keyword opens dashboard', async () => {
        const stream = createMockStream();
        await _test.requestHandler(
            { command: 'act', prompt: 'do something' }, {}, stream
        );
        assert.ok(_commandsCalled.includes('showDashboard'));
    });

    test('/tune without profile shows help', async () => {
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'tune', prompt: '' }, {}, stream
        );
        assert.equal(result.metadata.command, 'tune');
        assert.ok(stream._out.markdowns.some(m => m.includes('Specify a profile')));
    });

    test('/tune with valid profile applies it', async () => {
        _configUpdates.length = 0;
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'tune', prompt: 'use conservative mode' }, {}, stream
        );
        assert.equal(result.metadata.command, 'tune');
        assert.ok(stream._out.markdowns.some(m => m.includes('conservative')));
        assert.equal(_configUpdates.length, 2);
    });

    test('unknown command defaults to status', async () => {
        const stream = createMockStream();
        const result = await _test.requestHandler(
            { command: 'unknown', prompt: '' }, {}, stream
        );
        assert.equal(result.metadata.command, 'status');
    });
});

describe('chatParticipant — manifest contract (#43 regression)', () => {
    test('package.json chatParticipants.isSticky is false — prevents duplicate UI perception', () => {
        // Regression guard for #43: isSticky: true caused the chat participant to
        // be pinned permanently in the Chat panel alongside the status bar item,
        // creating the perception of "duplicate IDE info elements."
        const pkg = require('../../package.json');
        const participant = pkg.contributes.chatParticipants[0];
        assert.equal(participant.isSticky, false,
            'isSticky must be false — true pins the chat participant in the Chat panel, ' +
            'creating perceived duplication with the status bar item (#43)');
    });

    test('chatParticipant ID matches between package.json and runtime registration', () => {
        const pkg = require('../../package.json');
        const declaredId = pkg.contributes.chatParticipants[0].id;
        const ctx = { subscriptions: [] };
        _createdParticipants.length = 0;
        registerChatParticipant(ctx);
        assert.equal(_createdParticipants[0].id, declaredId,
            'runtime createChatParticipant ID must match package.json declaration');
        _createdParticipants.length = 0;
    });
});

describe('chatParticipant — registerChatParticipant()', () => {
    beforeEach(() => { _createdParticipants.length = 0; });

    test('registers participant when chat API is available', () => {
        const subs = [];
        const ctx = { subscriptions: subs };
        registerChatParticipant(ctx);
        assert.equal(_createdParticipants.length, 1);
        assert.equal(_createdParticipants[0].id, 'mem-watchdog-status.memWatchdogAssistant');
        assert.equal(subs.length, 1);
    });

    test('sets followup provider on participant', () => {
        const ctx = { subscriptions: [] };
        registerChatParticipant(ctx);
        const p = _createdParticipants[0];
        assert.ok(p.followupProvider);
        assert.equal(typeof p.followupProvider.provideFollowups, 'function');
    });

    test('followups after status suggest logs and tune', () => {
        const ctx = { subscriptions: [] };
        registerChatParticipant(ctx);
        const followups = _createdParticipants[0].followupProvider.provideFollowups(
            { metadata: { command: 'status' } }
        );
        assert.ok(followups.some(f => f.prompt.includes('logs')));
        assert.ok(followups.some(f => f.prompt.includes('tune')));
    });

    test('followups after logs suggest status and restart', () => {
        const ctx = { subscriptions: [] };
        registerChatParticipant(ctx);
        const followups = _createdParticipants[0].followupProvider.provideFollowups(
            { metadata: { command: 'logs' } }
        );
        assert.ok(followups.some(f => f.prompt.includes('status')));
        assert.ok(followups.some(f => f.prompt.includes('restart')));
    });

    test('skips registration when chat API is unavailable', () => {
        // Temporarily remove chat API
        const savedChat = mockVscode.chat;
        mockVscode.chat = undefined;
        const ctx = { subscriptions: [] };
        registerChatParticipant(ctx);
        assert.equal(_createdParticipants.length, 0);
        assert.equal(ctx.subscriptions.length, 0);
        mockVscode.chat = savedChat;
    });
});
