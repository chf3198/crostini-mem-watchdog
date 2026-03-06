// lifecycle.js — vscode:uninstall hook (plain Node.js; no VS Code API available)
// ─────────────────────────────────────────────────────────────────────────────
// VS Code runs this script via `node ./lifecycle.js` when the extension is
// fully uninstalled (executed on next VS Code restart after the uninstall).
//
// What this does:
//   - Stops and disables the mem-watchdog systemd user service.
//   - Does NOT delete ~/.local/bin/mem-watchdog.sh — the user may want the
//     daemon to keep running outside of VS Code management.
//
// If the service was never installed, all commands fail silently via `|| true`.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { execSync } = require('child_process');

const cmds = [
    'systemctl --user stop    mem-watchdog 2>/dev/null || true',
    'systemctl --user disable mem-watchdog 2>/dev/null || true',
];

for (const cmd of cmds) {
    try {
        execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    } catch (_) {
        // Intentionally swallowed — extension uninstall must not throw.
    }
}
