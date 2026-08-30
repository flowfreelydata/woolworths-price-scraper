'use strict';

const config = require('./config');
const { launchBrowser, newStealthContext, actLikeAHuman, humanDelay, saveSession, jitter } = require('./stealth');
const { EXTRACT_SCRIPT, RECON_SCRIPT, detectBlocked, GRID_SELECTOR } = require('./extract');

/** Counts real (non-ghost) tiles with a price inside the results grid — the
 * one function evaluated in-browser here, kept in one place since both the
 * "wait for real content" poll and the "scroll to load more" loop need it.
 * Real tiles wrap a <wc-product-tile> custom element whose actual content is
 * inside its Shadow DOM, invisible to plain .textContent — so this walks the
 * tree (including shadow roots) rather than reading textContent directly. Must
 * stay fully self-contained: page.evaluate() stringifies this and runs it in
 * the browser, where it has no access to Node-side closures. */
function countRealTiles(sel) {
  function hasDeepPrice(node) {
    const stack = [node];
    const PRICE = /\$\s?\d/;
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (n.nodeType === 3 && PRICE.test(n.textContent || '')) return true;
      if (n.nodeType === 1) {
        if (n.shadowRoot) stack.push(n.shadowRoot);
        const cn = n.childNodes ? Array.from(n.childNodes) : [];
        for (const c of cn) stack.push(c);
      } else if (n.childNodes) {
        for (const c of Array.from(n.childNodes)) stack.push(c);
      }
    }
    return false;
  }

  const grid = document.querySelector(sel);
  if (!grid) return 0;
  return Array.from(grid.children).filter((el) => !/ghost/i.test(el.className) && hasDeepPrice(el)).length;
}
const { appendHistoryCsv, writeLatestJson, dumpDebugArtifact } = require('./storage');

function searchUrl(term) {
  return `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(term)}`;
}

async function scrapeOneTerm(page, term, attempt, runRecon) {
  const url = searchUrl(term);
  console.log(`[scrape] "${term}" -> ${url} (attempt ${attempt})`);

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });

  const block = await detectBlocked(page, response);
  if (block.blocked) {
    const html = await page.content().catch(() => '');
    dumpDebugArtifact(`blocked_${Date.now()}.html`, html);
    const err = new Error(`blocked: ${block.reason}`);
    err.blocked = true;
    throw err;
  }

  // Give the results grid container time to appear at all.
  try {
    await page.waitForSelector(GRID_SELECTOR, { timeout: config.resultsTimeoutMs });
  } catch {
    // No grid appeared. Could be a genuinely empty result set, or a soft block
    // that returns 200 with a stripped page. Recheck signals.
    const recheck = await detectBlocked(page, response);
    const html = await page.content().catch(() => '');
    dumpDebugArtifact(`no_results_${term.replace(/\W+/g, '_')}_${Date.now()}.html`, html);
    if (recheck.blocked) {
      const err = new Error(`blocked: ${recheck.reason}`);
      err.blocked = true;
      throw err;
    }
    console.warn(`[scrape] "${term}": no results grid found — treating as zero results`);
    return [];
  }

  await actLikeAHuman(page);

  // The grid initially fills with loading-skeleton "ghost" tiles
  // (product-tile-ghost_...) before real data replaces them — poll until at
  // least one real (non-ghost) priced tile shows up, rather than extracting
  // against skeletons. Separately, the grid is a scrollable/virtualized list,
  // so more tiles may only mount once scrolled into view — keep scrolling
  // after real content appears too, until count stops growing or we have enough.
  //
  // How long ghost->real takes varies a lot run to run (observed anywhere from
  // ~10s to still-not-done past 30s) — this is real backend/network variance,
  // not a bug, so the budget below is generous and only requires TWO
  // consecutive unchanged readings (not one) before concluding "stopped
  // growing", since a single stalled tick during a slow load is common.
  const maxWaitMs = Math.max(config.resultsTimeoutMs * 2, 40000);
  const deadline = Date.now() + maxWaitMs;
  let tileCount = 0;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    const count = await page.evaluate(countRealTiles, GRID_SELECTOR);
    if (count >= config.maxResultsPerTerm) {
      tileCount = count;
      break;
    }
    if (count > 0 && count === tileCount) {
      stableTicks++;
      if (stableTicks >= 2) break;
    } else {
      stableTicks = 0;
    }
    tileCount = count;
    // mouse.wheel targets whatever's under the cursor, which may not be the
    // grid's own internal scroll container — drive its scrollTop directly too,
    // since it costs nothing to try both.
    await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="search-results-product-scrollable-content"]');
        if (el) el.scrollTop = el.scrollHeight;
        window.scrollBy(0, window.innerHeight);
      })
      .catch(() => {});
    await page.mouse.wheel(0, jitter(600, 1000));
    await page.waitForTimeout(jitter(500, 1000));
  }

  const { products, anchorCount } = await page.evaluate(EXTRACT_SCRIPT);

  if (products.length === 0) {
    // We have no way to pull files off the Railway volume from outside the
    // container, so a file dump alone is a dead end for remote debugging —
    // log the actual page state straight to stdout (visible via `railway logs`
    // / the dashboard) as well as dumping HTML for anyone with shell/volume
    // access. anchorCount tells us which failure mode this is: 0 means the
    // product-link selector itself found nothing (wrong page entirely — a
    // location/postcode gate, a redirect, a block page); >0 means links were
    // there but our card-extraction heuristic missed them all.
    const diag = await page
      .evaluate(() => ({
        title: document.title,
        url: location.href,
        bodySample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
      }))
      .catch((e) => ({ title: '(eval failed)', url: '', bodySample: e.message }));

    console.warn(
      `[scrape] "${term}": 0 products extracted (anchorCount=${anchorCount}). ` +
        `title="${diag.title}" url="${diag.url}" bodySample="${diag.bodySample}"`
    );

    const html = await page.content().catch(() => '');
    dumpDebugArtifact(`zero_result_${term.replace(/\W+/g, '_')}_${Date.now()}.html`, html);

    if (runRecon) {
      const recon = await page.evaluate(RECON_SCRIPT).catch((e) => ({ error: e.message }));
      console.warn(
        `[recon] grid: ${recon.gridChildCount} children, ${recon.ghostChildCount} ghost, ` +
          `${recon.realChildCount} real. shadowMode="${recon.shadowMode}"`
      );
      (recon.sample || []).forEach((s, i) =>
        console.warn(`[recon] sample[${i}] href="${s.href}" deepText="${s.deepTextSample}" html="${s.outerHtmlHead}"`)
      );
    }
  }

  return products.slice(0, config.maxResultsPerTerm);
}

