'use strict';

/**
 * One-off backfill: reads the CSV history already sitting on the volume
 * (accumulated before Postgres was wired in) and loads it into price_history
 * and products. Safe to run more than once — insertRows()/upsertProducts()
 * are conflict-safe against their respective unique keys, so a repeat run
 * against unchanged data inserts/changes nothing.
 *
 * Not part of the normal scrape flow (scraper.js writes new rows itself going
 * forward) — this exists purely to import history that predates the DB
 * integration. Run manually: `node src/migrate.js`.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { CSV_HEADER } = require('./storage');
const { ensureSchema, insertRows, upsertProducts, closePool } = require('./db');

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

/**
 * The file may contain more than one header line: appendHistoryCsv() emits a
 * fresh header as a boundary marker whenever the column set changes (e.g.
 * image_url was added after the first rows were already written), rather
 * than silently appending mismatched columns under a stale header. This
 * walks the table switching the active column mapping at each such boundary,
 * so every row — old format or new — gets mapped by the header that was
 * actually in effect when it was written.
 */
function rowsFromTable(table) {
  if (!table.length) return [];
  let activeHeader = table[0];
  const out = [];

  for (let i = 1; i < table.length; i++) {
    const cols = table[i];
    const isHeaderBoundary = cols.length === CSV_HEADER.length && cols.every((v, idx) => v === CSV_HEADER[idx]);
    if (isHeaderBoundary) {
      activeHeader = CSV_HEADER;
      continue;
    }
    const obj = {};
    activeHeader.forEach((key, idx) => {
      obj[key] = cols[idx] ?? '';
    });
    out.push(obj);
  }
  return out;
}

async function main() {
  const csvPath = path.join(config.outputDir, 'price_history.csv');
  if (!fs.existsSync(csvPath)) {
    console.log(`[migrate] no CSV found at ${csvPath} — nothing to backfill.`);
    return;
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  const table = parseCsv(text);
  const dataRows = rowsFromTable(table);
  if (!dataRows.length) {
    console.log('[migrate] CSV has no data rows — nothing to backfill.');
    return;
  }

  console.log(`[migrate] parsed ${dataRows.length} row(s) from ${csvPath}`);

  await ensureSchema();
  const inserted = await insertRows(dataRows);
  console.log(`[migrate] price_history: ${inserted} new row(s) inserted, ${dataRows.length - inserted} already present (skipped).`);

  // For "current state", only the latest scrape per product should win —
  // upsertProducts already does last-write-wins on conflict, so feeding it
  // rows in their original (chronological) order naturally leaves each
  // product's most recent scrape as the final state.
  const upserted = await upsertProducts(dataRows);
  console.log(`[migrate] products: ${upserted} row(s) upserted.`);

  await closePool();
}

main().catch((err) => {
  console.error('[migrate] fatal error:', err);
  process.exitCode = 1;
});
