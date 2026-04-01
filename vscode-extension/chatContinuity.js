'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const WORKSPACE_STORAGE_DIR = path.join(XDG_CONFIG, 'Code', 'User', 'workspaceStorage');
const ARCHIVE_ROOT = path.join(XDG_CONFIG, 'mem-watchdog', 'chat-archives');
const DEFAULT_SESSION_THRESHOLD_MB = 120;
const DEFAULT_ACTIVE_WINDOW_HOURS = 168;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

function formatBytes(bytes) {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
    if (bytes < 1024 * 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeReadDir(dirPath) {
    try { return fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return []; }
}

function listChatSessions(rootDir = WORKSPACE_STORAGE_DIR) {
    const sessions = [];
    for (const entry of safeReadDir(rootDir)) {
        if (!entry.isDirectory()) { continue; }
        const workspaceId = entry.name;
        const chatDir = path.join(rootDir, workspaceId, 'chatSessions');
        for (const child of safeReadDir(chatDir)) {
            if (!child.isFile() || !child.name.endsWith('.json')) { continue; }
            const filePath = path.join(chatDir, child.name);
            try {
                const stat = fs.statSync(filePath);
                sessions.push({
                    workspaceId,
                    name: child.name,
                    filePath,
                    sizeBytes: stat.size,
                    mtimeMs: stat.mtimeMs,
                });
            } catch {
                // ignore disappearing session files
            }
        }
    }
    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || b.sizeBytes - a.sizeBytes);
}

function findRescueCandidate(options = {}) {
    const thresholdBytes = (options.thresholdMB || DEFAULT_SESSION_THRESHOLD_MB) * 1024 * 1024;
    const maxAgeMs = (options.activeWindowHours || DEFAULT_ACTIVE_WINDOW_HOURS) * 60 * 60 * 1000;
    const now = Date.now();
    return listChatSessions(options.rootDir).find((session) => (
        session.sizeBytes >= thresholdBytes && now - session.mtimeMs <= maxAgeMs
    )) || null;
}

function readSlice(filePath, start, length) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, start);
        return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function readHeadTail(filePath) {
    const stat = fs.statSync(filePath);
    const head = readSlice(filePath, 0, Math.min(HEAD_BYTES, stat.size));
    const tailBytes = Math.min(TAIL_BYTES, stat.size);
    const tailStart = Math.max(0, stat.size - tailBytes);
    const tail = readSlice(filePath, tailStart, tailBytes);
    return { sizeBytes: stat.size, head, tail };
}

function decodeJsonString(value) {
    try {
        return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    } catch {
        return value
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\"/g, '"');
    }
}

function extractSnippets(raw, limit = 8) {
    const snippets = [];
    const seen = new Set();
    const regex = /"(?:prompt|message|text|query|title|body)"\s*:\s*"((?:\\.|[^"\\]){40,2400})"/g;
    let match;
    while ((match = regex.exec(raw)) && snippets.length < limit) {
        const decoded = decodeJsonString(match[1])
            .replace(/\s+/g, ' ')
            .trim();
        if (decoded.length < 30) { continue; }
        const compact = decoded.slice(0, 240);
        if (seen.has(compact)) { continue; }
        seen.add(compact);
        snippets.push(compact);
    }
    return snippets;
}

function summarizeWorkspace(vscode) {
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri?.fsPath || f.name).filter(Boolean);
    const visibleEditors = (vscode.window.visibleTextEditors || []).map(e => e.document?.uri?.fsPath).filter(Boolean);
    return { workspaceFolders, visibleEditors };
}

function tryGitStatus(folder) {
    if (!folder || !fs.existsSync(folder)) { return []; }
    try {
        const output = execFileSync('git', ['-C', folder, 'status', '--short'], {
            encoding: 'utf8', timeout: 3000,
        }).trim();
        return output ? output.split('\n').slice(0, 20) : [];
    } catch {
        return [];
    }
}

function renderContinuityPack({ session, archiveDir, snippets, workspaceFolders, visibleEditors, gitStatus }) {
    const lines = [
        '# Mem Watchdog Continuity Pack',
        '',
        'This session was rescued because the active Copilot chat history became large enough to risk an extension-host restart loop.',
        '',
        '## Archived session',
        '',
        `- Original path: ${session.filePath}`,
        `- Archived path: ${path.join(archiveDir, 'session-original.json')}`,
        `- Size: ${formatBytes(session.sizeBytes)}`,
        `- Last modified: ${new Date(session.mtimeMs).toISOString()}`,
        '',
        '## Workspace context',
        '',
        ...workspaceFolders.map(folder => `- Workspace: ${folder}`),
        ...visibleEditors.map(file => `- Visible editor: ${file}`),
        ...(gitStatus.length > 0 ? ['', '## Current git status', '', ...gitStatus.map(line => `- ${line}`)] : []),
        '',
        '## Recovered chat clues',
        '',
        ...(snippets.length > 0 ? snippets.map(snippet => `- ${snippet}`) : ['- No structured snippets could be extracted safely from the archived JSON tail.']),
        '',
        '## Resume strategy',
        '',
        '- Start a fresh chat session.',
        '- Paste the resume prompt from `resume.prompt.md`.',
        '- Attach or inspect `session-original.json` only if you need forensic detail.',
        '',
    ];
    return lines.join('\n') + '\n';
}

