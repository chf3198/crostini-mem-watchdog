// test/helpers/mockVscode.js — inject a fake 'vscode' module into require.cache
// ─────────────────────────────────────────────────────────────────────────────
// 'vscode' is a bare specifier that never resolves to a real file outside of
// the VS Code extension host. Node v24 CJS raises MODULE_NOT_FOUND for it.
//
// Solution: patch Module._resolveFilename so the specifier resolves to the
// synthetic key 'vscode', then populate require.cache['vscode'] with our
// mock. Any subsequent require('vscode') in the module under test picks up
// the mock instead of throwing.
//
// Usage — call setup() BEFORE requiring any module that imports 'vscode':
//
//   const { setup, mockWindow, restore } = require('../helpers/mockVscode');
//   setup();
//   const myModule = require('../../my-module');
//   // ... tests ...
//   restore();  // optional; node:test child-process isolation makes this safe to skip
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const Module = require('module');
const origResolveFilename = Module._resolveFilename.bind(Module);

// ── Spy state ─────────────────────────────────────────────────────────────────
// Tests mutate these arrays to inspect what the mock received.
const mockWindow = {
    _infoMessages:  [],
    _errorMessages: [],
    _warnMessages:  [],
    _infoChoices:   [],   // the button label the user "clicked" (set per-test)

    reset() {
        this._infoMessages  = [];
        this._errorMessages = [];
        this._warnMessages  = [];
        this._infoChoices   = [];
    },

    showInformationMessage(msg, ...rest) {
        this._infoMessages.push(msg);
        // Return the first element of _infoChoices if set (simulates button click)
        return Promise.resolve(this._infoChoices.shift() || undefined);
    },
    showErrorMessage(msg) {
        this._errorMessages.push(msg);
        return Promise.resolve(undefined);
    },
    showWarningMessage(msg) {
        this._warnMessages.push(msg);
        return Promise.resolve(undefined);
    },
    createOutputChannel() {
        return { appendLine() {}, clear() {}, show() {}, dispose() {} };
    },
    createStatusBarItem() {
        return { text: '', color: '', tooltip: '', show() {}, dispose() {} };
    },
};

const mockWorkspace = {
    _configValues: {},
    reset() { this._configValues = {}; },
    getConfiguration(/* section */) {
        const vals = mockWorkspace._configValues;
        return {
            get(key, defaultValue) {
                return Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : defaultValue;
            },
        };
    },
    onDidChangeConfiguration() { return { dispose() {} }; },
};

// ── ThemeColor and MarkdownString stubs ───────────────────────────────────────
// extension.js constructs these:
//   new vscode.ThemeColor('statusBarItem.errorBackground')
//   new vscode.MarkdownString('...')
// The stubs preserve the .id / .value so tests can assert on them.

class MockThemeColor {
    constructor(id) { this.id = id; }
}

class MockMarkdownString {
    constructor(value) { this.value = value || ''; }
}

const mockVscode = {
    window:         mockWindow,
    workspace:      mockWorkspace,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor:     MockThemeColor,
    MarkdownString: MockMarkdownString,
    commands: {
        registerCommand(id, handler) { return { dispose() {} }; },
    },
    ExtensionContext: {},
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

let _active = false;

function setup() {
    if (_active) { return; }
    _active = true;

    // Redirect bare 'vscode' specifier to the synthetic key
    Module._resolveFilename = function(request, ...rest) {
        if (request === 'vscode') { return 'vscode'; }
        return origResolveFilename(request, ...rest);
    };

    // Populate the cache
    require.cache['vscode'] = {
        id:       'vscode',
        filename: 'vscode',
        loaded:   true,
        exports:  mockVscode,
        paths:    [],
    };
}

function restore() {
    if (!_active) { return; }
    _active = false;
    Module._resolveFilename = origResolveFilename;
    delete require.cache['vscode'];
}

module.exports = { setup, restore, mockVscode, mockWindow, mockWorkspace };
