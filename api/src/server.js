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
 *
 * [auth] routes require header `x-api-key: <API_KEY>` matching the API_KEY env var.
 */

const http = require('http');
const db = require('./db');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEY = process.env.API_KEY || '';

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
    return sendJson(res, 200, { product });
  }

  // DELETE /products/:id
  if (req.method === 'DELETE' && parts.length === 2) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const deleted = await db.deleteProduct(productId);
    if (!deleted) return sendJson(res, 404, { error: 'not found' });
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
