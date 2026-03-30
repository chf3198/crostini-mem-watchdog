// optimizer.js — VS Code memory optimization for constrained systems
// ─────────────────────────────────────────────────────────────────────────────
// Defines a recommended low-memory profile for settings.json and argv.json,
// audits the current configuration against it, and applies missing changes.
//
// Used by:
//   - memWatchdog.optimizeMemory command (commands.js)
//   - /memwatchdog optimize chat command (chatParticipant.js)
//
// Design:
//   Settings are applied via the VS Code API (vscode.workspace.getConfiguration)
//   so they survive profiles, sync, and precedence rules.  argv.json is written
//   directly because there is no VS Code API for runtime flags.
//
// All savings estimates are empirical ranges observed on Crostini (6.3 GB RAM,
// no hardware GPU, kernel 6.6.99).  Actual savings vary by workload.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Recommended low-memory profile ────────────────────────────────────────────
// Each entry: { value, savings, reason }.
// Only settings that meaningfully reduce memory on constrained systems.
// Ordered by estimated impact (highest first within each category).

const SETTINGS_PROFILE = {
    // ── Editor rendering ──────────────────────────────────────────────────────
    'editor.minimap.enabled':                    { value: false,    savings: '~10-20 MB',  reason: 'Eliminates minimap canvas rendering and layout computation' },
    'editor.codeLens':                           { value: false,    savings: '~10-20 MB',  reason: 'Disables CodeLens reference counts (per-file symbol resolution)' },
    'editor.inlayHints.enabled':                 { value: 'off',    savings: '~5-10 MB',   reason: 'Disables inlay type hints (TypeScript/language server overhead)' },
    'editor.stickyScroll.enabled':               { value: false,    savings: '~5-10 MB',   reason: 'Disables sticky scroll context headers' },
    'editor.bracketPairColorization.enabled':     { value: false,    savings: '~5 MB',      reason: 'Disables bracket pair colorization computation' },
    'editor.occurrencesHighlight':               { value: 'off',    savings: '~2-5 MB',    reason: 'Disables symbol occurrence highlighting on cursor move' },
    'editor.renderLineHighlight':                { value: 'gutter', savings: '~2 MB',      reason: 'Reduces line highlight rendering to gutter only' },
    'editor.suggest.preview':                    { value: false,    savings: '~2 MB',      reason: 'Disables inline suggestion preview rendering' },
    'editor.hover.delay':                        { value: 500,      savings: '~2 MB',      reason: 'Delays hover computation (reduces transient allocations)' },
    'breadcrumbs.enabled':                       { value: false,    savings: '~2 MB',      reason: 'Disables breadcrumb navigation bar' },

    // ── Workbench / lifecycle ─────────────────────────────────────────────────
    'workbench.editor.limit.enabled':            { value: true,     savings: '~50-200 MB', reason: 'Caps the number of open editor tabs' },
    'workbench.editor.limit.value':              { value: 8,        savings: '(see above)', reason: 'Maximum 8 open editors — each tab holds a text model in memory' },
    'window.restoreWindows':                     { value: 'none',   savings: '~100-500 MB', reason: 'Prevents restoring previous session editors on startup' },
    'workbench.startupEditor':                   { value: 'none',   savings: '~10 MB',     reason: 'Skips the welcome / walkthrough page' },

    // ── File watching (kernel memory) ─────────────────────────────────────────
    'files.watcherExclude': {
        value: {
            '**/.git/objects/**': true,
            '**/.git/subtree-cache/**': true,
            '**/node_modules/**': true,
            '**/.playwright-mcp/**': true,
            '**/dist/**': true,
            '**/.cache/**': true,
            '**/build/**': true,
            '**/.next/**': true,
            '**/.venv/**': true,
        },
        savings: '~50-540 MB (kernel)',
        reason: 'Each inotify watch = 1,080 bytes kernel memory; excludes large trees',
    },
    'search.exclude': {
        value: {
            '**/node_modules': true,
            '**/.playwright-mcp': true,
            '**/.git': true,
            '**/dist': true,
            '**/build': true,
        },
        savings: '~10-50 MB',
        reason: 'Excludes large directories from search indexing',
    },

    // ── Extensions ────────────────────────────────────────────────────────────
    'extensions.autoUpdate':                     { value: false,    savings: '~10 MB',  reason: 'Prevents background extension update downloads' },
    'extensions.autoCheckUpdates':               { value: false,    savings: '~5 MB',   reason: 'Prevents periodic Marketplace polling' },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    'telemetry.telemetryLevel':                  { value: 'off',    savings: '~5-10 MB', reason: 'Disables telemetry collection and upload' },

    // ── TypeScript ────────────────────────────────────────────────────────────
    'typescript.tsserver.maxTsServerMemory':     { value: 768,      savings: '~200-500 MB', reason: 'Caps each TypeScript server process (MB)' },
    'typescript.disableAutomaticTypeAcquisition': { value: true,    savings: '~20-50 MB',  reason: 'Prevents auto-downloading @types packages' },

    // ── Git ───────────────────────────────────────────────────────────────────
    'git.autoFetch':                             { value: false,    savings: '~10-20 MB', reason: 'Prevents periodic background git fetch' },
    'git.decorations.enabled':                   { value: false,    savings: '~5-10 MB',  reason: 'Disables git status decorations in file explorer' },

    // ── Python (for systems with Pylance) ─────────────────────────────────────
    'python.analysis.diagnosticMode':            { value: 'openFilesOnly', savings: '~30-100 MB', reason: 'Limits Pylance analysis to open files' },
    'python.analysis.indexing':                  { value: false,    savings: '~20-50 MB',  reason: 'Disables Pylance workspace indexing' },
    'python.analysis.typeCheckingMode':          { value: 'off',    savings: '~10-30 MB',  reason: 'Disables Pylance type checking' },
    'python.analysis.autoImportCompletions':     { value: false,    savings: '~10-20 MB',  reason: 'Disables Pylance auto-import suggestions' },
};

