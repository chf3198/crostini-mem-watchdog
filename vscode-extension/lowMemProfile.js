'use strict';

const LOWMEM_PROFILE_NAME = 'MemWatchdog LowMem';
const PROFILE_THRESHOLD_COUNT = 15;

const KNOWN_EXTENSIONS = {
    'curtisfranks.mem-watchdog-status': {
        tier: 'essential',
        impactMB: [5, 10],
        rationale: 'This extension manages the watchdog, status bar, and low-memory workflow.',
    },
    'github.copilot': {
        tier: 'essential',
        impactMB: [40, 90],
        rationale: 'Core AI coding assistance for this workflow.',
    },
    'github.copilot-chat': {
        tier: 'essential',
        impactMB: [80, 150],
        rationale: 'Primary chat/agent surface for Copilot-driven work.',
    },
    'dbaeumer.vscode-eslint': {
        tier: 'moderate',
        impactMB: [20, 40],
        rationale: 'Helpful during JS/TS work, but not always required in a reduced profile.',
    },
    'esbenp.prettier-vscode': {
        tier: 'moderate',
        impactMB: [15, 30],
        rationale: 'Formatter convenience extension; safe to disable when memory is tight.',
    },
    'ms-python.python': {
        tier: 'moderate',
        impactMB: [40, 90],
        rationale: 'Useful for Python repos, but not essential for every workspace.',
    },
    'ms-python.vscode-pylance': {
        tier: 'moderate',
        impactMB: [60, 120],
        rationale: 'Language intelligence is valuable but can be disabled outside Python-heavy sessions.',
    },
    'eamodio.gitlens': {
        tier: 'heavy',
        impactMB: [40, 90],
        rationale: 'Git graphing, blame, and repository indexing add steady extension-host overhead.',
    },
    'ms-azuretools.vscode-docker': {
        tier: 'heavy',
        impactMB: [30, 70],
        rationale: 'Docker views and background scans are expensive on constrained machines.',
    },
    'ms-vscode-remote.remote-ssh': {
        tier: 'heavy',
        impactMB: [40, 90],
        rationale: 'Remote session helpers are unnecessary in a local low-memory profile.',
    },
    'ms-vscode-remote.remote-ssh-edit': {
        tier: 'heavy',
        impactMB: [20, 50],
        rationale: 'Remote editing helpers are non-essential for local constrained sessions.',
    },
    'ms-vscode-remote.remote-containers': {
        tier: 'heavy',
        impactMB: [40, 90],
        rationale: 'Dev Containers integrations add extra background services and views.',
    },
    'ms-kubernetes-tools.vscode-kubernetes-tools': {
        tier: 'heavy',
        impactMB: [35, 75],
        rationale: 'Kubernetes cluster tooling is costly when not actively in use.',
    },
    'ms-toolsai.jupyter': {
        tier: 'heavy',
        impactMB: [120, 220],
        rationale: 'Notebook and kernel integrations are one of the heaviest common extension stacks.',
    },
};

function isBuiltinExtension(extension) {
    if (!extension) { return false; }
    if (extension.packageJSON && extension.packageJSON.isBuiltin) { return true; }
    return typeof extension.id === 'string' && extension.id.toLowerCase().startsWith('vscode.');
}

function humanName(extension) {
    return extension?.packageJSON?.displayName || extension?.packageJSON?.name || extension?.id || 'unknown';
}

function normalizeId(extension) {
    return String(extension?.id || '').toLowerCase();
}