/**
 * Woolworths shows store-specific prices/availability and, for a browser with no
 * stored delivery location, commonly gates the storefront behind a "enter your
 * suburb/postcode" prompt before search results render at all — which would
 * produce exactly the symptom we're chasing (page loads fine, zero products).
 * This is a best-effort, generic attempt to clear that prompt: it tries a set of
 * plausible dismiss buttons and, if a postcode field is present, fills in a
 * default AU postcode. It intentionally never throws — if none of this matches
 * current markup, the run just proceeds and the per-term diagnostic logging
 * will show us what's actually on the page instead.
 */
async function ensureLocationSet(page) {
  const DEFAULT_POSTCODE = process.env.DEFAULT_POSTCODE || '3000'; // Melbourne CBD
  try {
    await page.goto('https://www.woolworths.com.au/', {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    await page.waitForTimeout(jitter(1500, 3000));

    const dismissPatterns = [
      /continue without/i,
      /shop without/i,
      /browse (the )?site/i,
      /continue shopping/i,
      /no thanks/i,
      /skip/i,
      /^close$/i,
      /accept all/i, // cookie banners tend to block clicks on anything behind them
    ];
    for (const pattern of dismissPatterns) {
      try {
        const btn = page.getByRole('button', { name: pattern }).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(jitter(500, 1200));
        }
      } catch {
        // Not present — try the next pattern.
      }
    }

    // If a postcode/suburb input is present, fill it and take the first suggestion.
    try {
      const input = page
        .locator(
          'input[placeholder*="postcode" i], input[placeholder*="suburb" i], input[aria-label*="postcode" i], input[aria-label*="suburb" i]'
        )
        .first();
      if (await input.isVisible({ timeout: 1500 })) {
        await input.fill(DEFAULT_POSTCODE);
        await page.waitForTimeout(jitter(800, 1500));
        await page.keyboard.press('ArrowDown').catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(jitter(1000, 2000));
      }
    } catch {
      // No postcode gate found — fine, homepage may already show a default store.
    }
  } catch (err) {
    console.warn('[scraper] ensureLocationSet best-effort step failed (continuing anyway):', err.message);
  }
}

async function main() {
  console.log(`[scraper] starting run for ${config.searchTerms.length} term(s): ${config.searchTerms.join(' | ')}`);
  if (!config.searchTerms.length) {
    console.error('[scraper] no SEARCH_TERMS configured — nothing to do.');
    process.exitCode = 1;
    return;
  }

  const browser = await launchBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  await ensureLocationSet(page);

  const scrapedAt = new Date().toISOString();
  const allRows = [];
  const failures = [];

  for (let i = 0; i < config.searchTerms.length; i++) {
    const term = config.searchTerms[i];
    let lastErr = null;

    for (let attempt = 1; attempt <= config.maxRetriesPerTerm; attempt++) {
      try {
        const products = await scrapeOneTerm(page, term, attempt, i === 0 && attempt === 1);
        for (const p of products) {
          allRows.push({
            scraped_at: scrapedAt,
            search_term: term,
            product_id: p.productId,
            name: p.name,
            price: p.price,
            was_price: p.wasPrice ?? '',
            on_special: p.onSpecial,
            unit_price: p.unitPrice ?? '',
            url: p.url,
          });
        }
        console.log(`[scrape] "${term}": ${products.length} product(s) captured`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const backoff = jitter(5000, 15000) * attempt;
        console.warn(`[scrape] "${term}" attempt ${attempt} failed: ${err.message} — backing off ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    if (lastErr) {
      failures.push({ term, error: lastErr.message });
    }

    // Persist the (still valid) session cookies after every term, not just at exit,
    // so a mid-run crash doesn't throw away Akamai trust signals we've built up.
    await saveSession(context);

    if (i < config.searchTerms.length - 1) {
      await humanDelay();
    }
  }

  writeLatestJson(allRows);
  const csvPath = appendHistoryCsv(allRows);

  console.log(`[scraper] done. ${allRows.length} row(s) written to ${csvPath}`);
  if (failures.length) {
    console.warn(`[scraper] ${failures.length} term(s) failed after retries:`, failures);
  }

  await browser.close();

  // Non-zero exit if every single term failed, so Railway/CI can flag a fully-dead run.
  if (failures.length === config.searchTerms.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[scraper] fatal error:', err);
  process.exitCode = 1;
});
