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
  const isNew = !fs.existsSync(filePath);
  const lines = [];
  if (isNew) lines.push(CSV_HEADER.join(','));
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

module.exports = { appendHistoryCsv, writeLatestJson, dumpDebugArtifact, ensureDir, rowsToCsv };