function classifyExtension(extension) {
    const id = normalizeId(extension);
    const displayName = humanName(extension);

    if (!id) {
        return {
            id: '',
            displayName,
            tier: 'moderate',
            impactMB: [10, 25],
            rationale: 'Unknown extension metadata — treat as a moderate candidate.',
            isBuiltin: false,
            canDisable: true,
        };
    }

    const known = KNOWN_EXTENSIONS[id];
    if (known) {
        return {
            id,
            displayName,
            tier: known.tier,
            impactMB: known.impactMB,
            rationale: known.rationale,
            isBuiltin: isBuiltinExtension(extension),
            canDisable: known.tier !== 'essential' && !isBuiltinExtension(extension),
        };
    }

    const categories = Array.isArray(extension?.packageJSON?.categories)
        ? extension.packageJSON.categories.map(c => String(c).toLowerCase())
        : [];

    if (/(gitlens|remote|docker|kubernetes|jupyter)/.test(id)) {
        return {
            id,
            displayName,
            tier: 'heavy',
            impactMB: [30, 90],
            rationale: 'Remote, container, SCM graph, or notebook tooling is typically expensive when idle.',
            isBuiltin: isBuiltinExtension(extension),
            canDisable: !isBuiltinExtension(extension),
        };
    }

    if (categories.includes('programming languages')) {
        return {
            id,
            displayName,
            tier: 'moderate',
            impactMB: [15, 40],
            rationale: 'Language support is useful, but unused language extensions can often be disabled in a reduced profile.',
            isBuiltin: isBuiltinExtension(extension),
            canDisable: !isBuiltinExtension(extension),
        };
    }

    if (categories.includes('formatters') || /(prettier|eslint|lint)/.test(id)) {
        return {
            id,
            displayName,
            tier: 'moderate',
            impactMB: [15, 35],
            rationale: 'Formatting and linting helpers are convenient but optional in a low-memory profile.',
            isBuiltin: isBuiltinExtension(extension),
            canDisable: !isBuiltinExtension(extension),
        };
    }

    return {
        id,
        displayName,
        tier: 'moderate',
        impactMB: [10, 25],
        rationale: 'Unclassified user extension — treat as a moderate memory candidate.',
        isBuiltin: isBuiltinExtension(extension),
        canDisable: !isBuiltinExtension(extension),
    };
}

function analyzeInstalledExtensions(installedExtensions = []) {
    const userExtensions = installedExtensions
        .filter(Boolean)
        .filter(ext => !isBuiltinExtension(ext))
        .map(ext => ({
            ...classifyExtension(ext),
            version: ext.packageJSON?.version,
        }));

    const priority = { heavy: 0, moderate: 1, essential: 2 };
    userExtensions.sort((a, b) => {
        const pa = priority[a.tier] ?? 9;
        const pb = priority[b.tier] ?? 9;
        if (pa !== pb) { return pa - pb; }
        const aImpact = a.impactMB[1] || 0;
        const bImpact = b.impactMB[1] || 0;
        if (aImpact !== bImpact) { return bImpact - aImpact; }
        return a.displayName.localeCompare(b.displayName);
    });

    const totals = { essential: 0, moderate: 0, heavy: 0 };
    let minSavingsMB = 0;
    let maxSavingsMB = 0;
    const recommendedDisableIds = [];

    for (const ext of userExtensions) {
        totals[ext.tier] = (totals[ext.tier] || 0) + 1;
        if (ext.tier === 'heavy' && ext.canDisable) {
            minSavingsMB += ext.impactMB[0];
            maxSavingsMB += ext.impactMB[1];
            recommendedDisableIds.push(ext.id);
        }
    }

    return {
        profileName: LOWMEM_PROFILE_NAME,
        threshold: PROFILE_THRESHOLD_COUNT,
        totalUserExtensions: userExtensions.length,
        totals,
        estimatedSavingsMB: { min: minSavingsMB, max: maxSavingsMB },
        recommendProfile: userExtensions.length > PROFILE_THRESHOLD_COUNT || recommendedDisableIds.length > 0,
        recommendedDisableIds,
        extensions: userExtensions,
    };
}

function summarizeAnalysis(analysis) {
    return `${analysis.totalUserExtensions} user extensions installed ` +
        `(${analysis.totals.essential} essential, ${analysis.totals.moderate} moderate, ${analysis.totals.heavy} heavy). ` +
        `Heavy-extension savings estimate: ~${analysis.estimatedSavingsMB.min}-${analysis.estimatedSavingsMB.max} MB.`;
}

