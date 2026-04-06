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
    _warnChoices:   [],   // same pattern for showWarningMessage button selection
    // ── QuickPick simulation ─────────────────────────────────────────────────
    // Push 'allow' | 'defer' | 'help' | null (null = Escape/dismiss) before
    // the test that triggers maybeHandleKillApprovalPrompt.  The mock's show()
    // pulls one entry per createQuickPick() call and fires the appropriate
    // onDidAccept / onDidHide handler synchronously, exactly as VS Code does.
    _quickPickChoices: [],
    _lastQuickPick:    null,

    reset() {
        this._infoMessages     = [];
        this._errorMessages    = [];
        this._warnMessages     = [];
        this._infoChoices      = [];
        this._warnChoices      = [];
        this._quickPickChoices = [];
        this._lastQuickPick    = null;
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
    showWarningMessage(msg, ...buttons) {
        this._warnMessages.push(msg);
        const next = this._warnChoices.shift();
        if (typeof next === 'string' && buttons.length > 0) {
            const hit = buttons.find((b) => (typeof b === 'string' ? b === next : b && b.title === next));
            if (hit) { return Promise.resolve(hit); }
        }
        return Promise.resolve(next || undefined);
    },
    createOutputChannel() {
        return { appendLine() {}, clear() {}, show() {}, dispose() {} };
    },
    createStatusBarItem() {
        return { text: '', color: '', tooltip: '', show() {}, dispose() {} };
    },
    /**
     * QuickPick mock — mirrors the VS Code createQuickPick() contract.
     *
     * Behaviour in show():
     *   • If _quickPickChoices has an entry whose value matches a QuickPickItem's
     *     .value property, selectedItems is set and onDidAccept fires (then
     *     onDidHide fires via qp.hide() called inside the real accept handler).
     *   • null or no entry → Escape / dismiss → onDidHide fires directly.
     *
     * The _resolved guard in the real extension code prevents double-resolution,
     * so firing both handlers in sequence is safe and correctly mirrors VS Code.
     */
    createQuickPick() {
        const self = mockWindow;
        const qp = {
            title:          '',
            placeholder:    '',
            ignoreFocusOut: false,
            items:          [],
            selectedItems:  [],
            _onAccept:      null,
            _onHide:        null,
            onDidAccept(fn) { qp._onAccept = fn; return { dispose() {} }; },
            onDidHide(fn)   { qp._onHide   = fn; return { dispose() {} }; },
            hide()   { if (qp._onHide) { qp._onHide(); } },
            dispose() {},
            show() {
                const choice = self._quickPickChoices.shift();
                if (choice !== undefined && choice !== null) {
                    const found = qp.items.find((i) => i.value === choice);
                    if (found) {
                        qp.selectedItems = [found];
                        // Accept fires first; the real onDidAccept calls qp.hide()
                        // which triggers onDidHide — same sequence here.
                        if (qp._onAccept) { qp._onAccept(); }
                        // onDidHide triggered by hide() inside the accept handler;
                        // nothing more to do here.
                    } else {
                        // Unknown value → treat as dismiss
                        if (qp._onHide) { qp._onHide(); }
                    }
                } else {
                    // null or nothing in queue → Escape / dismiss
                    if (qp._onHide) { qp._onHide(); }
                }
            },
        };
        self._lastQuickPick = qp;
        return qp;
    },
    visibleTextEditors: [],
    showTextDocument(doc) {
        this._shownDocuments = this._shownDocuments || [];
        this._shownDocuments.push(doc);
        return Promise.resolve(doc);
    },
};

const mockWorkspace = {
    _configValues: {},
    reset() { this._configValues = {}; },
    workspaceFolders: [],
    getConfiguration(/* section */) {
        const vals = mockWorkspace._configValues;
        return {
            get(key, defaultValue) {
                return Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : defaultValue;
            },
        };
    },
    onDidChangeConfiguration() { return { dispose() {} }; },
    openTextDocument(filePath) { return Promise.resolve({ uri: { fsPath: filePath } }); },
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
        _executedCommands: [],
        registerCommand(id, handler) { return { dispose() {} }; },
        executeCommand(...args) {
            this._executedCommands.push(args);
            return Promise.resolve();
        },
        reset() { this._executedCommands = []; },
    },
    Uri: {
        parse(str) { return { toString: () => str }; },
    },
    env: {
        openExternal() { return Promise.resolve(true); },
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
