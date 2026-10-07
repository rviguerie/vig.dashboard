/**
 * "Where members come from" — Atomic Homework member sources.
 *
 * Two Stripe accounts feed this:
 *   main        (STRIPE_KEY)             store, upsell emails, daily emails
 *   thrivecart  (STRIPE_THRIVECART_KEY)  every sale is the one-click upsell
 *                                        after the Atomic Word Dictionary ad
 *
 * Subscriptions are pulled incrementally into the `atomic_subs` Firestore
 * collection (one doc per subscription) and mirrored in memory. The member
 * list is then built on demand:
 *
 *   thrivecart  every subscribing customer → 'dictionary_ad_upsell'
 *   main        one member per customer (email, else Stripe customer ID).
 *               Join date = earliest of their Atomic Homework subscription
 *               start and their first paid Atomic Homework charge in the
 *               existing `charges` ledger (covers Kartra-orchestrated members
 *               who never had a Stripe subscription object). PayPal is left
 *               out since it isn't either Stripe account.
 *               Source:
 *                 1. the subscription's metadata.source tag, set by the
 *                    tagged checkout links (see make-source-links.js)
 *                 2. otherwise, by their last Atomic Word Dictionary purchase
 *                    on or before joining:
 *                      within 1 hour → 'dictionary_ad_upsell' (the one-click
 *                        upsell; the first upsell email goes out after 1 hour)
 *                      earlier → 'upsell_email'
 *                      none → 'store_or_daily'
 */

import { getDb } from './firebase.js';
import { getCachedCharges } from './cache.js';

const COLLECTION = 'atomic_subs';
const STRIPE_BASE = 'https://api.stripe.com/v1';
const FIRESTORE_BATCH = 500;
const MAX_PAGES = 1000;
const TAG_MATCH_WINDOW = 2 * 86400; // a tagged sub counts if it started within 2 days of the join date
const UPSELL_PAGE_WINDOW = 3600;     // joined ≤1h after buying the dictionary = one-click upsell page

export const SOURCES = {
  store: 'Store',
  upsell_email: 'Upsell emails',
  daily_email: 'Daily emails',
  store_or_daily: 'Store or daily email (untagged)',
  dictionary_ad_upsell: 'Dictionary ad upsell (one-click)',
};
const TAGGABLE = new Set(['store', 'upsell_email', 'daily_email']);

const ACCOUNTS = {
  main: { env: 'STRIPE_KEY', atomicOnly: true },
  thrivecart: { env: 'STRIPE_THRIVECART_KEY', atomicOnly: false },
};

let subs = [];             // docs from `atomic_subs`
let byId = new Map();      // doc id → index in `subs`
let warmedAt = null;
let lastSyncAt = null;
let lastSyncResult = null;
const scannedUntil = {};   // account → newest `created` seen this process (incl. non-Atomic subs)

const isAtomicHomework = (name) => /atomic homework/i.test(name || '');
const isDictionary = (desc) => /atomic word dictionary|word dictionary/i.test(desc || '');

// ─── Stripe helpers ──────────────────────────────────────────────────

