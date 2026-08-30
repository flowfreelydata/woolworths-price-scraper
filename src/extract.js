'use strict';

/**
 * Confirmed live against woolworths.com.au (Aug 2026): the results grid lives at
 * [data-testid="search-results-product-scrollable-content"], but "search-results-
 * product" itself is the SECTION wrapper (only ~2 on the page, one of which is
 * the sort/filter chip bar) — not a per-tile marker. Its children start out as
 * loading skeletons with "ghost" in every class name (product-tile-ghost_...)
 * and get replaced by real tiles once data loads. We treat any non-ghost direct
 * child of the scrollable content container that contains a price as a tile,
 * rather than depending on the real tile's own (currently unknown, and liable
 * to drift again) class name.
 */
const GRID_SELECTOR = '[data-testid="search-results-product-scrollable-content"]';

const EXTRACT_SCRIPT = () => {
  const PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?/g;
  const UNIT_PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?\s*(?:per|\/)\s*[\w.]+/i;

  // Inlined literal, not the module-level GRID_SELECTOR const: this function is
  // stringified by page.evaluate() and re-run inside the browser, which has no
  // access to Node-side closures — referencing the outer const throws
  // ReferenceError at runtime there even though it type-checks fine here.
  const grid = document.querySelector('[data-testid="search-results-product-scrollable-content"]');
  // Plain non-global test here — PRICE_RE is global and stateful (lastIndex),
  // reusing it across filter() calls on different strings would silently skip
  // matches depending on where the previous call left off.
  const HAS_PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?/;
  const tiles = grid
    ? Array.from(grid.children).filter((el) => !/ghost/i.test(el.className) && HAS_PRICE_RE.test(el.textContent || ''))
    : [];
  const seen = new Set();
  const products = [];

  for (const tile of tiles) {
    const ariaLabel = (tile.getAttribute('aria-label') || '').trim();
    const text = (tile.innerText || tile.textContent || '').trim();
    const combined = `${ariaLabel} ${text}`;

    const prices = (combined.match(PRICE_RE) || []).map((p) => parseFloat(p.replace(/[^\d.]/g, '')));
    if (!prices.length) continue;

    // We don't know the current product-detail URL scheme, so take whatever
    // link (if any) is inside the tile rather than assuming a pattern.
    const link = tile.querySelector('a[href]');
    const href = link ? link.getAttribute('href') || '' : '';
    const idMatch = href.match(/(\d{4,})/);
    // Fall back to the href itself, or a name+price fingerprint, as the dedupe
    // key when no numeric id is present in the link.
    const productId = idMatch ? idMatch[1] : href || `${ariaLabel || text}`.slice(0, 60);
    if (!productId || seen.has(productId)) continue;

    const unitPriceMatch = combined.match(UNIT_PRICE_RE);
    const name =
      ariaLabel ||
      link?.getAttribute('title')?.trim() ||
      text.split('\n').find((l) => l.trim().length > 3) ||
      'Unknown product';

    const currentPrice = Math.min(...prices);
    const wasPrice = prices.length > 1 ? Math.max(...prices) : null;
    const onSpecial = wasPrice !== null && wasPrice > currentPrice;

    products.push({
      productId,
      name: name.replace(/\s+/g, ' ').trim().slice(0, 200),
      url: href ? (href.startsWith('http') ? href : `https://www.woolworths.com.au${href}`) : null,
      price: currentPrice,
      wasPrice: onSpecial ? wasPrice : null,
      onSpecial,
      unitPrice: unitPriceMatch ? unitPriceMatch[0].replace(/\s+/g, ' ').trim() : null,
      rawPricesFound: prices,
    });
    seen.add(productId);
  }

  return { products, anchorCount: tiles.length };
};

/** Known Akamai / generic bot-wall signatures. Server-rendered block pages are
 * usually terse and static, unlike the real (heavy, JS-rendered) storefront. */
