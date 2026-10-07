/**
 * PayPal → Firestore sync.
 *
 * PayPal's Transaction Search API returns a lot of non-sale bookkeeping
 * rows (currency conversions, payouts, funding). We filter to real inbound
 * payment event codes and treat refund codes separately. Product names come
 * from `transaction_subject` and are normalized to our canonical product set.
 *
 * Constraints baked in:
 *   - Max 31-day window per call → backfill loops in 30-day windows
 *   - ~3 years of history available via API → backfill defaults to 3 years
 *   - ~3-hour data delay → incremental refresh re-scans the last 7 days
 *
 * Exports:
 *   refreshPayPal()        incremental (last 7 days), for the hourly cron
 *   backfillPayPal(years)  one-shot historical seed
 */

import { getDb } from './firebase.js';
import { getCachedCharges, appendToCache } from './cache.js';

const PP_BASE = 'https://api-m.paypal.com';
const COLLECTION = 'charges';
const FIRESTORE_BATCH = 500;

// Real inbound customer payments
const PAYMENT_CODES = new Set(['T0000', 'T0001', 'T0002', 'T0003', 'T0006', 'T0007', 'T0013']);
// Refunds / reversals
const REFUND_CODES = new Set(['T1100', 'T1101', 'T1102', 'T1106', 'T1107', 'T1108']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ─── Auth (token cached in module scope, valid ~9h) ──────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`PayPal OAuth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json();
  cachedToken = j.access_token;
  tokenExpiry = Date.now() + (j.expires_in || 0) * 1000;
  return cachedToken;
}

// ─── Product name normalization ──────────────────────────────────────
// Map PayPal's transaction_subject variants to our canonical product names
// (kept in sync with the dashboard's PRICE_RULES keys).
function normalizeProductName(subject) {
  const s = (subject || '').trim();
  if (!s || s.startsWith('~@~')) return '';
  const low = s.toLowerCase();
  if (low.includes('atomic homework')) return 'Mr. Vigs Atomic Homework';
  if (low.includes('vitamin v')) return 'Vitamin V EXTRA STRENGTH';
  if (low.includes('speaking school')) return 'Speaking School';
  if (low.includes('vig village') &&
      !low.includes('golden visa') &&
      !low.includes('vocabulary') &&
      !low.includes('accelerator')) {
    return 'Vig Village';
  }
  return s; // keep original → falls into "Other" bucket on the dashboard
}

// ─── Map a PayPal transaction to our charge schema ───────────────────
function mapPayPalTxn(t) {
  const ti = t.transaction_info || {};
  const pi = t.payer_info || {};
  const code = ti.transaction_event_code || '';
  const amt = parseFloat(ti.transaction_amount?.value || '0');
  const currency = (ti.transaction_amount?.currency_code || '').toLowerCase();
  const dateStr = ti.transaction_initiation_date;
  const txId = ti.transaction_id;
  if (!txId || !dateStr) return null;
  const created = Math.floor(new Date(dateStr).getTime() / 1000);
  if (!created || Number.isNaN(created)) return null;

  const isPayment = PAYMENT_CODES.has(code) && amt > 0;
  const isRefund = REFUND_CODES.has(code);
  if (!isPayment && !isRefund) return null; // skip conversions, payouts, funding, fees

  const email = (pi.email_address || '').toLowerCase();
  const customerId = pi.account_id || ti.paypal_account_id || '';
  const product = normalizeProductName(ti.transaction_subject);
  // Keep PayPal's own names: they may say which page or offer the sale came from.
  const itemNames = (t.cart_info?.item_details || []).map((i) => i.item_name).filter(Boolean).join(' | ');

  const base = {
    id: txId,
    created,
    currency,
    description: product,
    customer_id: customerId,
    customer_email: email,
    invoice_id: '', // PayPal has no Stripe-style invoice; channel set explicitly
    raw_description: ti.transaction_subject || '',
    item_names: itemNames,
    custom_field: ti.custom_field || '',
    channel: 'paypal',
    source: 'paypal_api',
  };
  if (isRefund) {
    return { ...base, amount: 0, amount_refunded: Math.abs(amt), status: 'Refunded' };
  }
  return { ...base, amount: amt, amount_refunded: 0, status: 'Paid' };
}

// ─── Paginated transaction fetch for one ≤31-day window ──────────────
async function fetchWindow(startDate, endDate) {
  const token = await getAccessToken();
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({
      start_date: isoNoMs(startDate),
      end_date: isoNoMs(endDate),
      fields: 'all',
      page_size: '500',
      page: String(page),
    });
    const res = await fetch(`${PP_BASE}/v1/reporting/transactions?${params}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PayPal txn search ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    totalPages = j.total_pages || 1;
    for (const t of j.transaction_details || []) {
      const row = mapPayPalTxn(t);
      if (row) out.push(row);
    }
    page++;
    if (page <= totalPages) await sleep(300);
  } while (page <= totalPages);
  return out;
}