async function stripeGet(key, pathAndQuery) {
  const res = await fetch(`${STRIPE_BASE}${pathAndQuery}`, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${res.status} on ${pathAndQuery.split('?')[0]}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function listAll(key, path, params) {
  const out = [];
  let startingAfter = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const q = new URLSearchParams(params);
    q.set('limit', '100');
    if (startingAfter) q.set('starting_after', startingAfter);
    const data = await stripeGet(key, `${path}?${q.toString()}`);
    const page = data?.data || [];
    out.push(...page);
    if (!data.has_more || !page.length) break;
    startingAfter = page[page.length - 1].id;
  }
  return out;
}

async function productNames(key) {
  const products = await listAll(key, '/products', []);
  return new Map(products.map((p) => [p.id, p.name || '']));
}

function mapSubscription(account, s, names) {
  const items = s.items?.data || [];
  const productIds = items.map((it) => {
    const p = it.price?.product ?? it.plan?.product;
    return typeof p === 'object' && p ? p.id : p || '';
  });
  const productName = names ? productIds.map((id) => names.get(id) || '').find(Boolean) || '' : '';
  const tag = (s.metadata?.source || '').trim().toLowerCase();
  // Tagged checkout links are only made for Atomic Homework, so a tag counts even if the product is named differently.
  if (ACCOUNTS[account].atomicOnly && !TAGGABLE.has(tag) && !productIds.some((id) => isAtomicHomework(names?.get(id)))) return null;

  let customerId = '';
  let email = '';
  if (typeof s.customer === 'object' && s.customer) {
    customerId = s.customer.id || '';
    email = (s.customer.email || '').toLowerCase();
  } else {
    customerId = s.customer || '';
  }
  return {
    id: `${account}_${s.id}`,
    account,
    sub_id: s.id,
    created: s.created,
    start: s.start_date || s.created,
    customer_id: customerId,
    customer_email: email,
    product_name: productName,
    source_tag: tag,
  };
}

// ─── Firestore + memory ──────────────────────────────────────────────

export async function warmMembers() {
  const snap = await getDb().collection(COLLECTION).get();
  const next = [];
  const idx = new Map();
  snap.forEach((doc) => {
    idx.set(doc.id, next.length);
    next.push({ id: doc.id, ...doc.data() });
  });
  subs = next;
  byId = idx;
  warmedAt = new Date().toISOString();
  console.log(`[members] warmed: ${subs.length} subscriptions`);
}

async function persist(rows) {
  if (!rows.length) return 0;
  const db = getDb();
  for (let i = 0; i < rows.length; i += FIRESTORE_BATCH) {
    const batch = db.batch();
    for (const r of rows.slice(i, i + FIRESTORE_BATCH)) batch.set(db.collection(COLLECTION).doc(r.id), r, { merge: true });
    await batch.commit();
  }
  let added = 0;
  for (const r of rows) {
    const i = byId.get(r.id);
    if (i === undefined) { byId.set(r.id, subs.length); subs.push(r); added++; } else subs[i] = r;
  }
  return added;
}

/**
 * Pull new subscriptions from each configured account. Incremental: only
 * asks Stripe for subscriptions created after the newest one we hold.
 */
export async function syncMembers() {
  const t0 = Date.now();
  const result = {};
  for (const [account, cfg] of Object.entries(ACCOUNTS)) {
    const key = process.env[cfg.env];
    if (!key) { result[account] = { skipped: `${cfg.env} not set` }; continue; }
    try {
      const sinceTs = subs.filter((s) => s.account === account)
        .reduce((m, s) => Math.max(m, s.created || 0), scannedUntil[account] || 0);
      const params = [['status', 'all'], ['expand[]', 'data.customer']];
      if (sinceTs) params.push(['created[gt]', String(sinceTs)]);
      const raw = await listAll(key, '/subscriptions', params);
      const names = raw.length ? await productNames(key).catch(() => null) : null;
      if (raw.length && cfg.atomicOnly && !names) throw new Error('could not read products (key needs Products: Read)');
      const rows = raw.map((s) => mapSubscription(account, s, names)).filter(Boolean);
      result[account] = { scanned: raw.length, added: await persist(rows) };
      for (const s of raw) scannedUntil[account] = Math.max(scannedUntil[account] || 0, s.created || 0);
    } catch (err) {
      console.error(`[members] ${account} sync failed:`, err.message);
      result[account] = { error: err.message };
    }
  }
  lastSyncAt = new Date().toISOString();
  lastSyncResult = { ...result, durationMs: Date.now() - t0 };
  console.log(`[members] sync done: ${JSON.stringify(lastSyncResult)}`);
  return lastSyncResult;
}

// ─── Member list ─────────────────────────────────────────────────────

const identOf = (email, customerId) => email || customerId || '';

/**
 * Build the member list. Returns [{ date, account, source }] with `date`
 * as unix seconds (join date) — no emails leave the server.
 */
export function buildMembers() {
  const members = [];

  // ThriveCart: one member per customer, joined at their first subscription.
  const tc = new Map();
  for (const s of subs) {
    if (s.account !== 'thrivecart') continue;
    const id = identOf(s.customer_email, s.customer_id);
    if (!id) continue;
    if (!tc.has(id) || s.start < tc.get(id)) tc.set(id, s.start);
  }
  for (const date of tc.values()) members.push({ date, account: 'thrivecart', source: 'dictionary_ad_upsell' });

  // Main account: ledger charges + subscriptions.
  const join = new Map();       // ident → earliest join (unix s)
  const mainSubs = new Map();   // ident → [subs]
  const dictBuys = new Map();   // ident → [dictionary purchase times]
  for (const c of getCachedCharges()) {
    if (c.status !== 'Paid' && c.status !== 'Refunded') continue;
    const ts = parseInt(c.created, 10);
    if (!ts) continue;
    const id = identOf((c.customer_email || '').toLowerCase(), c.customer_id);
    if (!id) continue;
    if (isDictionary(c.description)) {
      if (!dictBuys.has(id)) dictBuys.set(id, []);
      dictBuys.get(id).push(ts);
    }
    const net = (parseFloat(c.amount) || 0) - (parseFloat(c.amount_refunded) || 0);
    // ThriveCart charges are counted from that account's subscriptions above.
    if (c.channel === 'paypal' || c.channel === 'thrivecart' || c.status !== 'Paid' || net <= 0 || !isAtomicHomework(c.description)) continue;
    if (!join.has(id) || ts < join.get(id)) join.set(id, ts);
  }
  for (const s of subs) {
    if (s.account !== 'main') continue;
    const id = identOf(s.customer_email, s.customer_id);
    if (!id) continue;
    if (!mainSubs.has(id)) mainSubs.set(id, []);
    mainSubs.get(id).push(s);
    if (!join.has(id) || s.start < join.get(id)) join.set(id, s.start);
  }

  let tagged = 0;
  for (const [id, date] of join) {
    const tagSub = (mainSubs.get(id) || [])
      .filter((s) => TAGGABLE.has(s.source_tag) && Math.abs(s.start - date) <= TAG_MATCH_WINDOW)
      .sort((a, b) => a.start - b.start)[0];
    let source;
    if (tagSub) { source = tagSub.source_tag; tagged++; }
    else {
      const lastDict = Math.max(-Infinity, ...(dictBuys.get(id) || []).filter((t) => t <= date));
      if (!isFinite(lastDict)) source = 'store_or_daily';
      else source = date - lastDict <= UPSELL_PAGE_WINDOW ? 'dictionary_ad_upsell' : 'upsell_email';
    }
    members.push({ date, account: 'main', source });
  }

  members.sort((a, b) => a.date - b.date);
  return {
    members,
    stats: {
      thrivecartSubs: subs.filter((s) => s.account === 'thrivecart').length,
      mainSubs: subs.filter((s) => s.account === 'main').length,
      dictionaryBuyers: dictBuys.size,
      taggedMembers: tagged,
    },
  };
}

export function getMembersMeta() {
  return {
    warmedAt,
    lastSyncAt,
    lastSyncResult,
    configured: Object.fromEntries(Object.entries(ACCOUNTS).map(([a, c]) => [a, !!process.env[c.env]])),
  };
}
