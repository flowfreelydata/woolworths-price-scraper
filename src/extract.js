'use strict';

/**
 * Confirmed live against woolworths.com.au (Aug 2026): each product tile in the
 * search results grid carries data-testid="search-results-product". That
 * replaced whatever URL scheme this originally anchored on (Woolworths' product
 * detail links no longer match /shop/productdetails/ — that was stale). Tiles
 * are the ground truth now; we extract name/price from inside each tile rather
 * than reverse-engineering a URL pattern that can drift again without warning.
 */
const TILE_SELECTOR = '[data-testid="search-results-product"]';

const EXTRACT_SCRIPT = () => {
  const PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?/g;
  const UNIT_PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?\s*(?:per|\/)\s*[\w.]+/i;

  // Inlined literal, not the module-level TILE_SELECTOR const: this function is
  // stringified by page.evaluate() and re-run inside the browser, which has no
  // access to Node-side closures — referencing the outer const throws
  // ReferenceError at runtime there even though it type-checks fine here.
  const tiles = Array.from(document.querySelectorAll('[data-testid="search-results-product"]'));
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
  const testids = Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')))).slice(0, 80);

  const productishLinks = Array.from(new Set(
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && /product/i.test(h))
  )).slice(0, 20);

  const dollarLeaf = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const txt = el.textContent || '';
    return el.children.length <= 1 && /\$\s?\d/.test(txt) && txt.length < 30;
  });

  const sampleCards = dollarLeaf.slice(0, 2).map((el) => {
    let node = el;
    for (let i = 0; i < 5; i++) {
      if (node.parentElement) node = node.parentElement;
    }
    return node.outerHTML.replace(/\s+/g, ' ').slice(0, 1800);
  });

  return { testids, productishLinks, sampleCards, dollarLeafCount: dollarLeaf.length };
};

module.exports = { EXTRACT_SCRIPT, RECON_SCRIPT, detectBlocked, TILE_SELECTOR };
