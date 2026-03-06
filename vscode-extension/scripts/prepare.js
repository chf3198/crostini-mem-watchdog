#!/usr/bin/env node
// scripts/prepare.js
// ─────────────────────────────────────────────────────────────────────────────
// vscode:prepublish step — run automatically by `vsce package` before packaging.
// Also run manually via `npm run build` during development.
//
// Copies the daemon files from the repo root into vscode-extension/resources/
// so that `vsce package` bundles them into the .vsix.
//
// Run from: vscode-extension/ directory (package.json "vscode:prepublish")
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// __dirname is vscode-extension/scripts/
const repoRoot  = path.resolve(__dirname, '../..');        // crostini-mem-watchdog/
const extDir    = path.resolve(__dirname, '..');            // vscode-extension/
const destDir   = path.resolve(extDir, 'resources');       // vscode-extension/resources/

// Files to copy into resources/ (bundled into the .vsix)
const RESOURCES = [
  'mem-watchdog.sh',
  'mem-watchdog.service',
];

// Files to copy into the extension root (required by vsce at package time)
const ROOT_FILES = [
  'LICENSE',
  'icon.png',
];

console.log('[prepare] Copying daemon files from repo root → vscode-extension/resources/');

fs.mkdirSync(destDir, { recursive: true });

for (const file of RESOURCES) {
  const src = path.join(repoRoot, file);
  const dst = path.join(destDir, file);

  if (!fs.existsSync(src)) {
    console.error(`[prepare] ERROR: source file not found: ${src}`);
    process.exit(1);
  }

  fs.copyFileSync(src, dst);
  console.log(`[prepare]   copied ${file}`);
}

for (const file of ROOT_FILES) {
  const src = path.join(repoRoot, file);
  const dst = path.join(extDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`[prepare]   copied ${file} → extension root`);
  }
}

// Ensure the shell script is executable.
// When vsce packages from Linux the file permissions are preserved,
// but being explicit here guards against any future environment changes.
const scriptDst = path.join(destDir, 'mem-watchdog.sh');
execSync(`chmod +x "${scriptDst}"`);
console.log('[prepare]   chmod +x mem-watchdog.sh');

console.log('[prepare] resources/ ready.');
