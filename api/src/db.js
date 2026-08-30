'use strict';

const { Pool, types } = require('pg');

// pg returns NUMERIC/DECIMAL columns (price, was_price, avg_price, ...) as
// strings by default, since NUMERIC can exceed safe float precision. Prices
// here are plain 2-decimal AUD amounts with no such risk, and every consumer
// of this API (including Swift's `Double`-typed Codable structs) needs an
// actual JSON number, not a quoted string — so parse NUMERIC (OID 1700)
// globally rather than remembering to cast it at every call site.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  // Fail fast and loud at boot rather than 500-ing on the first request —
  // this is a config error, not a runtime one.
  console.error('[api] DATABASE_URL is not set. Refusing to start.');
  process.exit(1);
}

// Small pool: this is a low-traffic single-consumer API (one iOS app), and a
// serverless-style Postgres plan may cap total connections — 5 is plenty of
// headroom without hogging slots the scraper's own runs also need.
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway's official Postgres template (postgres-ssl) terminates TLS with a
  // self-signed cert — rejectUnauthorized:false trusts it without requiring a
  // CA bundle, the normal tradeoff for a managed single-tenant database.
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

/**
 * Mirrors src/db.js's schema in the scraper project. Kept as a plain literal
 * here (not a shared import) because this service builds from its own
 * `api/` root as an independent, minimal-footprint Docker image — duplicating
 * ~15 lines of DDL is cheaper than wiring a shared package across two
 * separately-deployed services. Both copies must be kept in sync by hand if
 * the schema changes again.
 */
async function ensureSchema() {
  // Powers findBestProductMatch() below — the app's own curated catalog names
  // ("Karicare Gold+ Infant Formula") don't exactly match Woolworths' raw
  // scraped listing names ("Karicare 1 Gentle Nutrition Infant Formula From 0
  // to 6 Months 900g"), so exact/ILIKE matching isn't good enough. Trigram
  // similarity is a standard, low-effort way to rank "closest name" without
  // hand-building a matching table.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id BIGSERIAL PRIMARY KEY,
      scraped_at TIMESTAMPTZ NOT NULL,
      search_term TEXT NOT NULL,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image_url TEXT,
      price NUMERIC(10,2) NOT NULL,
      was_price NUMERIC(10,2),
      on_special BOOLEAN NOT NULL DEFAULT FALSE,
      unit_price TEXT,
      url TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scraped_at, search_term, product_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      product_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image_url TEXT,
      url TEXT,
      search_term TEXT,
      price NUMERIC(10,2),
      was_price NUMERIC(10,2),
      on_special BOOLEAN NOT NULL DEFAULT FALSE,
      unit_price TEXT,
      price_locked BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL DEFAULT 'scraper',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_scraped_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_search_term ON products (search_term);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products (updated_at);`);
  // Trigram (GIN) index so similarity search on `name` stays fast as the
  // catalog grows, instead of a sequential scan per lookup.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);`);
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function clampLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function listProducts({ searchTerm, q, onSpecial, limit, offset } = {}) {
  const clauses = [];
  const params = [];

  if (searchTerm) {
    params.push(searchTerm);
    clauses.push(`search_term = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`name ILIKE $${params.length}`);
  }
  if (onSpecial === true) {
    clauses.push('on_special = TRUE');
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(clampLimit(limit));
  const limitParam = `$${params.length}`;
  params.push(parseInt(offset, 10) > 0 ? parseInt(offset, 10) : 0);
  const offsetParam = `$${params.length}`;

  const { rows } = await pool.query(
    `SELECT * FROM products ${where} ORDER BY updated_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );
  return rows;
}

async function getProduct(productId) {
  const { rows } = await pool.query('SELECT * FROM products WHERE product_id = $1', [productId]);
  return rows[0] || null;
}

async function getProductHistory(productId, { limit } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM price_history WHERE product_id = $1 ORDER BY scraped_at ASC LIMIT $2',
    [productId, clampLimit(limit)]
  );
  return rows;
}

/** Manual price correction. Always sets price_locked = true so the next
 * scrape run doesn't immediately overwrite the fix. */
