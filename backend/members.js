/**
 * "Where members come from" — Atomic Homework member sources.
 *
 * Two Stripe accounts feed this:
 *   main        (STRIPE_KEY)             store, upsell sequence, daily emails
 *   thrivecart  (STRIPE_THRIVECART_KEY)  every sale is the one-click upsell
 *                                        after the Atomic Word Dictionary ad
 *
 * Subscriptions are pulled incrementally into the `atomic_subs` Firestore
 * collection (one doc per subscription) and mirrored in memory. The member
 * list is then built on demand:
 *
 * Members count on their FIRST PAID payment (free trials cancelled before
 * paying are not members), one per customer (email, else customer ID):
 *
 *   thrivecart  every paying customer → 'dictionary_ad_upsell' (upsell page)
 *   main        first paid Atomic Homework payment in the `charges` ledger
 *               (Stripe, Kartra-orchestrated and PayPal).
 *               Dictionary buyers (bought the Atomic Word Dictionary before
 *               signing up), timed from their FIRST dictionary purchase:
 *                 1. the "AWD Upsell" price, or signed up within 1 hour
 *                    → 'dictionary_ad_upsell' (upsell page)
 *                 2. signed up between 1 hour and 6 days later
 *                    → 'upsell_email' (Kartra upsell sequence, runs 5 days)
 *                 3. signed up more than 6 days later → 'daily_email'
 *               Everyone else, in order:
 *                 1. the metadata.source tag on the subscription that payment
 *                    belongs to (tagged checkout links, see source-links.js)
 *                 2. the "AWD Upsell" price → 'dictionary_ad_upsell'
 *                 3. first payment €49 → 'store', €29 → 'launch_promo'
 *                 4. first payment €39 → 'daily_email'
 *                 5. anything else → 'store_or_daily' (unknown)
 */

import { getDb } from './firebase.js';
import { getCachedCharges } from './cache.js';

const COLLECTION = 'atomic_subs';
const STRIPE_BASE = 'https://api.stripe.com/v1';
const FIRESTORE_BATCH = 500;
const MAX_PAGES = 1000;
const SIGNUP_WINDOW = 10 * 86400;  // first payment can come up to 10 days after sign-up (7-day free trial)
const UPSELL_PAGE_WINDOW = 3600;     // joined ≤1h after the first dictionary purchase = one-click upsell page
const UPSELL_SEQ_WINDOW = 6 * 86400; // joined ≤6 days after it = Kartra upsell sequence (runs 5 days); later = daily emails
// Untagged members are sorted by the price of their first payment. Prices have
// been stable: €49 only on the store, €39 in the emails, and €29 only in the
// launch promotion email about a year ago.
const STORE_PRICE = 49;
const EMAIL_PRICE = 39;
const LAUNCH_PROMO_PRICE = 29;
const priceIs = (amount, p) => amount != null && Math.abs(amount - p) < 0.01;

