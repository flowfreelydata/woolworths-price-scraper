'use strict';

const { Pool } = require('pg');
const config = require('./config');

/**
 * Lazily-created singleton pool. A scraper run is short-lived (one process,
 * one run, then exit) so a small pool is plenty — this just avoids opening a
 * fresh connection per query within that one run.
 */
let pool = null;

function getPool() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — getPool() should not be called.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Railway's internal network doesn't terminate TLS on the private
      // Postgres endpoint; the public proxy also works without it. Leaving
      // SSL off matches how the DATABASE_URL is provisioned (no sslmode=require).
      ssl: false,
      max: 5,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/**
 * Idempotent — safe to call at the start of every run. The UNIQUE constraint
 * is what makes repeat inserts of the same run's rows (e.g. after a mid-run
 * crash + retry, or the one-off CSV backfill) a no-op instead of a duplicate:
 * a row is uniquely identified by "this product, under this search term, as
 * of this run's timestamp".
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
      price NUMERIC(10,2) NOT NULL,
      was_price NUMERIC(10,2),
      on_special BOOLEAN NOT NULL DEFAULT FALSE,
      unit_price TEXT,
      url TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scraped_at, search_term, product_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_scraped_at ON price_history (scraped_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history (product_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_term ON price_history (search_term);`);
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
           (scraped_at, search_term, product_id, name, price, was_price, on_special, unit_price, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (scraped_at, search_term, product_id) DO NOTHING`,
        [
          r.scraped_at,
          r.search_term,
          r.product_id,
          r.name,
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

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, ensureSchema, insertRows, closePool };