function renderLowMemReport(analysis) {
    const lines = [
        '### Low-Memory Profile Audit',
        '',
        `- Installed user extensions: **${analysis.totalUserExtensions}**`,
        `- Tier split: **${analysis.totals.essential} essential / ${analysis.totals.moderate} moderate / ${analysis.totals.heavy} heavy**`,
        `- Heavy-extension savings estimate: **~${analysis.estimatedSavingsMB.min}-${analysis.estimatedSavingsMB.max} MB**`,
        '',
    ];

    if (!analysis.extensions.length) {
        lines.push('No user-installed extensions detected.');
        return lines.join('\n');
    }

    if (analysis.recommendedDisableIds.length > 0) {
        lines.push('**Recommended disable set for a LowMem profile**');
        for (const ext of analysis.extensions.filter(e => analysis.recommendedDisableIds.includes(e.id))) {
            lines.push(`- **${ext.displayName}** (${ext.id}) — ~${ext.impactMB[0]}-${ext.impactMB[1]} MB · ${ext.rationale}`);
        }
        lines.push('');
    } else {
        lines.push('No clearly heavy extensions detected; a LowMem profile is optional for this install set.');
        lines.push('');
    }

    lines.push('**Keep enabled**');
    for (const ext of analysis.extensions.filter(e => e.tier === 'essential')) {
        lines.push(`- **${ext.displayName}** (${ext.id}) — ${ext.rationale}`);
    }

    return lines.join('\n');
}

async function showRecommendedExtensions(vscodeApi, analysis) {
    if (!analysis.recommendedDisableIds.length) { return false; }
    await vscodeApi.commands.executeCommand(
        'workbench.extensions.action.showExtensionsWithIds',
        analysis.recommendedDisableIds,
    );
    return true;
}

async function applyRecommendedDisableSet(vscodeApi, analysis) {
    if (!analysis.recommendedDisableIds.length) { return 0; }

    let disabled = 0;
    for (const id of analysis.recommendedDisableIds) {
        await vscodeApi.commands.executeCommand('extension.open', id);
        await vscodeApi.commands.executeCommand('extensions.disableGlobally');
        disabled++;
    }
    return disabled;
}

async function createLowMemProfile(vscodeApi) {
    const analysis = analyzeInstalledExtensions(vscodeApi.extensions?.all || []);

    if (analysis.totalUserExtensions === 0) {
        await vscodeApi.window.showInformationMessage(
            'Mem Watchdog: no user-installed extensions found — a LowMem profile is not needed.'
        );
        return analysis;
    }

    const detail = [
        summarizeAnalysis(analysis),
        '',
        `Recommended profile name: ${analysis.profileName}`,
        'Create the profile from your current setup, switch into it, then apply the recommended disable set there.',
    ].join('\n');

    const actions = [
        'Create From Current Profile',
        'Switch Profile',
        'Show Recommendations',
    ];
    if (analysis.recommendedDisableIds.length > 0) {
        actions.unshift('Apply Recommended Set Here');
    }

    const choice = await vscodeApi.window.showInformationMessage(
        `Mem Watchdog: ${summarizeAnalysis(analysis)}`,
        { modal: true, detail },
        ...actions,
    );

    if (choice === 'Create From Current Profile') {
        await vscodeApi.commands.executeCommand('workbench.profiles.actions.createFromCurrentProfile');
        await vscodeApi.window.showInformationMessage(
            `Mem Watchdog: create a profile named "${analysis.profileName}", switch to it, then rerun this command and choose “Apply Recommended Set Here”.`
        );
        return analysis;
    }

    if (choice === 'Switch Profile') {
        await vscodeApi.commands.executeCommand('workbench.profiles.actions.switchProfile');
        return analysis;
    }

    if (choice === 'Show Recommendations') {
        const opened = await showRecommendedExtensions(vscodeApi, analysis);
        if (!opened) {
            await vscodeApi.window.showInformationMessage('Mem Watchdog: no heavy extensions to recommend.');
        }
        return analysis;
    }

    if (choice === 'Apply Recommended Set Here') {
        const disabled = await applyRecommendedDisableSet(vscodeApi, analysis);
        if (disabled > 0) {
            const reload = await vscodeApi.window.showInformationMessage(
                `Mem Watchdog: disabled ${disabled} heavy extension(s) in the current profile. Reload VS Code to reclaim the extension-host memory.`,
                'Reload Window',
                'Later'
            );
            if (reload === 'Reload Window') {
                await vscodeApi.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
        return analysis;
    }

    return analysis;
}

module.exports = {
    LOWMEM_PROFILE_NAME,
    PROFILE_THRESHOLD_COUNT,
    KNOWN_EXTENSIONS,
    classifyExtension,
    analyzeInstalledExtensions,
    summarizeAnalysis,
    renderLowMemReport,
    showRecommendedExtensions,
    applyRecommendedDisableSet,
    createLowMemProfile,
};