function renderResumePrompt({ session, snippets, workspaceFolders, visibleEditors }) {
    const lines = [
        '# Resume Prompt',
        '',
        'Use this in a fresh Copilot chat to restore the working context with minimal memory footprint.',
        '',
        '```text',
        'We are resuming work after Mem Watchdog archived an oversized prior chat session to prevent an extension-host OOM loop.',
        `The archived session file is: ${session.filePath}`,
        'Please continue from the following objective and clues, but do not rely on the old chat history being loaded into memory.',
        '',
        'Objective: <fill in the current task objective here>',
        ...(workspaceFolders.length > 0 ? ['', 'Workspace folders:', ...workspaceFolders.map(f => `- ${f}`)] : []),
        ...(visibleEditors.length > 0 ? ['', 'Open files that were visible before rescue:', ...visibleEditors.map(f => `- ${f}`)] : []),
        ...(snippets.length > 0 ? ['', 'Recovered clues from the previous chat:', ...snippets.map(s => `- ${s}`)] : []),
        '',
        'First, restate the plan in a compact form. Then continue the task step-by-step with memory discipline.',
        '```',
        '',
    ];
    return lines.join('\n');
}

function pruneArchives(rootDir = ARCHIVE_ROOT, keep = 3) {
    const entries = safeReadDir(rootDir)
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const dirPath = path.join(rootDir, entry.name);
            try {
                return { dirPath, mtimeMs: fs.statSync(dirPath).mtimeMs };
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const extra of entries.slice(keep)) {
        fs.rmSync(extra.dirPath, { recursive: true, force: true });
    }
}

async function rescueSession(vscode, options = {}) {
    const session = options.session || findRescueCandidate({ thresholdMB: options.thresholdMB });
    if (!session) {
        return { ok: false, reason: 'no-candidate' };
    }

    const stamp = new Date().toISOString().replace(/[:]/g, '-');
    const archiveDir = path.join(ARCHIVE_ROOT, `${stamp}-${session.workspaceId}`);
    fs.mkdirSync(archiveDir, { recursive: true });

    const { head, tail } = readHeadTail(session.filePath);
    const snippets = extractSnippets(`${head}\n${tail}`);
    const { workspaceFolders, visibleEditors } = summarizeWorkspace(vscode);
    const gitStatus = tryGitStatus(workspaceFolders[0]);

    const archivedSessionPath = path.join(archiveDir, 'session-original.json');
    fs.renameSync(session.filePath, archivedSessionPath);

    const packPath = path.join(archiveDir, 'continuity-pack.md');
    const resumePath = path.join(archiveDir, 'resume.prompt.md');
    const metadataPath = path.join(archiveDir, 'metadata.json');

    fs.writeFileSync(packPath, renderContinuityPack({ session, archiveDir, snippets, workspaceFolders, visibleEditors, gitStatus }), 'utf8');
    fs.writeFileSync(resumePath, renderResumePrompt({ session, snippets, workspaceFolders, visibleEditors }), 'utf8');
    fs.writeFileSync(metadataPath, JSON.stringify({
        archivedAt: new Date().toISOString(),
        session,
        snippets,
        workspaceFolders,
        visibleEditors,
        gitStatus,
    }, null, 2) + '\n', 'utf8');

    pruneArchives(ARCHIVE_ROOT, options.keepArchives || 3);

    if (options.openResume !== false && vscode.workspace?.openTextDocument && vscode.window?.showTextDocument) {
        const doc = await vscode.workspace.openTextDocument(resumePath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    return {
        ok: true,
        session,
        archiveDir,
        archivedSessionPath,
        packPath,
        resumePath,
        snippets,
    };
}

module.exports = {
    ARCHIVE_ROOT,
    WORKSPACE_STORAGE_DIR,
    DEFAULT_SESSION_THRESHOLD_MB,
    listChatSessions,
    findRescueCandidate,
    extractSnippets,
    rescueSession,
    formatBytes,
};
