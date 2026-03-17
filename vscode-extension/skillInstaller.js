'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_NAME = 'mem-watchdog-ops';

/**
 * Install/update the Mem Watchdog personal Copilot skill in ~/.copilot/skills.
 * Returns a simple state machine for caller UX:
 *   - installed: destination did not exist and is now created
 *   - updated: destination existed and was refreshed
 *   - skipped: bundled skill source is missing
 *
 * @param {string} extensionRoot absolute extension install root
 * @param {{ homeDir?: string, skillRelPath?: string }} [opts]
 * @returns {{ state: 'installed'|'updated'|'skipped', src?: string, dest?: string, reason?: string }}
 */
function installGlobalSkill(extensionRoot, opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const skillRelPath = opts.skillRelPath || path.join('skills', SKILL_NAME);

    const src = path.join(extensionRoot, skillRelPath);
    const srcSkill = path.join(src, 'SKILL.md');

    if (!fs.existsSync(srcSkill)) {
        return { state: 'skipped', reason: `missing ${srcSkill}` };
    }

    const destRoot = path.join(homeDir, '.copilot', 'skills');
    const dest = path.join(destRoot, SKILL_NAME);
    const hadExisting = fs.existsSync(path.join(dest, 'SKILL.md'));

    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });

    // Keep helper script executable if present.
    const helperScript = path.join(dest, 'watchdog-snapshot.sh');
    if (fs.existsSync(helperScript)) {
        fs.chmodSync(helperScript, 0o755);
    }

    return {
        state: hadExisting ? 'updated' : 'installed',
        src,
        dest,
    };
}

module.exports = {
    installGlobalSkill,
    SKILL_NAME,
};
