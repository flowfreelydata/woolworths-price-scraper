'use strict';

/**
 * Minimal JSON API over the scraper's Postgres data — deliberately dependency-free
 * beyond `pg` (no Express/Fastify) to keep the image tiny and cold-start fast on a
 * service that's meant to scale to zero between requests (see Railway's
 * "sleepApplication" setting on this service).
 *
 * Routes:
 *   GET    /health
 *   GET    /products                 ?search_term=&q=&on_special=true&limit=&offset=
 *   GET    /products/:id
 *   GET    /products/:id/history     ?limit=
 *   PATCH  /products/:id             [auth] manual price correction -> price_locked=true
 *   POST   /products/:id/unlock      [auth] resume auto price updates from the scraper
 *   POST   /products                 [auth] add/replace a product manually
 *   DELETE /products/:id             [auth]
 *   GET    /prices                   ?product=&suburb=&state=       (Bubstock iOS app)
 *   GET    /prices/history           ?product=&suburb=&state=&weeks=
 *
 * [auth] routes require header `x-api-key: <API_KEY>` matching the API_KEY env var.
 *
 * The /prices* routes exist to match Bubstock's PriceAPIService.swift contract
 * as-is (retailer/suburb/state fields, weekly aggregates) even though this
 * scraper is single-retailer (Woolworths online catalog, no store/suburb-level
 * pricing) and has no per-store granularity — `retailer` is hardcoded and
 * suburb/state are echoed back rather than affecting the result. `product` is
 * matched against our scraped `products.name` by trigram similarity (see
 * db.js findBestProductMatch), since the app's own curated catalog names
 * don't exactly match Woolworths' raw listing names.
 */

const http = require('http');
const db = require('./db');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEY = process.env.API_KEY || '';

// Prices only change once a day (the scraper's cron), so re-running the
// trigram similarity scan on every app open is pure waste — a tiny in-memory
// cache cuts repeat Postgres/CPU load to ~zero for the common case (a handful
// of distinct product names, hit repeatedly by one iOS app) without adding a
// dependency like Redis. Lives in process memory only: cleared on every
// deploy/restart, never shared across instances — correct for a single
// low-traffic replica. TTL is deliberately shorter than the cron interval so
// a manual price override or an unlock is never masked for more than an hour.
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const priceCache = new Map(); // key -> { body, expiresAt }

function cacheGet(key) {
  const hit = priceCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    priceCache.delete(key);
    return undefined;
  }
  return hit.body;
}

function cacheSet(key, body) {
  priceCache.set(key, { body, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  // Bound worst-case memory: this only ever holds a handful of distinct
  // (product, suburb, state[, weeks]) combinations for one app, but a hard
  // cap keeps it that way even if something starts sending garbage queries.
  if (priceCache.size > 500) {
    const oldestKey = priceCache.keys().next().value;
    priceCache.delete(oldestKey);
  }
}

function sendJson(res, status, body) {
  // A 204 (used for DELETE) must not carry a body per HTTP spec.
  if (status === 204) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
    });
    return res.end();
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX_BYTES = 256 * 1024; // plenty for a single product record
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  if (!API_KEY) return false; // writes are refused outright if no key is configured
  return req.headers['x-api-key'] === API_KEY;
}

