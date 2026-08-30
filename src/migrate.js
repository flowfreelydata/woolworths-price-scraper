'use strict';

/**
 * One-off backfill: reads the CSV history already sitting on the volume
 * (accumulated before Postgres was wired in) and loads it into price_history.
 * Safe to run more than once — insertRows() is ON CONFLICT DO NOTHING against
 * the (scraped_at, search_term, product_id) unique key, so a repeat run of
 * this script against unchanged data inserts zero new rows.
 *
 * Not part of the normal scrape flow (scraper.js writes new rows to Postgres
 * itself going forward) — this exists purely to import history that predates
 * the DB integration. Run manually: `node src/migrate.js`.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureSchema, insertRows, closePool } = require('./db');

/** Minimal RFC4180-ish CSV parser — handles quoted fields containing commas,
 * quotes (escaped as "") and newlines, which is all storage.js's csvEscape()
 * ever produces. Not a general-purpose CSV library; matches exactly what
 * this project writes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // Skip; \n (or EOF) closes the row.
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

async function main() {
  const csvPath = path.join(config.outputDir, 'price_history.csv');
  if (!fs.existsSync(csvPath)) {
    console.log(`[migrate] no CSV found at ${csvPath} — nothing to backfill.`);
    return;
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  const table = parseCsv(text);
  if (table.length < 2) {
    console.log('[migrate] CSV has no data rows — nothing to backfill.');
    return;
  }

  const header = table[0];
  const dataRows = table.slice(1).map((cols) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cols[idx] ?? '';
    });
    return obj;
  });

  console.log(`[migrate] parsed ${dataRows.length} row(s) from ${csvPath}`);

  await ensureSchema();
  const inserted = await insertRows(dataRows);
  console.log(`[migrate] done. ${inserted} new row(s) inserted, ${dataRows.length - inserted} already present (skipped).`);

  await closePool();
}

main().catch((err) => {
  console.error('[migrate] fatal error:', err);
  process.exitCode = 1;
});
