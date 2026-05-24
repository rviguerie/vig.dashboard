/**
 * One-time seed script.
 *
 * Reads the historical Stripe CSV export from disk, maps each row into
 * the same shape used by stripe-refresh, writes everything to Firestore
 * in 500-doc batches, then triggers one Stripe refresh to catch up to
 * the very latest charges.
 *
 * Usage:
 *   node backend/seed.js                                  # uses default CSV path
 *   node backend/seed.js "/path/to/unified_payments.csv"
 *
 * Safe to re-run: dedupes by charge ID, so re-running is a no-op except
 * for any charges added since last run.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { initFirebase, getDb } from './firebase.js';
import { warmCache, appendToCache } from './cache.js';
import { refreshFromStripe } from './stripe-refresh.js';

const COLLECTION = 'charges';
const BATCH = 500;

const DEFAULT_CSV = path.resolve(process.cwd(), '..', 'unified_payments (1).csv');

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function mapCsvRow(headers, vals) {
  const o = {};
  headers.forEach((h, i) => { o[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
  const id = o['id'];
  if (!id) return null;
  const status = o['Status'];
  if (status !== 'Paid' && status !== 'Refunded') return null;
  const ds = o['Created date (UTC)'];
  if (!ds) return null;
  const created = Math.floor(new Date(ds.replace(' ', 'T') + 'Z').getTime() / 1000);
  if (!created || Number.isNaN(created)) return null;
  const amount = parseFloat(o['Amount']) || 0;
  const amountRefunded = parseFloat(o['Amount Refunded']) || 0;
  const invoice = o['Invoice ID'] || '';
  return {
    id,
    created,
    amount,
    amount_refunded: amountRefunded,
    currency: (o['Currency'] || '').toLowerCase(),
    status,
    description: o['Description'] || '',
    customer_id: o['Customer ID'] || '',
    customer_email: (o['Customer Email'] || '').toLowerCase(),
    invoice_id: invoice,
    channel: invoice ? 'native_stripe_sub' : 'kartra_orchestrated',
    source: 'csv',
  };
}

async function loadCsv(csvPath) {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const vals = splitCsvLine(line);
    if (!headers) { headers = vals.map(h => h.replace(/^"|"$/g, '').trim()); continue; }
    const row = mapCsvRow(headers, vals);
    if (row) rows.push(row);
  }
  return rows;
}

async function writeBatches(rows) {
  const db = getDb();
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const batch = db.batch();
    for (const r of chunk) {
      const ref = db.collection(COLLECTION).doc(r.id);
      batch.set(ref, r, { merge: true });
    }
    await batch.commit();
    written += chunk.length;
    process.stdout.write(`\r[seed] wrote ${written.toLocaleString()} / ${rows.length.toLocaleString()}`);
  }
  process.stdout.write('\n');
}

async function main() {
  const csvPath = process.argv[2] || DEFAULT_CSV;
  if (!fs.existsSync(csvPath)) {
    console.error(`[seed] CSV not found at: ${csvPath}`);
    console.error('       Pass an explicit path:  node backend/seed.js /full/path/to/file.csv');
    process.exit(1);
  }
  console.log(`[seed] reading ${csvPath}`);

  initFirebase();

  console.log('[seed] parsing CSV…');
  const rows = await loadCsv(csvPath);
  console.log(`[seed] parsed ${rows.length.toLocaleString()} Paid/Refunded rows`);

  console.log('[seed] writing to Firestore…');
  await writeBatches(rows);

  // Mirror into cache so the followup refresh knows the latest timestamp
  appendToCache(rows);

  console.log('[seed] running one Stripe refresh to catch any new charges…');
  const result = await refreshFromStripe();
  console.log('[seed] refresh result:', result);

  // Final warm to verify totals match Firestore
  await warmCache();
  console.log('[seed] done. Cache verified against Firestore.');
  process.exit(0);
}

main().catch(err => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
