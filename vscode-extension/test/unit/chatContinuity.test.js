'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    listChatSessions,
    findRescueCandidate,
    extractSnippets,
    rescueSession,
} = require('../../chatContinuity');

function makeTempTree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-chat-'));
    const ws = path.join(dir, 'workspaceStorage', 'abc123', 'chatSessions');
    fs.mkdirSync(ws, { recursive: true });
    return { dir, ws };
}

describe('chatContinuity helpers', () => {
    test('listChatSessions finds session files', () => {
        const { dir, ws } = makeTempTree();
        const file = path.join(ws, 'session.json');
        fs.writeFileSync(file, '{"message":"hello world"}\n');

        const sessions = listChatSessions(path.join(dir, 'workspaceStorage'));
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].name, 'session.json');
    });

    test('findRescueCandidate respects threshold', () => {
        const { dir, ws } = makeTempTree();
        const file = path.join(ws, 'session.json');
        fs.writeFileSync(file, 'x'.repeat(3 * 1024 * 1024));

        const candidate = findRescueCandidate({ rootDir: path.join(dir, 'workspaceStorage'), thresholdMB: 1 });
        assert.ok(candidate);
        assert.equal(candidate.name, 'session.json');
    });

    test('extractSnippets recovers likely prompt text', () => {
        const raw = '{"message":"We are resuming the Squarespace publish work after the browser crashed and need to inspect the hero image flow."}';
        const snippets = extractSnippets(raw, 4);
        assert.equal(snippets.length, 1);
        assert.ok(snippets[0].includes('Squarespace publish work'));
    });

    test('rescueSession archives file and writes continuity pack', async () => {
        const { dir, ws } = makeTempTree();
        const file = path.join(ws, 'session.json');
        fs.writeFileSync(file, JSON.stringify({ message: 'Continue the memory watchdog daemon work with careful staged recovery and chat archival.' }));

        const shown = [];
        const vscode = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: '/tmp/example-workspace' } }],
                openTextDocument: async (filePath) => ({ uri: { fsPath: filePath } }),
            },
            window: {
                visibleTextEditors: [{ document: { uri: { fsPath: '/tmp/example-workspace/README.md' } } }],
                showTextDocument: async (doc) => { shown.push(doc.uri.fsPath); return doc; },
            },
        };

        const result = await rescueSession(vscode, {
            session: {
                workspaceId: 'abc123',
                name: 'session.json',
                filePath: file,
                sizeBytes: fs.statSync(file).size,
                mtimeMs: fs.statSync(file).mtimeMs,
            },
            keepArchives: 5,
        });

        assert.equal(result.ok, true);
        assert.ok(fs.existsSync(result.archivedSessionPath));
        assert.ok(fs.existsSync(result.packPath));
        assert.ok(fs.existsSync(result.resumePath));
        assert.ok(!fs.existsSync(file), 'original active session file should be moved out of chatSessions');
        assert.equal(shown.length, 1, 'resume prompt should be opened');
    });
});