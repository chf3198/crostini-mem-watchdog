// installer.js — daemon bundle detection + auto-install / auto-upgrade
// ─────────────────────────────────────────────────────────────────────────────
// Called from activate(). Compares the SHA-256 hash of the bundled
// mem-watchdog.sh against the hash stored in globalState. If they differ
// (first install or extension update), copies the daemon files to the user's
// systemd service directories and restarts the service.
//
// Why hash the script (not the service file)?
//   The .sh is the logic that changes between versions. The .service file
//   rarely changes and the same check covers both.
//
// Install paths:
//   ~/.local/bin/mem-watchdog.sh         ← executable daemon
//   ~/.config/systemd/user/mem-watchdog.service
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode  = require('vscode');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { exec } = require('child_process');

const STATE_HASH_KEY     = 'installedDaemonHash';
const INSTALL_BIN_DIR    = path.join(process.env.HOME || '/root', '.local',  'bin');
const INSTALL_SVC_DIR    = path.join(process.env.HOME || '/root', '.config', 'systemd', 'user');
const INSTALLED_SCRIPT   = path.join(INSTALL_BIN_DIR, 'mem-watchdog.sh');
const INSTALLED_SERVICE  = path.join(INSTALL_SVC_DIR, 'mem-watchdog.service');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(filePath) {
    try {
        return crypto.createHash('sha256')
            .update(fs.readFileSync(filePath))
            .digest('hex');
    } catch (_) {
        return null;
    }
}

function sh(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        });
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Install or upgrade the daemon if the bundled version differs from what's
 * currently installed. On a clean install, also enables and starts the service.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<'installed'|'upgraded'|'current'>}
 */
async function installOrUpgrade(context) {
    const extDir      = context.extensionUri.fsPath;
    const bundledSh   = path.join(extDir, 'resources', 'mem-watchdog.sh');
    const bundledSvc  = path.join(extDir, 'resources', 'mem-watchdog.service');

    // Guard: resources/ is populated by `npm run build` / vscode:prepublish.
    // If it's missing (dev environment before running `npm run build`), bail
    // gracefully rather than crashing on activation.
    if (!fs.existsSync(bundledSh)) {
        const msg = 'Mem Watchdog: resources/mem-watchdog.sh not found — run "npm run build" in vscode-extension/ first.';
        vscode.window.showWarningMessage(msg);
        return 'current'; // treat as up-to-date so we don't block activation
    }

    const bundledHash    = sha256(bundledSh);
    const installedHash  = context.globalState.get(STATE_HASH_KEY);
    const isFirstInstall = !fs.existsSync(INSTALLED_SCRIPT);

    if (!isFirstInstall && bundledHash && bundledHash === installedHash) {
        // Daemon is current — ensure service is running but don't reinstall.
        await ensureRunning();
        return 'current';
    }

    // ── Copy files ────────────────────────────────────────────────────────────
    fs.mkdirSync(INSTALL_BIN_DIR, { recursive: true });
    fs.mkdirSync(INSTALL_SVC_DIR, { recursive: true });

    fs.copyFileSync(bundledSh,  INSTALLED_SCRIPT);
    fs.copyFileSync(bundledSvc, INSTALLED_SERVICE);
    fs.chmodSync(INSTALLED_SCRIPT, 0o755);

    // ── Enable + (re)start service ────────────────────────────────────────────
    await sh('systemctl --user daemon-reload');
    await sh('systemctl --user enable mem-watchdog');
    const { ok, stderr } = await sh('systemctl --user restart mem-watchdog');
    if (!ok) {
        vscode.window.showErrorMessage(`Mem Watchdog: service restart failed — ${stderr}`);
    }

    // ── Persist hash so next activation skips the install ────────────────────
    await context.globalState.update(STATE_HASH_KEY, bundledHash);

    return isFirstInstall ? 'installed' : 'upgraded';
}

/**
 * Ensure the service is in the 'active' state; start it silently if not.
 */
async function ensureRunning() {
    const { stdout } = await sh('systemctl --user is-active mem-watchdog');
    if (stdout !== 'active') {
        await sh('systemctl --user start mem-watchdog');
    }
}

module.exports = { installOrUpgrade, ensureRunning };
