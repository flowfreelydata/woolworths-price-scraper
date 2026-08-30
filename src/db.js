'use strict';

const { Pool } = require('pg');
const config = require('./config');

/**
 * Lazily-created singleton pool. A scraper run is short-lived (one process,
 * one run, then exit) so a small pool is plenty — this just avoids opening a
 * fresh connection per query within that one run. The API server (long-lived)
 * reuses the same module and gets the benefit of a real pool.
 */
let pool = null;

function getPool() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — getPool() should not be called.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Railway's official Postgres template (postgres-ssl) terminates TLS
      // with a self-signed cert — rejectUnauthorized:false trusts it without
      // requiring a CA bundle, which is the normal tradeoff for a managed
      // single-tenant database reached over its own provider's network.
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/**
 * Idempotent — safe to call at the start of every run (and from a long-lived
 * process like the API server on startup). Two tables:
 *
 *  - price_history: append-only log, one row per (product, search term, run).
 *    This is the source of truth for "what did this cost over time".
 *  - products: one row per product_id — the current/latest known state.
 *    This is what a consumer (the API, an iOS app) reads for "what does this
 *    cost right now" without having to aggregate the log. `price_locked`
 *    is what makes a manual price correction stick: once true, the scraper's
 *    upsert stops touching price/was_price/on_special/unit_price for that
 *    product (everything else — name, image, url — keeps auto-updating from
 *    the freshest scrape).
 *
 * ADD COLUMN IF NOT EXISTS statements exist alongside the CREATE TABLE so this
 * stays safe to run against a table that already existed before a column was
 * added (e.g. image_url, added after price_history's first deploy).
 */
async function ensureSchema() {
  const db = getPool();

  await db.query(`
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
  await db.query(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_scraped_at ON price_history (scraped_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history (product_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_term ON price_history (search_term);`);

  await db.query(`
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
  await db.query(`CREATE INDEX IF NOT EXISTS idx_products_search_term ON products (search_term);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products (updated_at);`);
}

function toNullableNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  return v === true || v === 'true' || v === 't' || v === '1';
}

/**
 * Inserts rows inside a single transaction, in array order (so id — and
 * therefore natural ORDER BY id — reflects the order they were scraped in).
 * ON CONFLICT DO NOTHING makes this safe to re-run against the same data
 * (used by both the live scraper and the one-off CSV backfill in migrate.js).
 * Returns the count of rows actually inserted (duplicates excluded).
 */
async function insertRows(rows) {
  if (!rows.length) return 0;
  const db = getPool();
  const client = await db.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO price_history
           (scraped_at, search_term, product_id, name, image_url, price, was_price, on_special, unit_price, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (scraped_at, search_term, product_id) DO NOTHING`,
        [
          r.scraped_at,
          r.search_term,
          r.product_id,
          r.name,
          r.image_url || null,
          toNullableNumber(r.price),
          toNullableNumber(r.was_price),
          toBool(r.on_special),
          r.unit_price || null,
          r.url || null,
        ]
      );
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return inserted;
}

/**
 * Upserts the "current state" table from a run's scraped rows. Price fields
 * are skipped for any product with price_locked = true — that's the whole
 * mechanism behind "I can manually override the price if it's wrong": once
 * someone corrects it (UPDATE products SET price = ..., price_locked = true
 * WHERE product_id = ...), future scrapes stop stomping on that field until
 * it's explicitly unlocked again. Name/image/url keep auto-updating either
 * way, since those aren't what a manual price fix is protecting.
 */
async function upsertProducts(rows) {
  if (!rows.length) return 0;
  const db = getPool();
  const client = await db.connect();
  let upserted = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO products
           (product_id, name, image_url, url, search_term, price, was_price, on_special, unit_price, last_scraped_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (product_id) DO UPDATE SET
           name = EXCLUDED.name,
           image_url = COALESCE(EXCLUDED.image_url, products.image_url),
           url = EXCLUDED.url,
           search_term = EXCLUDED.search_term,
           last_scraped_at = EXCLUDED.last_scraped_at,
           updated_at = now(),
           price = CASE WHEN products.price_locked THEN products.price ELSE EXCLUDED.price END,
           was_price = CASE WHEN products.price_locked THEN products.was_price ELSE EXCLUDED.was_price END,
           on_special = CASE WHEN products.price_locked THEN products.on_special ELSE EXCLUDED.on_special END,
           unit_price = CASE WHEN products.price_locked THEN products.unit_price ELSE EXCLUDED.unit_price END`,
        [
          r.product_id,
          r.name,
          r.image_url || null,
          r.url || null,
          r.search_term,
          toNullableNumber(r.price),
          toNullableNumber(r.was_price),
          toBool(r.on_special),
          r.unit_price || null,
          r.scraped_at,
        ]
      );
      upserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return upserted;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, ensureSchema, insertRows, upsertProducts, closePool };
