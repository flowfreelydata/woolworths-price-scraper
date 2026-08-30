'use strict';

/**
 * Confirmed live against woolworths.com.au (Aug 2026): the results grid lives at
 * [data-testid="search-results-product-scrollable-content"]. Its children start
 * out as loading skeletons with "ghost" in every class name
 * (product-tile-ghost_...) and get replaced by real tiles once data loads. A
 * real tile is a <div class="product-tile_component_product-tile__..."> that
 * wraps a <wc-product-tile> CUSTOM ELEMENT — a Stencil/web-components tile whose
 * actual name/price markup lives inside its Shadow DOM, not its light-DOM
 * textContent. Plain textContent/innerText/querySelector never see shadow
 * content (by spec, regardless of open/closed mode) — every function below that
 * needs a tile's real content walks the tree manually, descending into
 * `.shadowRoot` where present, rather than relying on those built-ins.
 */
const GRID_SELECTOR = '[data-testid="search-results-product-scrollable-content"]';

/**
 * Collects rendered text and the first link/aria-label found anywhere under
 * `root`, descending into open shadow roots (a closed shadow root's content is
 * genuinely inaccessible to page-context JS — its `.shadowRoot` reads as null —
 * in which case this simply won't find anything inside it, same as any other
 * script running in the page). Self-contained by design: this whole file's
 * functions are stringified by Playwright's page.evaluate() and re-run inside
 * the browser, which has no access to Node-side closures or other module-level
 * helpers — every function here must carry its own complete implementation.
 */
function collectDeep(root) {
  let text = '';
  let href = null;
  let ariaLabel = null;
  let imgSrc = null;
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    if (node.nodeType === 3) {
      // Text node.
      text += node.textContent + ' ';
      continue;
    }

    if (node.nodeType === 1) {
      // Element node.
      if (!ariaLabel) {
        const al = node.getAttribute && node.getAttribute('aria-label');
        if (al) ariaLabel = al;
      }
      if (!href && node.tagName === 'A') {
        href = node.getAttribute('href');
      }
      if (!imgSrc && node.tagName === 'IMG') {
        // currentSrc reflects whatever the browser actually resolved (handles
        // srcset/lazy-load); fall back to the raw attributes lazy-loaders swap
        // in before the real src is set.
        const srcset = node.getAttribute('srcset') || node.getAttribute('data-srcset');
        imgSrc =
          node.currentSrc ||
          node.getAttribute('src') ||
          node.getAttribute('data-src') ||
          (srcset ? srcset.split(',')[0].trim().split(/\s+/)[0] : null);
      }
      if (node.shadowRoot) stack.push(node.shadowRoot);
      const cn = node.childNodes ? Array.from(node.childNodes) : [];
      for (const c of cn) stack.push(c);
    } else if (node.childNodes) {
      // DocumentFragment (a shadow root itself has nodeType 11).
      const cn = Array.from(node.childNodes);
      for (const c of cn) stack.push(c);
    }
  }

  return { text: text.replace(/\s+/g, ' ').trim(), href, ariaLabel, imgSrc };
}

