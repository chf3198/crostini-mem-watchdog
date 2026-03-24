'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { setup: vsSetup, mockWindow, mockWorkspace, mockVscode } = require('../helpers/mockVscode');
vsSetup();

let createdItems = [];
let disposedItems = 0;

mockWindow.createStatusBarItem = function () {
    const item = {
        text: '',
        color: undefined,
        backgroundColor: undefined,
        tooltip: undefined,
        command: undefined,
        name: undefined,
        show() {},
        dispose() { disposedItems++; },
    };
    createdItems.push(item);
    return item;
};

mockWorkspace.onDidChangeConfiguration = () => ({ dispose() {} });
mockVscode.commands.registerCommand = () => ({ dispose() {} });

const installerPath = path.resolve(__dirname, '../../installer.js');
const configWriterPath = path.resolve(__dirname, '../../configWriter.js');
const commandsPath = path.resolve(__dirname, '../../commands.js');
const utilsPath = path.resolve(__dirname, '../../utils.js');

require.cache[installerPath] = {
    id: installerPath,
    filename: installerPath,
    loaded: true,
    paths: [],
    exports: {
        installOrUpgrade: async () => 'current',
    },
};

require.cache[configWriterPath] = {
    id: configWriterPath,
    filename: configWriterPath,
    loaded: true,
    paths: [],
    exports: {
        writeConfig: () => [],
    },
};

require.cache[commandsPath] = {
    id: commandsPath,
    filename: commandsPath,
    loaded: true,
    paths: [],
    exports: {
        showDashboard() {},
        preflightCheck() {},
        killChrome() {},
        restartService() {},
        dispose() {},
    },
};

require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    paths: [],
    exports: {
        readMeminfo: () => ({ totalKB: 6440000, availableKB: 4000000, pct: 62 }),
        sh: async () => ({ ok: true, stdout: '', stderr: '' }),
        checkServiceStatus: async () => 'active',
    },
};

const ext = require('../../extension');

function makeContext() {
    return { subscriptions: [] };
}

function disposeContext(context) {
    for (const sub of context.subscriptions) {
        if (sub && typeof sub.dispose === 'function') {
            sub.dispose();
        }
    }
}

beforeEach(() => {
    createdItems = [];
    disposedItems = 0;
    ext.deactivate();
});

test('activate() is idempotent in-process: second call does not create a second status item', async () => {
    const contextA = makeContext();
    const contextB = makeContext();

    await ext.activate(contextA);
    await ext.activate(contextB);

    assert.equal(createdItems.length, 1,
        `expected exactly one status bar item across repeated activate() calls, got ${createdItems.length}`);

    ext.deactivate();
    disposeContext(contextA);
    disposeContext(contextB);

    assert.ok(disposedItems >= 1, 'expected created status bar item to be disposed on deactivate/disposal');
});