// ── argv.json profile ─────────────────────────────────────────────────────────
// These require a VS Code restart to take effect.  Written directly to the file.
const ARGV_PROFILE = {
    'disable-hardware-acceleration': {
        value: true,
        savings: '~100-200 MB',
        reason: 'Eliminates the GPU process (Crostini has no hardware GPU — all compositing is software)',
    },
    'js-flags': {
        value: '--max-old-space-size=2048',
        savings: 'Prevents GC thrash',
        reason: 'V8 heap cap at 2 GB — lower values cause GC thrash that paradoxically increases total RSS',
    },
};

// ── argv.json path ────────────────────────────────────────────────────────────
const ARGV_PATH = path.join(os.homedir(), '.config', 'Code', 'argv.json');

// ── Audit ─────────────────────────────────────────────────────────────────────

/**
 * Compare a value against the profile target.
 * For objects (like watcherExclude), check that all profile keys are present.
 * For primitives, check strict equality.
 *
 * @param {*} current  — the current setting value
 * @param {*} target   — the profile target value
 * @returns {boolean}  — true if current already matches the profile
 */
function settingMatches(current, target) {
    if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
        // Object: check that every key in the target exists in current with same value
        if (current === null || typeof current !== 'object') { return false; }
        for (const key of Object.keys(target)) {
            if (current[key] !== target[key]) { return false; }
        }
        return true;
    }
    return current === target;
}

/**
 * Audit current VS Code settings against the low-memory profile.
 *
 * @param {import('vscode').WorkspaceConfiguration|object} cfg
 *        If running inside VS Code: vscode.workspace.getConfiguration()
 *        If running in tests: a plain object with .get(key, default) and
 *        .inspect(key) methods.
 * @returns {{ applied: Array<{key: string, savings: string}>, missing: Array<{key: string, value: *, savings: string, reason: string}> }}
 */
function auditSettings(cfg) {
    const applied = [];
    const missing = [];

    for (const [key, profile] of Object.entries(SETTINGS_PROFILE)) {
        const current = cfg.get(key);
        if (settingMatches(current, profile.value)) {
            applied.push({ key, savings: profile.savings });
        } else {
            missing.push({ key, value: profile.value, currentValue: current, savings: profile.savings, reason: profile.reason });
        }
    }
    return { applied, missing };
}

/**
 * Audit argv.json against the profile.
 *
 * @param {string} [argvPath]  — override for testing
 * @returns {{ applied: Array<{key: string, savings: string}>, missing: Array<{key: string, value: *, savings: string, reason: string}>, argvContent: object|null }}
 */
