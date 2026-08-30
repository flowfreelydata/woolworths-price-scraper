'use strict';

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const config = require('./config');

chromium.use(stealth);

// A handful of real, currently-plausible desktop Chrome/Windows and Chrome/Mac UA
// strings. We do NOT invent a UA string that doesn't match the Chromium build we
// actually launch — a UA claiming a newer/older Chrome than the real JS engine
// underneath it is itself a strong, checkable mismatch signal. If in doubt, leave
// USER_AGENT unset and let Playwright report its own (real) UA.
const FALLBACK_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

async function launchBrowser() {
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];

  const launchOpts = {
    headless: config.headless,
    args: launchArgs,
  };

  if (config.proxyServer) {
    // playwright proxy option handles http/https/socks5, incl. embedded creds
    // via server URL or separate username/password if your provider requires it.
    launchOpts.proxy = { server: config.proxyServer };
  }

  const browser = await chromium.launch(launchOpts);
  return browser;
}

async function newStealthContext(browser) {
  const viewport = pick(FALLBACK_VIEWPORTS);

  const contextOpts = {
    viewport,
    locale: config.locale,
    timezoneId: config.timezoneId,
    colorScheme: 'light',
    deviceScaleFactor: 1,
    // Real, matching Accept-Language header (mismatched locale vs Accept-Language
    // is a cheap tell).
    extraHTTPHeaders: {
      'Accept-Language': 'en-AU,en;q=0.9',
    },
  };

  const fs = require('fs');
  if (config.storageStatePath && fs.existsSync(config.storageStatePath)) {
    contextOpts.storageState = config.storageStatePath;
  }

  const context = await browser.newContext(contextOpts);

  // Trim a few more automation tells the stealth plugin doesn't cover.
  await context.addInitScript(() => {
    // Consistent hardware/software concurrency instead of the low defaults some
    // CI/headless images report.
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // A real Chrome always has a non-empty plugins array; stealth plugin fakes
    // this too but we reinforce it in case of version drift.
    if (navigator.plugins && navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
    }
  });

  context.setDefaultTimeout(config.navTimeoutMs);
  return context;
}

/** Small randomised human-like interaction so the page isn't scraped the instant DOM appears. */
async function actLikeAHuman(page) {
  try {
    const { width, height } = page.viewportSize() || { width: 1280, height: 800 };
    const steps = jitter(2, 5);
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(jitter(0, width), jitter(0, height), { steps: jitter(5, 20) });
      await page.waitForTimeout(jitter(150, 500));
    }
    await page.mouse.wheel(0, jitter(300, 1200));
    await page.waitForTimeout(jitter(400, 1200));
  } catch {
    // Best-effort only — never fail the scrape because a mouse wiggle errored.
  }
}

async function humanDelay(minMs = config.minDelayMs, maxMs = config.maxDelayMs) {
  const ms = jitter(minMs, maxMs);
  await new Promise((r) => setTimeout(r, ms));
}

async function saveSession(context) {
  try {
    await context.storageState({ path: config.storageStatePath });
  } catch (err) {
    console.warn('[stealth] could not persist session state:', err.message);
  }
}

module.exports = {
  launchBrowser,
  newStealthContext,
  actLikeAHuman,
  humanDelay,
  saveSession,
  jitter,
};