async function detectBlocked(page, response) {
  const status = response ? response.status() : null;
  if (status && [403, 406, 429, 503].includes(status)) {
    return { blocked: true, reason: `http_${status}` };
  }

  const signals = await page.evaluate(() => {
    const title = document.title || '';
    const bodyText = (document.body && document.body.innerText) || '';
    const hasCaptchaFrame = !!document.querySelector(
      'iframe[src*="captcha"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]'
    );
    return {
      title,
      textSample: bodyText.slice(0, 500),
      hasCaptchaFrame,
      bodyLength: bodyText.length,
    };
  }).catch(() => null);

  if (!signals) return { blocked: false };

  const blockMarkers = [
    'access denied',
    'reference #',
    'pardon our interruption',
    'request blocked',
    'are you a human',
    'unusual traffic',
  ];
  const haystack = `${signals.title} ${signals.textSample}`.toLowerCase();
  const matched = blockMarkers.find((m) => haystack.includes(m));

  if (matched || signals.hasCaptchaFrame) {
    return { blocked: true, reason: matched || 'captcha_frame' };
  }

  return { blocked: false };
}

/**
 * One-shot recon for when EXTRACT_SCRIPT finds zero anchors on a page that's
 * demonstrably real (has a genuine "N Products" result set). Surfaces the
 * actual current markup so extraction can be fixed against reality instead of
 * guessed at blind: every data-testid on the page (Woolworths' storefront is
 * heavily data-testid instrumented, so the real tile/price names will be in
 * here), any product-ish links regardless of exact path, and the outerHTML of
 * whatever DOM node most tightly wraps a lone "$" price (climbed a few levels
 * so it reads as a whole card, not just a price span).
 */
const RECON_SCRIPT = () => {
  const allTestidEls = Array.from(document.querySelectorAll('[data-testid]'));
  // Every unique testid CONTAINING "product" (not exact-match only) — the exact
  // match "search-results-product" turned out to hit only 2 elements (likely a
  // list/section wrapper, not per-tile), so the real per-tile testid is probably
  // a different string entirely that this substring search will surface.
  const productTestids = Array.from(new Set(
    allTestidEls.map((el) => el.getAttribute('data-testid')).filter((t) => t && /product/i.test(t))
  )).slice(0, 100);

  // Full outerHTML of the exact "search-results-product" element(s), so we can
  // see what's actually nested inside rather than guessing further.
  const exactMatches = Array.from(document.querySelectorAll('[data-testid="search-results-product"]'));
  const exactMatchHtml = exactMatches.map((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 2500));

  // Total count of elements whose testid contains "product", by exact testid
  // value, so we know which one is the real per-tile repeater.
  const countsByTestid = {};
  for (const el of allTestidEls) {
    const t = el.getAttribute('data-testid');
    if (t && /product/i.test(t)) countsByTestid[t] = (countsByTestid[t] || 0) + 1;
  }

  // One real (non-ghost) tile's outerHTML, if the grid has finished loading by
  // the time this runs — final sanity check on the actual tile markup.
  const grid = document.querySelector('[data-testid="search-results-product-scrollable-content"]');
  const realTile = grid ? Array.from(grid.children).find((el) => !/ghost/i.test(el.className)) : null;
  const realTileHtml = realTile ? realTile.outerHTML.replace(/\s+/g, ' ').slice(0, 2500) : null;
  const gridChildCount = grid ? grid.children.length : 0;
  const ghostChildCount = grid ? Array.from(grid.children).filter((el) => /ghost/i.test(el.className)).length : 0;

  return {
    productTestids,
    exactMatchHtml,
    countsByTestid,
    totalTestidEls: allTestidEls.length,
    gridChildCount,
    ghostChildCount,
    realTileHtml,
  };
};

module.exports = { EXTRACT_SCRIPT, RECON_SCRIPT, detectBlocked, GRID_SELECTOR };