export const SOURCES = {
  store: 'Store',
  upsell_email: 'Upsell sequence',
  daily_email: 'Daily emails',
  launch_promo: 'Launch promotion email (€29)',
  store_or_daily: 'Store or daily email (unknown)',
  dictionary_ad_upsell: 'Upsell page',
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
const fullScanned = {};    // account → true once this process has read every subscription

const isAtomicHomework = (name) => /atomic\s*homework/i.test(name || '');
// "AWD Upsell" at €39 is Atomic Homework sold as the dictionary one-click upsell.
const isAwdUpsell = (name, amount) => /awd\s*upsell/i.test(name || '') && Math.abs((amount || 0) - 39) < 0.01;
const isDictionary = (desc) => /atomic word dictionary|word dictionary/i.test(desc || '');
// ThriveCart €7 dictionary, €9 order bump and €16 (both) are not Atomic Homework revenue.
const isDictAmount = (amount) => [7, 9, 16].some((p) => priceIs(amount, p));

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

const subProductIds = (s) => (s.items?.data || []).map((it) => {
  const p = it.price?.product ?? it.plan?.product;
  return typeof p === 'object' && p ? p.id : p || '';
}).filter(Boolean);

/**
 * Product id → name for every product these subscriptions use. Lists all
 * products, then looks up any id the list didn't include one by one.
 */
async function productNames(key, raw) {
  const products = await listAll(key, '/products', []);
  const names = new Map(products.map((p) => [p.id, p.name || '']));
  const missing = [...new Set(raw.flatMap(subProductIds))].filter((id) => !names.has(id));
  for (const id of missing) {
    try {
      const p = await stripeGet(key, `/products/${id}`);
      names.set(id, p.name || '');
    } catch (err) {
      console.error(`[members] product ${id} lookup failed:`, err.message);
    }
  }
  return names;
}

function subNames(s, names) {
  const items = s.items?.data || [];
  return [
    ...subProductIds(s).map((id) => names?.get(id) || ''),
    ...items.map((it) => it.price?.nickname || it.plan?.nickname || ''),
  ].filter(Boolean);
}

/** Price of the subscription's first item in euros (null if unknown). */
function firstItemAmount(s) {
  const it = s.items?.data?.[0];
  const cents = it?.price?.unit_amount ?? it?.plan?.amount;
  return cents == null ? null : cents / 100;
}

function mapSubscription(account, s, names) {
  const productIds = subProductIds(s);
  const productName = names ? productIds.map((id) => names.get(id) || '').find(Boolean) || '' : '';
  const tag = (s.metadata?.source || '').trim().toLowerCase();
  // "AWD Upsell" is the name of the €39 price used for the dictionary one-click upsell
  // (it sits on an Atomic Homework product), so check the price name as well as the product name.
  const awd = (s.items?.data || []).some((it) => {
    const p = it.price?.product ?? it.plan?.product;
    const amount = (it.price?.unit_amount ?? it.plan?.amount ?? 0) / 100;
    return [names?.get(typeof p === 'object' && p ? p.id : p), it.price?.nickname, it.plan?.nickname]
      .some((n) => isAwdUpsell(n, amount));
  });
  // Tagged checkout links are only made for Atomic Homework, so a tag counts even if the product is named differently.
  if (ACCOUNTS[account].atomicOnly && !TAGGABLE.has(tag) && !awd && !subNames(s, names).some(isAtomicHomework)) return null;

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
    awd_upsell: awd,
    amount: firstItemAmount(s),
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
      // First sync after each restart re-reads everything, so a changed matching rule
      // (e.g. a new product name) also applies to older subscriptions.
      const sinceTs = !fullScanned[account] ? 0 : subs.filter((s) => s.account === account)
        .reduce((m, s) => Math.max(m, s.created || 0), scannedUntil[account] || 0);
      const params = [['status', 'all'], ['expand[]', 'data.customer']];
      if (sinceTs) params.push(['created[gt]', String(sinceTs)]);
      const raw = await listAll(key, '/subscriptions', params);
      let names = null;
      if (raw.length) {
        try { names = await productNames(key, raw); } catch (err) {
          if (cfg.atomicOnly) throw new Error('could not read products (key needs Products: Read): ' + err.message);
        }
      }
      const rows = raw.map((s) => mapSubscription(account, s, names)).filter(Boolean);
      const skipped = raw.length - rows.length;
      result[account] = { scanned: raw.length, added: await persist(rows), skipped };
      if (skipped) {
        // Show what was skipped so a naming mismatch is visible in the logs.
        const seen = {};
        for (const s of raw) for (const n of (subNames(s, names).length ? subNames(s, names) : ['(no product name)'])) seen[n] = (seen[n] || 0) + 1;
        result[account].namesSeen = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ×${c}`);
      }
      // Only move the cursor past subscriptions we kept: if none matched, the next sync retries them.
      if (rows.length) for (const s of raw) scannedUntil[account] = Math.max(scannedUntil[account] || 0, s.created || 0);
      fullScanned[account] = true;
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
  const { buyers, ...out } = analyse();
  return out;
}

/**
 * Dictionary buyers who became paying Atomic Homework members after their
 * first dictionary purchase: Map(ident → { bought, joined, source, cents }),
 * `cents` = everything they have paid for Atomic Homework so far (net of
 * refunds). Server-side only (keys are emails).
 */
export function dictionaryBuyerSales() {
  return analyse().buyers;
}

function analyse() {
  const members = [];
  // Members are counted on their first paid Atomic Homework payment, so free
  // trials that are cancelled before paying are not counted.
  const tcJoin = new Map();     // ThriveCart: ident → first paid charge
  const join = new Map();       // main: ident → first paid charge (unix s)
  const joinVia = new Map();    // ident → 'paypal' | 'stripe' (how that first payment was made)
  const joinAmount = new Map(); // ident → amount of that first payment
  const joinAwd = new Set();    // idents whose first payment was the €39 "AWD Upsell"
  const mainSubs = new Map();   // ident → [subs]
  const dictBuys = new Map();   // ident → [dictionary purchase times]
  const ahCents = new Map();    // ident → Atomic Homework paid so far (cents, net of refunds)
  const addCents = (id, net) => ahCents.set(id, (ahCents.get(id) || 0) + Math.round(net * 100));
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
    if (c.status !== 'Paid' || net <= 0) continue;
    if (c.channel === 'thrivecart') {
      // Every ThriveCart sale is the Atomic Homework upsell.
      if (!isDictionary(c.description) && (!tcJoin.has(id) || ts < tcJoin.get(id))) tcJoin.set(id, ts);
      if (!isDictionary(c.description) && !isDictAmount(parseFloat(c.amount))) addCents(id, net);
      continue;
    }
    const awd = isAwdUpsell(c.description, parseFloat(c.amount) || 0);
    if (!(awd || isAtomicHomework(c.description))) continue;
    addCents(id, net);
    if (!join.has(id) || ts < join.get(id)) {
      join.set(id, ts);
      joinVia.set(id, c.channel === 'paypal' ? 'paypal' : 'stripe');
      joinAmount.set(id, parseFloat(c.amount) || 0);
      if (awd) joinAwd.add(id); else joinAwd.delete(id);
    }
  }
  const joinedAs = new Map();   // ident → { date, source } of their earliest membership (either account)
  const noteJoin = (id, date, source) => {
    const cur = joinedAs.get(id);
    if (!cur || date < cur.date) joinedAs.set(id, { date, source });
  };
  for (const [id, date] of tcJoin) {
    members.push({ date, account: 'thrivecart', source: 'dictionary_ad_upsell', via: 'stripe' });
    noteJoin(id, date, 'dictionary_ad_upsell');
  }
  for (const s of subs) {
    if (s.account !== 'main') continue;
    const id = identOf(s.customer_email, s.customer_id);
    if (!id) continue;
    if (!mainSubs.has(id)) mainSubs.set(id, []);
    mainSubs.get(id).push(s);
  }

  let tagged = 0;
  let paypal = 0;
  for (const [id, date] of join) {
    // The subscription this first payment belongs to: started on or before it,
    // at most SIGNUP_WINDOW earlier (covers the 7-day free trial).
    const signup = (mainSubs.get(id) || [])
      .filter((s) => s.start <= date + 86400 && date - s.start <= SIGNUP_WINDOW)
      .sort((a, b) => a.start - b.start)[0];
    const signedUp = signup ? Math.min(signup.start, date) : date;
    const via = joinVia.get(id) || 'stripe';
    const amount = joinAmount.get(id);
    // Dictionary buyers are timed from their first dictionary purchase (5 minutes' grace for clock order).
    const firstDict = Math.min(Infinity, ...(dictBuys.get(id) || []));
    const awd = joinAwd.has(id) || signup?.awd_upsell;
    let source;
    if (firstDict <= signedUp + 300) {
      if (awd || signedUp - firstDict <= UPSELL_PAGE_WINDOW) source = 'dictionary_ad_upsell';
      else if (signedUp - firstDict <= UPSELL_SEQ_WINDOW) source = 'upsell_email';
      else source = 'daily_email';
    }
    else if (signup && TAGGABLE.has(signup.source_tag)) { source = signup.source_tag; tagged++; }
    else if (awd) source = 'dictionary_ad_upsell';
    else if (priceIs(amount, STORE_PRICE)) source = 'store';
    else if (priceIs(amount, LAUNCH_PROMO_PRICE)) source = 'launch_promo';
    else if (priceIs(amount, EMAIL_PRICE)) source = 'daily_email';
    else source = 'store_or_daily';
    if (via === 'paypal') paypal++;
    members.push({ date, account: 'main', source, via });
    noteJoin(id, date, source);
  }

  members.sort((a, b) => a.date - b.date);

  // Dictionary buyers → Atomic Homework: one row per dictionary buyer, dated by
  // their first dictionary purchase. `joined`/`source` are set when they became
  // a paying member after it; `already` when they were a member before.
  const dictionary = [];
  const buyers = new Map();
  for (const [id, times] of dictBuys) {
    const bought = Math.min(...times);
    const j = joinedAs.get(id);
    if (!j) dictionary.push({ bought });
    else if (j.date >= bought - 300) {
      dictionary.push({ bought, joined: j.date, source: j.source });
      buyers.set(id, { bought, joined: j.date, source: j.source, cents: ahCents.get(id) || 0 });
    }
    else dictionary.push({ bought, already: true });
  }
  dictionary.sort((a, b) => a.bought - b.bought);
  return {
    buyers,
    members,
    dictionary,
    stats: {
      thrivecartSubs: subs.filter((s) => s.account === 'thrivecart').length,
      mainSubs: subs.filter((s) => s.account === 'main').length,
      dictionaryBuyers: dictBuys.size,
      taggedMembers: tagged,
      paypalMembers: paypal,
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
