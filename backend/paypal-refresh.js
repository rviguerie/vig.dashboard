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
  const out = [];
  for (const t of await fetchWindowRaw(startDate, endDate)) {
    const row = mapPayPalTxn(t);
    if (row) out.push(row);
  }
  return out;
}

/** Every PayPal transaction (unmapped) in one ≤31-day window. */
async function fetchWindowRaw(startDate, endDate) {
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
    out.push(...(j.transaction_details || []));
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

// ─── Public: new subscribers of given PayPal plans (for the /ads page) ──
const subCache = new Map(); // subscription ID → { plan_id, create_time, start_time, subscriber }
async function getSubscription(id) {
  if (subCache.has(id)) return subCache.get(id);
  const token = await getAccessToken();
  const res = await fetch(`${PP_BASE}/v1/billing/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`PayPal subscription ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const sub = { plan_id: j.plan_id, create_time: j.create_time, start_time: j.start_time, subscriber: j.subscriber, custom_id: j.custom_id || '' };
  subCache.set(id, sub);
  return sub;
}

/**
 * New PayPal subscribers of `planIds` whose subscription started in
 * [from, to) (unix seconds) and who paid in that range. One per payer.
 * Returns { sales: [{ country, email, subscription, created, ref }], warnings }.
 * `ref` is the ad tag the sales page put in the subscription's custom_id
 * ("<ad set id>__<ad id>", same as Stripe's client_reference_id), or ''.
 * PayPal's transaction data runs about 3 hours behind.
 */
export async function paypalPlanSales(from, to, planIds) {
  const warnings = [];
  const diag = { transactions: 0, euroPayments: 0, noSubId: 0, subPayments: 0, otherPlan: 0, renewals: 0 };
  const otherPlans = new Map();
  const end = Math.min(to, Math.floor(Date.now() / 1000));
  const raw = [];
  for (let s = from; s < end; s += 30 * 86400) {
    const e = Math.min(s + 30 * 86400, end);
    raw.push(...await fetchWindowRaw(new Date(s * 1000), new Date(e * 1000)));
    if (e < end) await sleep(300);
  }
  diag.transactions = raw.length;
  // Earliest subscription payment per subscription ID in the range.
  const bySub = new Map();
  for (const t of raw) {
    const ti = t.transaction_info || {};
    if (!PAYMENT_CODES.has(ti.transaction_event_code || '')) continue;
    // Only euro payments near the €39 price (skips other products before reading each subscription).
    const amt = parseFloat(ti.transaction_amount?.value || '0');
    if ((ti.transaction_amount?.currency_code || '').toUpperCase() !== 'EUR' || amt < 30 || amt > 50) continue;
    diag.euroPayments++;
    // The subscription ID (I-...) is usually the reference ID with type SUB,
    // but PayPal does not always set the type, so also accept any I- ID.
    const subId = [ti.paypal_reference_id, ti.custom_field, ti.invoice_id]
      .find((v) => typeof v === 'string' && /^I-[A-Z0-9]+$/i.test(v.trim()));
    if (!subId) { diag.noSubId++; continue; }
    diag.subPayments++;
    const created = Math.floor(new Date(ti.transaction_initiation_date).getTime() / 1000);
    if (!(created >= from && created < to)) continue;
    const prev = bySub.get(subId.trim());
    if (!prev || created < prev.created) {
      bySub.set(subId.trim(), {
        created,
        email: (t.payer_info?.email_address || '').toLowerCase(),
        country: (t.payer_info?.country_code || '').toUpperCase(),
      });
    }
  }
  const plans = new Set(planIds);
  const seen = new Set();
  const sales = [];
  let planCheckFailed = 0;
  const entries = [...bySub.entries()].sort((a, b) => a[1].created - b[1].created);
  const subs = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(5, entries.length) }, async () => {
    while (next < entries.length) {
      const id = entries[next++][0];
      try { subs.set(id, await getSubscription(id)); } catch (err) {
        planCheckFailed++;
        console.error('[paypal-ads] subscription read failed:', id, err.message);
      }
    }
  }));
  for (const [id, p] of entries) {
    const sub = subs.get(id);
    if (!sub) continue;
    if (!plans.has(sub.plan_id)) {
      diag.otherPlan++;
      otherPlans.set(sub.plan_id, (otherPlans.get(sub.plan_id) || 0) + 1);
      continue;
    }
    const started = Math.floor(new Date(sub.create_time || sub.start_time).getTime() / 1000);
    if (!(started >= from && started < to)) { diag.renewals++; continue; } // renewal of an older subscription
    const email = p.email || (sub.subscriber?.email_address || '').toLowerCase();
    const ident = email || sub.subscriber?.payer_id || id;
    if (seen.has(ident)) continue;
    seen.add(ident);
    const country = p.country || (sub.subscriber?.shipping_address?.address?.country_code || '').toUpperCase();
    sales.push({ country, email, subscription: id, created: p.created, ref: sub.custom_id || '' });
  }
  if (planCheckFailed) {
    warnings.push(`Could not read ${planCheckFailed} PayPal subscription(s), so they are not counted. The PayPal app may need the Subscriptions permission.`);
  }
  console.log('[paypal-ads]', JSON.stringify({ ...diag, otherPlans: Object.fromEntries(otherPlans), sales: sales.length }));
  if (!sales.length) {
    const op = [...otherPlans.entries()].map(([k, v]) => `${k} (${v})`).join(', ');
    warnings.push(`PayPal check: ${diag.transactions} transactions, ${diag.euroPayments} euro payments of €30–50, ` +
      `${diag.subPayments} with a subscription ID, ${diag.renewals} renewals, ${diag.otherPlan} on other plans` +
      (op ? ` (${op})` : '') + ', 0 new €39 PayPal sales counted.');
  }
  return { sales, warnings };
}