function parseBoolParam(v) {
  if (v === undefined) return undefined;
  return v === 'true' || v === '1';
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampWeeks(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.min(n, 52);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['products', ':id', ...]

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
    });
    return res.end();
  }

  if (req.method === 'GET' && parts.length === 0) {
    return sendJson(res, 200, { service: 'woolworths-price-api', ok: true });
  }

  if (req.method === 'GET' && parts[0] === 'health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  // GET /prices?product=&suburb=&state=
  if (req.method === 'GET' && parts[0] === 'prices' && parts.length === 1) {
    const productName = url.searchParams.get('product');
    if (!productName) return sendJson(res, 400, { error: 'product query param is required' });
    const suburb = url.searchParams.get('suburb') || '';
    const state = url.searchParams.get('state') || '';

    const cacheKey = `prices:${productName}:${suburb}:${state}`;
    const cached = cacheGet(cacheKey);
    if (cached) return sendJson(res, cached.status, cached.body);

    const match = await db.findBestProductMatch(productName);
    if (!match) {
      cacheSet(cacheKey, { status: 404, body: { error: 'no matching product' } });
      return sendJson(res, 404, { error: 'no matching product' });
    }

    const body = {
      productName: match.name,
      entries: [
        {
          retailer: 'Woolworths',
          storeName: 'Woolworths Online',
          suburb,
          state,
          price: toNumber(match.price),
          currency: 'AUD',
          unit: match.unit_price || '',
          isOnSale: match.on_special,
          saleEndsAt: null,
          lastUpdated: new Date(match.last_scraped_at || match.updated_at).toISOString(),
        },
      ],
      fetchedAt: new Date().toISOString(),
    };
    cacheSet(cacheKey, { status: 200, body });
    return sendJson(res, 200, body);
  }

  // GET /prices/history?product=&suburb=&state=&weeks=
  if (req.method === 'GET' && parts[0] === 'prices' && parts.length === 2 && parts[1] === 'history') {
    const productName = url.searchParams.get('product');
    if (!productName) return sendJson(res, 400, { error: 'product query param is required' });
    const suburb = url.searchParams.get('suburb') || '';
    const state = url.searchParams.get('state') || '';
    const weeks = clampWeeks(url.searchParams.get('weeks'));

    const cacheKey = `history:${productName}:${suburb}:${state}:${weeks}`;
    const cached = cacheGet(cacheKey);
    if (cached) return sendJson(res, cached.status, cached.body);

    const match = await db.findBestProductMatch(productName);
    if (!match) {
      cacheSet(cacheKey, { status: 404, body: { error: 'no matching product' } });
      return sendJson(res, 404, { error: 'no matching product' });
    }

    const weekly = await db.getWeeklyPriceHistory(match.product_id, weeks);
    const body = {
      productName: match.name,
      suburb,
      state,
      weeks: weekly.map((w) => ({
        week: w.week,
        retailer: 'Woolworths',
        avg_price: toNumber(w.avg_price),
        min_price: toNumber(w.min_price),
        max_price: toNumber(w.max_price),
      })),
      fetchedAt: new Date().toISOString(),
    };
    cacheSet(cacheKey, { status: 200, body });
    return sendJson(res, 200, body);
  }

  if (parts[0] !== 'products') {
    return sendJson(res, 404, { error: 'not found' });
  }

  // GET /products
  if (req.method === 'GET' && parts.length === 1) {
    const rows = await db.listProducts({
      searchTerm: url.searchParams.get('search_term') || undefined,
      q: url.searchParams.get('q') || undefined,
      onSpecial: parseBoolParam(url.searchParams.get('on_special')),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    });
    return sendJson(res, 200, { count: rows.length, products: rows });
  }

  // POST /products
  if (req.method === 'POST' && parts.length === 1) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    if (!body.product_id || !body.name) {
      return sendJson(res, 400, { error: 'product_id and name are required' });
    }
    const product = await db.createProduct(body);
    priceCache.clear(); // a new/replaced product could be the correct match for a cached 404
    return sendJson(res, 201, { product });
  }

  const productId = decodeURIComponent(parts[1] || '');

  // GET /products/:id/history
  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'history') {
    const history = await db.getProductHistory(productId, { limit: url.searchParams.get('limit') });
    return sendJson(res, 200, { product_id: productId, count: history.length, history });
  }

  // POST /products/:id/unlock
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'unlock') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const product = await db.unlockProductPrice(productId);
    if (!product) return sendJson(res, 404, { error: 'not found' });
    priceCache.clear();
    return sendJson(res, 200, { product });
  }

  // GET /products/:id
  if (req.method === 'GET' && parts.length === 2) {
    const product = await db.getProduct(productId);
    if (!product) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, { product });
  }

  // PATCH /products/:id  (manual price override)
  if (req.method === 'PATCH' && parts.length === 2) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    if (body.price === undefined && body.was_price === undefined && body.on_special === undefined && body.unit_price === undefined) {
      return sendJson(res, 400, { error: 'provide at least one of price, was_price, on_special, unit_price' });
    }
    const product = await db.overrideProductPrice(productId, {
      price: body.price,
      wasPrice: body.was_price,
      onSpecial: body.on_special,
      unitPrice: body.unit_price,
    });
    if (!product) return sendJson(res, 404, { error: 'not found' });
    priceCache.clear(); // this product's cached /prices entry (if any) now has the stale price
    return sendJson(res, 200, { product });
  }

  // DELETE /products/:id
  if (req.method === 'DELETE' && parts.length === 2) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const deleted = await db.deleteProduct(productId);
    if (!deleted) return sendJson(res, 404, { error: 'not found' });
    priceCache.clear();
    return sendJson(res, 204, {});
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[api] request error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
});

db.ensureSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[api] listening on :${PORT}${API_KEY ? '' : ' (WARNING: API_KEY not set — write endpoints are disabled)'}`);
    });
  })
  .catch((err) => {
    console.error('[api] failed to initialize schema:', err);
    process.exit(1);
  });