// ─── Firestore write + cache merge ───────────────────────────────────
async function persist(rows) {
  if (!rows.length) return { added: 0, updated: 0 };
  // Dedupe within this batch by id (keep last)
  const byId = new Map();
  for (const r of rows) byId.set(r.id, r);
  const unique = [...byId.values()];

  const db = getDb();
  for (let i = 0; i < unique.length; i += FIRESTORE_BATCH) {
    const chunk = unique.slice(i, i + FIRESTORE_BATCH);
    const batch = db.batch();
    for (const r of chunk) batch.set(db.collection(COLLECTION).doc(r.id), r, { merge: true });
    await batch.commit();
  }
  return appendToCache(unique);
}

// ─── Public: incremental refresh (hourly cron) ───────────────────────
export async function refreshPayPal() {
  const t0 = Date.now();
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000); // last 7 days (covers the ~3h delay)
  console.log(`[paypal-refresh] scanning ${isoNoMs(start)} → ${isoNoMs(end)}`);
  const existing = new Set(getCachedCharges().map((c) => String(c.id)));
  const rows = await fetchWindow(start, end);
  const fresh = rows.filter((r) => !existing.has(r.id));
  const { added, updated } = await persist(fresh);
  const result = {
    source: 'paypal',
    scanned: rows.length,
    added,
    updated,
    durationMs: Date.now() - t0,
    finishedAt: new Date().toISOString(),
  };
  console.log(`[paypal-refresh] done: ${JSON.stringify(result)}`);
  return result;
}

// ─── Public: historical backfill (one-shot seed) ─────────────────────
export async function backfillPayPal(yearsBack = 3) {
  const t0 = Date.now();
  const now = new Date();
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - yearsBack);

  let windowStart = new Date(start);
  let totalRows = [];
  let windows = 0;
  let failures = 0;

  while (windowStart < now) {
    let windowEnd = new Date(windowStart.getTime() + 30 * 86400000); // 30d < 31d cap
    if (windowEnd > now) windowEnd = now;
    windows++;
    try {
      const rows = await fetchWindow(windowStart, windowEnd);
      totalRows = totalRows.concat(rows);
      console.log(
        `[paypal-backfill] ${isoNoMs(windowStart).slice(0, 10)} → ${isoNoMs(windowEnd).slice(0, 10)}: ${rows.length} payment/refund rows (running total ${totalRows.length})`
      );
    } catch (e) {
      failures++;
      console.error(`[paypal-backfill] window ${isoNoMs(windowStart).slice(0, 10)} failed: ${e.message}`);
    }
    windowStart = new Date(windowEnd.getTime() + 1000);
    await sleep(400);
  }

  console.log(`[paypal-backfill] fetched ${totalRows.length} rows across ${windows} windows; writing to Firestore…`);
  const { added, updated } = await persist(totalRows);
  const result = {
    source: 'paypal',
    yearsBack,
    windows,
    failures,
    fetched: totalRows.length,
    added,
    updated,
    durationMs: Date.now() - t0,
    finishedAt: new Date().toISOString(),
  };
  console.log(`[paypal-backfill] done: ${JSON.stringify(result)}`);
  return result;
}