function auditArgv(argvPath) {
    const filePath = argvPath || ARGV_PATH;
    let argv = null;
    try {
        // argv.json may contain comments — strip // comments before parsing
        const raw = fs.readFileSync(filePath, 'utf8');
        const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
        argv = JSON.parse(stripped);
    } catch {
        // File missing or unparseable
    }

    const applied = [];
    const missing = [];

    for (const [key, profile] of Object.entries(ARGV_PROFILE)) {
        if (argv && argv[key] === profile.value) {
            applied.push({ key, savings: profile.savings });
        } else {
            missing.push({
                key,
                value: profile.value,
                currentValue: argv ? argv[key] : undefined,
                savings: profile.savings,
                reason: profile.reason,
            });
        }
    }
    return { applied, missing, argvContent: argv };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply missing settings via the VS Code API.
 *
 * @param {import('vscode')} vscodeApi — the vscode module
 * @param {Array<{key: string, value: *}>} missingSettings — from auditSettings()
 * @returns {Promise<number>} — count of settings applied
 */
async function applySettings(vscodeApi, missingSettings) {
    let count = 0;
    for (const { key, value } of missingSettings) {
        try {
            const cfg = vscodeApi.workspace.getConfiguration();
            // For object-type settings (watcherExclude, search.exclude), merge
            // the profile values into the existing object rather than replacing.
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                const current = cfg.get(key) || {};
                const merged = { ...current, ...value };
                await cfg.update(key, merged, vscodeApi.ConfigurationTarget.Global);
            } else {
                await cfg.update(key, value, vscodeApi.ConfigurationTarget.Global);
            }
            count++;
        } catch (err) {
            console.error(`[memWatchdog] optimizer: failed to set ${key}: ${err.message}`);
        }
    }
    return count;
}

/**
 * Apply missing argv.json entries.  Returns true if any changes were made
 * (caller should warn user to restart VS Code).
 *
 * @param {Array<{key: string, value: *}>} missingArgv — from auditArgv()
 * @param {object|null} argvContent — parsed argv.json from auditArgv()
 * @param {string} [argvPath]  — override for testing
 * @returns {boolean} — true if file was modified
 */
function applyArgv(missingArgv, argvContent, argvPath) {
    if (missingArgv.length === 0) { return false; }

    const filePath = argvPath || ARGV_PATH;
    const argv = argvContent || {};

    for (const { key, value } of missingArgv) {
        argv[key] = value;
    }

    try {
        fs.writeFileSync(filePath, JSON.stringify(argv, null, 2) + '\n', 'utf8');
        return true;
    } catch (err) {
        console.error(`[memWatchdog] optimizer: failed to write argv.json: ${err.message}`);
        return false;
    }
}

// ── Report rendering ──────────────────────────────────────────────────────────

/**
 * Render a human-readable optimization report.
 *
 * @param {{ applied: Array, missing: Array }} settingsAudit
 * @param {{ applied: Array, missing: Array }} argvAudit
 * @returns {string} — markdown-formatted report
 */
function renderReport(settingsAudit, argvAudit) {
    const lines = ['### Memory Optimization Audit', ''];

    const totalApplied = settingsAudit.applied.length + argvAudit.applied.length;
    const totalMissing = settingsAudit.missing.length + argvAudit.missing.length;
    const totalChecked = totalApplied + totalMissing;

    lines.push(`**${totalApplied}/${totalChecked}** optimizations already applied.`);

    if (totalMissing === 0) {
        lines.push('');
        lines.push('✅ Your VS Code is fully optimized for low memory. No changes needed.');
        return lines.join('\n');
    }

    lines.push(`**${totalMissing}** optimization(s) available:`);
    lines.push('');

    if (argvAudit.missing.length > 0) {
        lines.push('#### argv.json (requires restart)');
        for (const m of argvAudit.missing) {
            lines.push(`- \`${m.key}\` → \`${JSON.stringify(m.value)}\` — ${m.savings}`);
            lines.push(`  *${m.reason}*`);
        }
        lines.push('');
    }

    if (settingsAudit.missing.length > 0) {
        lines.push('#### settings.json');
        for (const m of settingsAudit.missing) {
            const val = typeof m.value === 'object'
                ? '(merge profile keys)'
                : JSON.stringify(m.value);
            lines.push(`- \`${m.key}\` → \`${val}\` — ${m.savings}`);
            lines.push(`  *${m.reason}*`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

module.exports = {
    SETTINGS_PROFILE,
    ARGV_PROFILE,
    ARGV_PATH,
    settingMatches,
    auditSettings,
    auditArgv,
    applySettings,
    applyArgv,
    renderReport,
};
