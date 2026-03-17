'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installGlobalSkill, SKILL_NAME } = require('../../skillInstaller');

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('skillInstaller.installGlobalSkill()', () => {
    test('installs on first run and updates on second run', () => {
        const extRoot = mkTmp('mw-ext-');
        const homeDir = mkTmp('mw-home-');

        const srcDir = path.join(extRoot, 'skills', SKILL_NAME);
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '# skill\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'watchdog-snapshot.sh'), '#!/usr/bin/env bash\necho ok\n', 'utf8');

        const first = installGlobalSkill(extRoot, { homeDir });
        assert.equal(first.state, 'installed');

        const destSkill = path.join(homeDir, '.copilot', 'skills', SKILL_NAME, 'SKILL.md');
        assert.equal(fs.existsSync(destSkill), true);

        // Change source and run again -> updated
        fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '# skill v2\n', 'utf8');
        const second = installGlobalSkill(extRoot, { homeDir });
        assert.equal(second.state, 'updated');

        const copied = fs.readFileSync(destSkill, 'utf8');
        assert.equal(copied.includes('v2'), true);
    });

    test('skips when bundled skill is missing', () => {
        const extRoot = mkTmp('mw-ext-empty-');
        const homeDir = mkTmp('mw-home-empty-');

        const result = installGlobalSkill(extRoot, { homeDir });
        assert.equal(result.state, 'skipped');
        assert.equal(typeof result.reason, 'string');
    });
});
