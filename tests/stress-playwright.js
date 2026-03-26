#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// stress-playwright.js — Playwright driver for watchdog stress testing
//
// Navigates frankspressurewashing.com pages in a loop for the specified
// duration, simulating realistic user behavior.  Designed to run headless
// to minimise Chrome RSS (~400 MB headless vs ~1200 MB headed).
//
// Usage (called by stress-harness.sh, not directly):
//   node tests/stress-playwright.js --scenario=short|medium|long
//                                   [--screenshot-dir=path]
//
// Scenarios:
//   short  — 5 min, 1 tab, navigate 4 service pages + quote modal
//   medium — 20 min, 2 tabs, + screenshots every page
//   long   — 60 min, 3 tabs, + form fill + submit simulation
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ── Argument parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  acc[k] = v || 'true';
  return acc;
}, {});

const SCENARIO = args.scenario || 'short';
const SCREENSHOT_DIR = args['screenshot-dir'] || '';
const BASE_URL = 'https://www.frankspressurewashing.com';

const SCENARIOS = {
  short:  { duration: 5 * 60 * 1000,  tabs: 1, screenshots: false, formFill: false },
  medium: { duration: 20 * 60 * 1000, tabs: 2, screenshots: true,  formFill: false },
  long:   { duration: 60 * 60 * 1000, tabs: 3, screenshots: true,  formFill: true  },
};

const config = SCENARIOS[SCENARIO];
if (!config) {
  console.error(`Unknown scenario: ${SCENARIO}. Use short|medium|long.`);
  process.exit(1);
}

// ── Page routes ─────────────────────────────────────────────────────────────
const PAGES = [
  { name: 'home',           path: '/' },
  { name: 'services-store', path: '/services-store' },
  { name: 'contact',        path: '/contact' },
  { name: 'about',          path: '/about' },
];

const SERVICE_ANCHORS = [
  '#pressure-washing',
  '#soft-washing',
  '#gutter-cleaning',
  '#roof-cleaning',
];

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _shutdownRequested = false;
process.on('SIGTERM', () => { _shutdownRequested = true; });
process.on('SIGINT',  () => { _shutdownRequested = true; });

async function navigateWithRetry(page, url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    } catch (err) {
      if (i === retries) throw err;
      console.error(`  retry ${i + 1}/${retries} for ${url}: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function takeScreenshot(page, name) {
  if (!SCREENSHOT_DIR) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SCREENSHOT_DIR, `${name}-${ts}.png`);
  await page.screenshot({ path: file, fullPage: false });
}

async function openQuoteModal(page) {
  try {
    await page.evaluate(() => {
      if (typeof openQuoteModal === 'function') openQuoteModal('');
    });
    await sleep(500);
    // Verify modal is visible
    const visible = await page.$eval('#qm-overlay', (el) => !el.hidden).catch(() => false);
    return visible;
  } catch {
    return false;
  }
}

async function closeQuoteModal(page) {
  try {
    await page.evaluate(() => {
      if (typeof closeQuoteModal === 'function') closeQuoteModal();
    });
    await sleep(300);
  } catch {
    // Modal may already be closed
  }
}

async function fillQuoteForm(page) {
  try {
    await page.fill('#qm-name', 'Stress Test User');
    await page.fill('#qm-phone', '5125551234');
    await page.fill('#qm-email', 'stress-test@example.com');
    await page.selectOption('#qm-service', 'Pressure Washing');
    await page.fill('#qm-address', '123 Test Street, Austin TX');
    await page.fill('#qm-message', `Stress test at ${new Date().toISOString()}`);
    // Do NOT submit — we don't want to send real form submissions
    await sleep(500);
  } catch (err) {
    console.error(`  form fill error: ${err.message}`);
  }
}

// ── Single tab workload cycle ───────────────────────────────────────────────
async function runCycle(page, tabIndex, cycleNum) {
  for (const pg of PAGES) {
    if (_shutdownRequested) return;

    const url = `${BASE_URL}${pg.path}`;
    console.log(`  [tab${tabIndex}:cycle${cycleNum}] → ${pg.name}`);
    await navigateWithRetry(page, url);
    await sleep(1500 + Math.random() * 1000);  // simulate reading time

    if (config.screenshots) {
      await takeScreenshot(page, `${pg.name}-tab${tabIndex}-c${cycleNum}`);
    }

    // On services-store, scroll through anchors
    if (pg.name === 'services-store') {
      for (const anchor of SERVICE_ANCHORS) {
        if (_shutdownRequested) return;
        try {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: 'smooth' });
          }, anchor);
          await sleep(800);
        } catch {
          // Anchor may not exist — that's fine
        }
      }
    }

    // On home page, open and close quote modal
    if (pg.name === 'home') {
      const opened = await openQuoteModal(page);
      if (opened) {
        if (config.formFill) {
          await fillQuoteForm(page);
        }
        await closeQuoteModal(page);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`stress-playwright: scenario=${SCENARIO} duration=${config.duration / 60000}min tabs=${config.tabs}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
    ],
  });

  const startTime = Date.now();
  const contexts = [];
  const pages = [];

  try {
    // Create tabs
    for (let i = 0; i < config.tabs; i++) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'mem-watchdog-stress-test/1.0',
      });
      const page = await ctx.newPage();
      contexts.push(ctx);
      pages.push(page);
    }

    let cycleNum = 0;
    while (Date.now() - startTime < config.duration && !_shutdownRequested) {
      cycleNum++;
      console.log(`\n--- cycle ${cycleNum} (${Math.round((Date.now() - startTime) / 1000)}s elapsed) ---`);

      // Run all tabs in parallel
      await Promise.all(
        pages.map((page, i) => runCycle(page, i, cycleNum))
      );

      // Brief pause between cycles
      await sleep(2000);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\nstress-playwright: completed ${cycleNum} cycles in ${elapsed}s (shutdown=${_shutdownRequested})`);
  } finally {
    for (const ctx of contexts) {
      await ctx.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
})();
