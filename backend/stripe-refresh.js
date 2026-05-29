/**
 * Stripe → Firestore incremental refresh.
 *
 * Reads the latest `created` timestamp from the cache, calls Stripe's
 * /v1/charges?created[gt]=<ts> in paginated batches, writes new docs to
 * Firestore in batches of 500, and merges them into the in-memory cache.
 *
 * Idempotent: dedupes by charge ID. Safe to call repeatedly.
 */

import { getDb } from './firebase.js';
import { getCachedCharges, appendToCache, recordRefresh } from './cache.js';
import { enrichCharges } from './stripe-enrich.js';

const COLLECTION = 'charges';
const STRIPE_BASE = 'https://api.stripe.com/v1';
const PAGE_SIZE = 100;
const FIRESTORE_BATCH = 500;
const MAX_PAGES = 1000; // safety stop; 100k charges max per refresh

function getStripeKey() {
  const key = process.env.STRIPE_KEY;
  if (!key) throw new Error('STRIPE_KEY env var is not set.');
  return key;
}

/** Map a Stripe charge object into the shape we store in Firestore. */
function mapStripeCharge(c) {
  if (!c.paid && !c.refunded && c.status !== 'succeeded') return null;
  const amount = (c.amount || 0) / 100;
  const amountRefunded = (c.amount_refunded || 0) / 100;
  let status;
  if (c.refunded || amountRefunded > 0) status = 'Refunded';
  else if (c.status === 'succeeded' && c.paid) status = 'Paid';
  else return null;

  let customerId = '';
  let customerEmail = '';
  if (c.customer) {
    if (typeof c.customer === 'object') {
      customerId = c.customer.id || '';
      customerEmail = (c.customer.email || '').toLowerCase();
    } else {
      customerId = c.customer;
    }
  }
  if (!customerEmail && c.billing_details?.email) customerEmail = c.billing_details.email.toLowerCase();
  if (!customerEmail && c.receipt_email) customerEmail = c.receipt_email.toLowerCase();

  const invoice = c.invoice || '';
  return {
    id: c.id,
    created: c.created,
    amount,
    amount_refunded: amountRefunded,
    currency: c.currency || '',
    status,
    description: c.description || '',
    customer_id: customerId,
    customer_email: customerEmail,
    invoice_id: invoice,
    channel: invoice ? 'native_stripe_sub' : 'kartra_orchestrated',
    source: 'stripe_api',
  };
}

async function fetchStripePage({ key, sinceTs, startingAfter }) {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.append('expand[]', 'data.customer');
  if (sinceTs > 0) params.set('created[gt]', String(sinceTs));
  if (startingAfter) params.set('starting_after', startingAfter);
  const url = `${STRIPE_BASE}/charges?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function getLatestTimestamp() {
  const charges = getCachedCharges();
  let max = 0;
  for (const c of charges) {
    const v = parseInt(c.created, 10);
    if (v > max) max = v;
  }
  return max;
}

async function writeBatchToFirestore(rows) {
  if (!rows.length) return;
  const db = getDb();
  for (let i = 0; i < rows.length; i += FIRESTORE_BATCH) {
    const chunk = rows.slice(i, i + FIRESTORE_BATCH);
    const batch = db.batch();
    for (const r of chunk) {
      const ref = db.collection(COLLECTION).doc(r.id);
      batch.set(ref, r, { merge: true });
    }
    await batch.commit();
  }
}

/**
 * Public entry: pull charges from Stripe since cache's max timestamp,
 * persist them, update the cache. Returns a summary.
 */
export async function refreshFromStripe() {
  const key = getStripeKey();
  const sinceTs = getLatestTimestamp();
  const t0 = Date.now();
  console.log(`[refresh] starting; sinceTs=${sinceTs} (${sinceTs ? new Date(sinceTs * 1000).toISOString() : 'epoch'})`);

  const fresh = [];
  let scanned = 0;
  let startingAfter = null;
  let pages = 0;

  while (pages < MAX_PAGES) {
    pages++;
    const data = await fetchStripePage({ key, sinceTs, startingAfter });
    const page = data?.data || [];
    if (!page.length) break;
    for (const c of page) {
      scanned++;
      const row = mapStripeCharge(c);
      if (row) fresh.push(row);
    }
    if (!data.has_more) break;
    startingAfter = page[page.length - 1].id;
  }

  // Write to Firestore, then merge into cache
  await writeBatchToFirestore(fresh);
  const { added, updated } = appendToCache(fresh);

  // Attribute any newly-arrived native subs (resolve product via invoice)
  let enrichedCount = 0;
  try {
    const e = await enrichCharges(fresh);
    enrichedCount = e.enriched;
  } catch (err) {
    console.error('[refresh] native-sub enrichment failed (non-fatal):', err.message);
  }

  const result = {
    sinceTs,
    pages,
    scanned,
    fetched: fresh.length,
    added,
    updated,
    enriched: enrichedCount,
    durationMs: Date.now() - t0,
    finishedAt: new Date().toISOString(),
  };
  recordRefresh(result);
  console.log(`[refresh] done: ${JSON.stringify(result)}`);
  return result;
}