async function overrideProductPrice(productId, { price, wasPrice, onSpecial, unitPrice }) {
  const { rows } = await pool.query(
    `UPDATE products SET
       price = COALESCE($2, price),
       was_price = $3,
       on_special = COALESCE($4, on_special),
       unit_price = COALESCE($5, unit_price),
       price_locked = TRUE,
       updated_at = now()
     WHERE product_id = $1
     RETURNING *`,
    [productId, price ?? null, wasPrice ?? null, onSpecial ?? null, unitPrice ?? null]
  );
  return rows[0] || null;
}

async function unlockProductPrice(productId) {
  const { rows } = await pool.query(
    `UPDATE products SET price_locked = FALSE, updated_at = now() WHERE product_id = $1 RETURNING *`,
    [productId]
  );
  return rows[0] || null;
}

/** Manual product creation. price_locked defaults to false so a product added
 * by hand can still pick up live prices if a future scrape run happens to
 * match it under one of the configured search terms. */
async function createProduct(p) {
  const { rows } = await pool.query(
    `INSERT INTO products
       (product_id, name, image_url, url, search_term, price, was_price, on_special, unit_price, price_locked, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', now())
     ON CONFLICT (product_id) DO UPDATE SET
       name = EXCLUDED.name,
       image_url = EXCLUDED.image_url,
       url = EXCLUDED.url,
       search_term = EXCLUDED.search_term,
       price = EXCLUDED.price,
       was_price = EXCLUDED.was_price,
       on_special = EXCLUDED.on_special,
       unit_price = EXCLUDED.unit_price,
       price_locked = EXCLUDED.price_locked,
       updated_at = now()
     RETURNING *`,
    [
      p.product_id,
      p.name,
      p.image_url || null,
      p.url || null,
      p.search_term || null,
      p.price ?? null,
      p.was_price ?? null,
      !!p.on_special,
      p.unit_price || null,
      !!p.price_locked,
    ]
  );
  return rows[0];
}

async function deleteProduct(productId) {
  const { rowCount } = await pool.query('DELETE FROM products WHERE product_id = $1', [productId]);
  return rowCount > 0;
}

// Below the default pg_trgm threshold (0.3) a "match" is usually two
// unrelated products that happen to share a few common words ("Organic",
// "100g") — better to report no match than a wrong one for a grocery price.
const MATCH_SIMILARITY_THRESHOLD = 0.3;

/**
 * Finds the closest product in our scraped catalog to an arbitrary name from
 * the app's own curated catalog (which uses different naming/granularity
 * than Woolworths' raw listing names). Returns null below the similarity
 * threshold rather than a low-confidence guess.
 */
async function findBestProductMatch(name) {
  const { rows } = await pool.query(
    `SELECT *, similarity(name, $1) AS match_score
       FROM products
      WHERE similarity(name, $1) >= $2
      ORDER BY match_score DESC
      LIMIT 1`,
    [name, MATCH_SIMILARITY_THRESHOLD]
  );
  return rows[0] || null;
}

/**
 * Weekly avg/min/max price for one product over the last `weeks` weeks,
 * grouped by ISO week (Monday). `on_special` rows are included in the
 * min/avg, same as what a shopper actually paid that week.
 */
async function getWeeklyPriceHistory(productId, weeks) {
  const { rows } = await pool.query(
    `SELECT
       to_char(date_trunc('week', scraped_at), 'YYYY-MM-DD') AS week,
       ROUND(AVG(price)::numeric, 2) AS avg_price,
       MIN(price) AS min_price,
       MAX(price) AS max_price
     FROM price_history
     WHERE product_id = $1
       AND scraped_at >= now() - ($2 || ' weeks')::interval
     GROUP BY date_trunc('week', scraped_at)
     ORDER BY date_trunc('week', scraped_at) ASC`,
    [productId, weeks]
  );
  return rows;
}

module.exports = {
  ensureSchema,
  listProducts,
  getProduct,
  getProductHistory,
  overrideProductPrice,
  unlockProductPrice,
  createProduct,
  deleteProduct,
  findBestProductMatch,
  getWeeklyPriceHistory,
};
