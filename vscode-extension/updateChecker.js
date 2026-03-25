// updateChecker.js — self-update check via GitHub Releases API
// ─────────────────────────────────────────────────────────────────────────────
// Called from activate() with a 10 s delay. Checks the public GitHub Releases
// API to see if a newer extension version is available, then shows a non-modal
// notification with "Update Now" / "Dismiss" buttons.
//
// Why this exists:
//   VS Code auto-update works by default, but users can disable it via
//   extensions.autoUpdate: false. When that setting is inherited (e.g., via
//   Settings Sync or documentation templates), critical daemon fixes bundled
//   in newer extension versions never reach those users. This module ensures
//   users on v0.3.6+ are ALWAYS notified about newer versions, regardless
//   of their auto-update settings.
//
// Design constraints:
//   - Non-blocking: deferred via setTimeout, never blocks activation
//   - Throttled: at most once per 24 hours via globalState timestamp
//   - Graceful: silently ignores network errors, timeouts, and JSON failures
//   - Dismissible: users can dismiss per-version (stored in globalState)
//   - No auth: public GitHub API, no token required (60 req/hr limit)
//   - OOM-safe: single HTTPS request, no fork(), ~50 KB response at most
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode = require('vscode');
const https  = require('https');

const GITHUB_REPO          = 'chf3198/crostini-mem-watchdog';
const STATE_KEY_LAST_CHECK = 'updateCheckTimestamp';
const STATE_KEY_DISMISSED  = 'updateCheckDismissedVersion';
const CHECK_INTERVAL_MS    = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS   = 5000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compare two semver-like version strings (e.g., '0.3.5' vs '0.3.6').
 * @returns {number} -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}

/**
 * Fetch the latest release tag from GitHub.
 * @returns {Promise<string|null>} Tag name (e.g., 'v0.3.6') or null on failure.
 */
function fetchLatestRelease() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/releases/latest`,
            headers: {
                'User-Agent': 'mem-watchdog-status-vscode',
                'Accept': 'application/vnd.github+json',
            },
            timeout: REQUEST_TIMEOUT_MS,
        };

        const req = https.get(options, (res) => {
            if (res.statusCode !== 200) {
                res.resume(); // consume response to free memory
                resolve(null);
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve(data.tag_name || null);
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check for a newer extension version via GitHub Releases API.
 * Non-blocking, throttled to once per 24 hours, graceful on failure.
 *
 * @param {vscode.ExtensionContext} context
 */
async function checkForUpdate(context) {
    try {
        // Throttle: skip if checked within the last 24 hours
        const lastCheck = context.globalState.get(STATE_KEY_LAST_CHECK, 0);
        if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
            return;
        }

        const localVersion = context.extension.packageJSON.version;
        const tagName = await fetchLatestRelease();
        if (!tagName) return; // network error or no releases

        // Record the check time regardless of result
        await context.globalState.update(STATE_KEY_LAST_CHECK, Date.now());

        // Strip leading 'v' from tag (e.g., 'v0.3.6' → '0.3.6')
        const remoteVersion = tagName.replace(/^v/, '');

        if (compareVersions(localVersion, remoteVersion) >= 0) {
            return; // already up to date or ahead
        }

        // Skip if user already dismissed this specific version
        const dismissed = context.globalState.get(STATE_KEY_DISMISSED, '');
        if (dismissed === remoteVersion) {
            return;
        }

        // Show non-modal notification
        const updateBtn  = 'Update Now';
        const dismissBtn = 'Dismiss';
        const choice = await vscode.window.showInformationMessage(
            `Mem Watchdog v${remoteVersion} is available (you have v${localVersion}). ` +
            'Update recommended — may include critical daemon fixes.',
            updateBtn, dismissBtn
        );

        if (choice === updateBtn) {
            // Open the extension's Marketplace page in VS Code
            await vscode.commands.executeCommand(
                'workbench.extensions.search',
                'CurtisFranks.mem-watchdog-status'
            );
        } else if (choice === dismissBtn) {
            await context.globalState.update(STATE_KEY_DISMISSED, remoteVersion);
        }
    } catch {
        // Silently ignore any unexpected errors — update checking must never
        // crash activation or produce user-visible errors.
    }
}

module.exports = { checkForUpdate, compareVersions };

// ── Test-only exports ─────────────────────────────────────────────────────────
/* c8 ignore next */
if (process.env.MEM_WATCHDOG_TEST) {
    module.exports._test = {
        GITHUB_REPO,
        STATE_KEY_LAST_CHECK,
        STATE_KEY_DISMISSED,
        CHECK_INTERVAL_MS,
        REQUEST_TIMEOUT_MS,
        fetchLatestRelease,
    };
}
