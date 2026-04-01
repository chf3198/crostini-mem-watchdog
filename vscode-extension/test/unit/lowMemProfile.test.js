'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    LOWMEM_PROFILE_NAME,
    PROFILE_THRESHOLD_COUNT,
    classifyExtension,
    analyzeInstalledExtensions,
    summarizeAnalysis,
    renderLowMemReport,
} = require('../../lowMemProfile');

function ext(id, displayName, categories = [], extra = {}) {
    return {
        id,
        packageJSON: {
            name: displayName || id,
            displayName: displayName || id,
            categories,
            ...extra,
        },
    };
}

describe('lowMemProfile — classifyExtension', () => {
    test('classifies GitLens as heavy', () => {
        const result = classifyExtension(ext('eamodio.gitlens', 'GitLens'));
        assert.equal(result.tier, 'heavy');
        assert.deepEqual(result.impactMB, [40, 90]);
        assert.equal(result.canDisable, true);
    });

    test('classifies Copilot and Mem Watchdog as essential', () => {
        assert.equal(classifyExtension(ext('github.copilot', 'GitHub Copilot')).tier, 'essential');
        assert.equal(classifyExtension(ext('CurtisFranks.mem-watchdog-status', 'Mem Watchdog')).tier, 'essential');
    });

    test('classifies language extensions as moderate by category heuristic', () => {
        const result = classifyExtension(ext('redhat.java', 'Language Support', ['Programming Languages']));
        assert.equal(result.tier, 'moderate');
        assert.deepEqual(result.impactMB, [15, 40]);
    });
});

describe('lowMemProfile — analyzeInstalledExtensions', () => {
    test('filters built-ins, sorts heavy first, and sums heavy savings', () => {
        const analysis = analyzeInstalledExtensions([
            ext('vscode.json-language-features', 'JSON', [], { isBuiltin: true }),
            ext('github.copilot', 'GitHub Copilot'),
            ext('eamodio.gitlens', 'GitLens'),
            ext('ms-azuretools.vscode-docker', 'Docker'),
            ext('dbaeumer.vscode-eslint', 'ESLint'),
        ]);

        assert.equal(analysis.totalUserExtensions, 4);
        assert.equal(analysis.extensions[0].id, 'eamodio.gitlens');
        assert.deepEqual(analysis.recommendedDisableIds, [
            'eamodio.gitlens',
            'ms-azuretools.vscode-docker',
        ]);
        assert.deepEqual(analysis.estimatedSavingsMB, { min: 70, max: 160 });
        assert.equal(analysis.recommendProfile, true);
    });

    test('recommends lowmem profile when installed extensions exceed threshold', () => {
        const installed = [];
        for (let index = 0; index < PROFILE_THRESHOLD_COUNT + 1; index++) {
            installed.push(ext(`sample.publisher-${index}`, `Ext ${index}`, ['Formatters']));
        }
        const analysis = analyzeInstalledExtensions(installed);
        assert.equal(analysis.totalUserExtensions, PROFILE_THRESHOLD_COUNT + 1);
        assert.equal(analysis.recommendProfile, true);
    });
});

describe('lowMemProfile — report rendering', () => {
    test('summarizeAnalysis and report include profile name and heavy recommendations', () => {
        const analysis = analyzeInstalledExtensions([
            ext('github.copilot', 'GitHub Copilot'),
            ext('eamodio.gitlens', 'GitLens'),
        ]);

        assert.ok(summarizeAnalysis(analysis).includes('user extensions installed'));
        const report = renderLowMemReport(analysis);
        assert.ok(report.includes('Low-Memory Profile Audit'));
        assert.ok(report.includes('GitLens'));
        assert.ok(report.includes(LOWMEM_PROFILE_NAME) === false);
        assert.ok(report.includes('Recommended disable set'));
    });
});
