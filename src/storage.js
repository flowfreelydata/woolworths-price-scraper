'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  'scraped_at',
  'search_term',
  'product_id',
  'name',
  'image_url',
  'price',
  'was_price',
  'on_special',
  'unit_price',
  'url',
];

function rowsToCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(CSV_HEADER.map((k) => csvEscape(r[k])).join(','));
  }
  return lines.join('\n');
}

function appendHistoryCsv(rows) {
  ensureDir(config.outputDir);
  const filePath = path.join(config.outputDir, 'price_history.csv');
  const currentHeaderLine = CSV_HEADER.join(',');

  // If the file already exists but its header predates a schema change (e.g.
  // image_url was added later), re-emit a fresh header line as a boundary
  // rather than silently appending mismatched columns under the old one —
  // migrate.js understands these boundaries and switches column mapping at
  // each one, so history never gets misaligned even as the schema evolves.
  let needsHeader = true;
  if (fs.existsSync(filePath)) {
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n', 1)[0];
    needsHeader = firstLine !== currentHeaderLine;
  }

  const lines = [];
  if (needsHeader) lines.push(currentHeaderLine);
  for (const r of rows) {
    lines.push(CSV_HEADER.map((k) => csvEscape(r[k])).join(','));
  }
  fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

function writeLatestJson(rows) {
  ensureDir(config.outputDir);
  const filePath = path.join(config.outputDir, 'latest.json');
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
  return filePath;
}

function dumpDebugArtifact(name, content) {
  if (!config.userDataDebug) return null;
  ensureDir(path.join(config.outputDir, 'debug'));
  const filePath = path.join(config.outputDir, 'debug', name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

module.exports = { appendHistoryCsv, writeLatestJson, dumpDebugArtifact, ensureDir, rowsToCsv, CSV_HEADER };
