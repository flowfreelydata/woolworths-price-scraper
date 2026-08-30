'use strict';

/**
 * All tunables come from env vars so the same image runs locally and on Railway
 * without code changes. Nothing here is secret; secrets (proxy creds) are passed
 * as env vars too, never hardcoded.
 */

function parseList(val) {
  if (!val) return [];
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntEnv(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  // What to search for. Comma-separated, e.g. "milk 2l,white bread,chicken breast"
  searchTerms: parseList(process.env.SEARCH_TERMS || 'milk 2l,white bread,eggs 12 pack'),

  // Max product rows kept per search term (the search results page is paginated;
  // we only scrape the first rendered page to keep request volume low).
  maxResultsPerTerm: parseIntEnv(process.env.MAX_RESULTS_PER_TERM, 24),

  // Where output goes. On Railway, mount a volume at /data so history survives redeploys.
  outputDir: process.env.OUTPUT_DIR || '/data',

  headless: (process.env.HEADLESS || 'true').toLowerCase() !== 'false',

  // Optional proxy. Format: http://user:pass@host:port  (or socks5://...)
  // Strongly recommended for real reliability — see README. Left blank = direct connection.
  proxyServer: process.env.PROXY_SERVER || '',

  // Locale/timezone should match where the "shopper" is meant to be — Woolworths
  // also localises store/pricing by postcode, so keep this consistent with reality.
  locale: process.env.LOCALE || 'en-AU',
  timezoneId: process.env.TZ_ID || 'Australia/Melbourne',

  // Human-like pacing. Wide, randomised gaps matter more than any JS trick.
  minDelayMs: parseIntEnv(process.env.MIN_DELAY_MS, 8000),
  maxDelayMs: parseIntEnv(process.env.MAX_DELAY_MS, 22000),

  navTimeoutMs: parseIntEnv(process.env.NAV_TIMEOUT_MS, 45000),
  resultsTimeoutMs: parseIntEnv(process.env.RESULTS_TIMEOUT_MS, 20000),

  maxRetriesPerTerm: parseIntEnv(process.env.MAX_RETRIES_PER_TERM, 3),

  // Persisted across runs so Akamai's device-trust cookies (_abck, bm_sz, ak_bmsc)
  // carry over instead of every run looking like a brand-new never-seen device.
  storageStatePath: process.env.STORAGE_STATE_PATH || '',

  userDataDebug: (process.env.DEBUG_DUMPS || 'true').toLowerCase() !== 'false',

  // Optional. When set, every run's rows are also persisted to Postgres
  // (in addition to the CSV/JSON on the volume) — see src/db.js. Left unset,
  // the scraper behaves exactly as before (CSV/JSON only).
  databaseUrl: process.env.DATABASE_URL || '',
};

config.storageStatePath = config.storageStatePath || `${config.outputDir}/session-state.json`;

module.exports = config;