const EXTRACT_SCRIPT = () => {
  function collectDeep(root) {
    let text = '';
    let href = null;
    let ariaLabel = null;
    let imgSrc = null;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 3) {
        text += node.textContent + ' ';
        continue;
      }
      if (node.nodeType === 1) {
        if (!ariaLabel) {
          const al = node.getAttribute && node.getAttribute('aria-label');
          if (al) ariaLabel = al;
        }
        if (!href && node.tagName === 'A') href = node.getAttribute('href');
        if (!imgSrc && node.tagName === 'IMG') {
          const srcset = node.getAttribute('srcset') || node.getAttribute('data-srcset');
          imgSrc =
            node.currentSrc ||
            node.getAttribute('src') ||
            node.getAttribute('data-src') ||
            (srcset ? srcset.split(',')[0].trim().split(/\s+/)[0] : null);
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
        const cn = node.childNodes ? Array.from(node.childNodes) : [];
        for (const c of cn) stack.push(c);
      } else if (node.childNodes) {
        const cn = Array.from(node.childNodes);
        for (const c of cn) stack.push(c);
      }
    }
    return { text: text.replace(/\s+/g, ' ').trim(), href, ariaLabel, imgSrc };
  }

  const PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?/g;
  const UNIT_PRICE_RE = /\$\s?\d{1,4}(?:\.\d{2})?\s*(?:per|\/)\s*[\w.]+/i;
  // Tile aria-labels are the add-to-cart button's accessible name, e.g.
  // "Add Karicare 1 ... 900g to cart" — strip that wrapper to get the actual
  // product name rather than storing the button label verbatim.
  const ADD_TO_CART_RE = /^add\s+(.+?)\s+to\s+cart$/i;

  const grid = document.querySelector('[data-testid="search-results-product-scrollable-content"]');
  const gridChildren = grid ? Array.from(grid.children) : [];
  const seen = new Set();
  const products = [];
  let consideredCount = 0;

  for (const el of gridChildren) {
    if (/ghost/i.test(el.className)) continue;
    consideredCount++;

    const { text, href, ariaLabel, imgSrc } = collectDeep(el);
    const combined = `${ariaLabel || ''} ${text}`;

    const prices = (combined.match(PRICE_RE) || []).map((p) => parseFloat(p.replace(/[^\d.]/g, '')));
    if (!prices.length) continue;

    const idMatch = (href || '').match(/(\d{4,})/);
    const productId = idMatch ? idMatch[1] : href || `${ariaLabel || text}`.slice(0, 60);
    if (!productId || seen.has(productId)) continue;

    const unitPriceMatch = combined.match(UNIT_PRICE_RE);
    const rawName = (ariaLabel || text.split('.').find((l) => l.trim().length > 3) || 'Unknown product').trim();
    const addToCartMatch = rawName.match(ADD_TO_CART_RE);
    const name = addToCartMatch ? addToCartMatch[1] : rawName;

    const currentPrice = Math.min(...prices);
    const wasPrice = prices.length > 1 ? Math.max(...prices) : null;
    const onSpecial = wasPrice !== null && wasPrice > currentPrice;

    products.push({
      productId,
      name: name.replace(/\s+/g, ' ').trim().slice(0, 200),
      imageUrl: imgSrc && imgSrc.startsWith('http') ? imgSrc : imgSrc ? `https://www.woolworths.com.au${imgSrc}` : null,
      url: href ? (href.startsWith('http') ? href : `https://www.woolworths.com.au${href}`) : null,
      price: currentPrice,
      wasPrice: onSpecial ? wasPrice : null,
      onSpecial,
      unitPrice: unitPriceMatch ? unitPriceMatch[0].replace(/\s+/g, ' ').trim() : null,
      rawPricesFound: prices,
    });
    seen.add(productId);
  }

  return { products, anchorCount: consideredCount };
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
 * Recon for when extraction still comes up empty on a page with a genuine
 * result count. Reports the grid's real (non-ghost) child count and, crucially,
 * the shadow-pierced text/href actually collected from the first one — so if
 * this is STILL empty next time, we know the shadow root is closed (or nested
 * deeper than one level) rather than guessing again.
 */
const RECON_SCRIPT = () => {
  function collectDeep(root) {
    let text = '';
    let href = null;
    let ariaLabel = null;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 3) {
        text += node.textContent + ' ';
        continue;
      }
      if (node.nodeType === 1) {
        if (!ariaLabel) {
          const al = node.getAttribute && node.getAttribute('aria-label');
          if (al) ariaLabel = al;
        }
        if (!href && node.tagName === 'A') href = node.getAttribute('href');
        if (node.shadowRoot) stack.push(node.shadowRoot);
        const cn = node.childNodes ? Array.from(node.childNodes) : [];
        for (const c of cn) stack.push(c);
      } else if (node.childNodes) {
        const cn = Array.from(node.childNodes);
        for (const c of cn) stack.push(c);
      }
    }
    return { text: text.replace(/\s+/g, ' ').trim(), href, ariaLabel };
  }

  const grid = document.querySelector('[data-testid="search-results-product-scrollable-content"]');
  const children = grid ? Array.from(grid.children) : [];
  const ghostCount = children.filter((el) => /ghost/i.test(el.className)).length;
  const realChildren = children.filter((el) => !/ghost/i.test(el.className));

  const wcTile = realChildren[0] ? realChildren[0].querySelector('wc-product-tile') : null;
  const shadowMode = wcTile ? (wcTile.shadowRoot ? 'open (accessible)' : 'closed or not attached') : 'no wc-product-tile found';

  const sample = realChildren.slice(0, 2).map((el) => {
    const deep = collectDeep(el);
    return { outerHtmlHead: el.outerHTML.replace(/\s+/g, ' ').slice(0, 300), deepTextSample: deep.text.slice(0, 400), href: deep.href };
  });

  return {
    gridChildCount: children.length,
    ghostChildCount: ghostCount,
    realChildCount: realChildren.length,
    shadowMode,
    sample,
  };
};

module.exports = { EXTRACT_SCRIPT, RECON_SCRIPT, detectBlocked, GRID_SELECTOR, collectDeep };
