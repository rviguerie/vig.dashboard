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
 *   Any sale of the ThriveCart product "Atomic Homework Daily Email Offer"
 *   (card or PayPal) → 'daily_email'.
 *   thrivecart  every other paying customer → 'dictionary_ad_upsell' (upsell page)
 *   People are matched by email AND Stripe customer ID (linkedIdentity), so
 *   someone who changed email is not counted as a new member.
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
 *                 2. Meta ad checkout (ad-only payment link, or ad tag from the
 *                    sales page) → 'meta_ads'
 *                 3. the "AWD Upsell" price → 'dictionary_ad_upsell'
 *                 3. first payment €49 → 'store', €29 → 'launch_promo',
 *                    €351 → 'app_annual' (annual offer link inside the Vig app)
 *                 4. first payment €39 → 'daily_email'
 *                 5. anything else → 'store_or_daily' (unknown)
 */

import { getDb } from './firebase.js';
import { getCachedCharges } from './cache.js';

const COLLECTION = 'atomic_subs';
const STRIPE_BASE = 'https://api.stripe.com/v1';
const FIRESTORE_BATCH = 500;
const MAX_PAGES = 1000;
const DAY_S = 86400;
const SIGNUP_WINDOW = 10 * 86400;  // first payment can come up to 10 days after sign-up (7-day free trial)
const UPSELL_PAGE_WINDOW = 3600;     // joined ≤1h after the first dictionary purchase = one-click upsell page
const UPSELL_SEQ_WINDOW = 6 * 86400; // joined ≤6 days after it = Kartra upsell sequence (runs 5 days); later = daily emails
// Untagged members are sorted by the price of their first payment. Prices have
// been stable: €49 only on the store, €39 in the emails, and €29 only in the
// launch promotion email about a year ago.
const STORE_PRICE = 49;
const EMAIL_PRICE = 39;
const LAUNCH_PROMO_PRICE = 29;
// €351/year is only offered inside the app (link in the Vig app to the annual offer).
const APP_ANNUAL_PRICE = 351;
const priceIs = (amount, p) => amount != null && Math.abs(amount - p) < 0.01;

export const SOURCES = {
  store: 'Store',
  upsell_email: 'Upsell sequence',
  daily_email: 'Daily emails',
  launch_promo: 'Launch promotion email (€29)',
  app_annual: 'In-app sales (€351)',
  meta_ads: 'Meta ads',
  store_or_daily: 'Store or daily email (unknown)',
  dictionary_ad_upsell: 'Upsell page',
};
const TAGGABLE = new Set(['store', 'upsell_email', 'daily_email']);

// Meta ad sales (main account). A subscription counts as an ad sale when its
// checkout came from an ad-only payment link, or the sales page tagged the
// checkout with an ad (client_reference_id "<ad set>__<ad>", see ads.js).
// Keep in sync with TRIAL_LINK / ADSET_LINKS in ads.js.
const AD_ONLY_LINKS = new Set([
  'plink_1UPnBuBRJTRkwDOL5OuauwiB', // free trial ad link
  'plink_1UVUHVBRJTRkwDOLmofA9UXE', // english.mrvig.com/one-thing
  'plink_1UVXclBRJTRkwDOLzd0VZIie', // english.mrvig.com/one-thing-img
]);
const ADS_SINCE = Math.floor(Date.UTC(2026, 7, 1) / 1000); // ad checkouts are read from Aug 2026 on
const isAdRef = (ref) => { const i = (ref || '').indexOf('__'); return i > 0 && !/^page_/i.test(ref); };

/** Subscription id → { link, ref } for completed checkouts since `since`. */
async function checkoutInfo(key, since) {
  const sessions = await listAll(key, '/checkout/sessions', [['status', 'complete'], ['created[gte]', String(since)]]);
  const out = new Map();
  for (const cs of sessions) {
    const sub = typeof cs.subscription === 'object' && cs.subscription ? cs.subscription.id : cs.subscription;
    if (!sub) continue;
    const link = typeof cs.payment_link === 'object' && cs.payment_link ? cs.payment_link.id : cs.payment_link || '';
    out.set(sub, { link, ref: cs.client_reference_id || '' });
  }
  return out;
}

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
// ThriveCart product "Atomic Homework Daily Email Offer": the checkout link in the daily emails
// (card or PayPal). Sales naming it are Daily emails, whichever account they land in.
const isDailyEmailOffer = (desc) => /daily\s*email\s*offer/i.test(desc || '');
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
      if (account === 'main' && rows.length) {
        try {
          const info = await checkoutInfo(key, Math.max(ADS_SINCE, (sinceTs || 0) - 2 * DAY_S));
          for (const r of rows) {
            const ci = info.get(r.sub_id);
            if (!ci) continue;
            r.checkout_link = ci.link;
            r.checkout_ref = ci.ref;
            r.meta_ad = AD_ONLY_LINKS.has(ci.link) || isAdRef(ci.ref);
          }
        } catch (err) {
          console.error('[members] checkout sessions read failed (STRIPE_KEY needs Checkout Sessions: Read):', err.message);
        }
      }
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

/**
 * One person can show up under different emails (e.g. an old Kartra email and
 * a new Stripe checkout email) but the same Stripe customer ID. Link emails and
 * customer IDs that appear together, so one person counts once.
 * Returns ident(email, customerId) → a stable key for that person.
 */
function linkedIdentity(charges, subscriptions) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let y = x;
    while (parent.has(y) && parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; }
    return r;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra); };
  const link = (email, cid) => {
    email = (email || '').toLowerCase();
    if (email && cid) union('e:' + email, 'c:' + cid);
  };
  for (const c of charges) link(c.customer_email, c.customer_id);
  for (const s of subscriptions) link(s.customer_email, s.customer_id);
  const ident = (email, cid) => {
    email = (email || '').toLowerCase();
    const tok = email ? 'e:' + email : cid ? 'c:' + cid : '';
    if (!tok) return '';
    return parent.has(tok) ? find(tok) : tok;
  };
  // Every email / customer ID → its person key (for callers that look up by raw email or ID).
  ident.aliases = () => [...parent.keys()].map((t) => [t.slice(2), find(t)]);
  return ident;
}

/**
 * Build the member list. Returns [{ date, account, source }] with `date`
 * as unix seconds (join date) — no emails leave the server.
 */
export function buildMembers() {
  const { buyers, identOf, ...out } = analyse();
  return out;
}

/**
 * Dictionary buyers who started Atomic Homework after their first dictionary
 * purchase: Map(ident → { bought, joined, source, paid, cents }).
 * paid: true = paying member (`joined` = sign-up); false = started a
 * subscription (free trial) but has not paid yet, or cancelled before paying
 * (`joined` = subscription start). `cents` = everything paid for Atomic
 * Homework so far (net of refunds). Server-side only (keys are emails).
 */
export function dictionaryBuyerSales() {
  // Keyed by raw email or customer ID (any of the person's emails / IDs).
  const { buyers, identOf } = analyse();
  const out = new Map();
  for (const [k, v] of buyers) out.set(k.slice(2), v);
  for (const [raw, key] of identOf.aliases()) if (buyers.has(key)) out.set(raw, buyers.get(key));
  return out;
}

function analyse() {
  const members = [];
  const identOf = linkedIdentity(getCachedCharges(), subs);
  // Members are counted on their first paid Atomic Homework payment, so free
  // trials that are cancelled before paying are not counted.
  const tcJoin = new Map();     // ThriveCart: ident → first paid charge
  const join = new Map();       // main: ident → first paid charge (unix s)
  const joinVia = new Map();    // ident → 'paypal' | 'stripe' (how that first payment was made)
  const joinAmount = new Map(); // ident → amount of that first payment
  const joinDaily = new Set();  // idents whose first payment was the Daily Email Offer
  const joinAwd = new Set();    // idents whose first payment was the €39 "AWD Upsell"
  const mainSubs = new Map();   // ident → [subs]
  const dictBuys = new Map();   // ident → [dictionary purchase times]
  const ahCents = new Map();    // ident → Atomic Homework paid so far (cents, net of refunds)
  const addCents = (id, net) => ahCents.set(id, (ahCents.get(id) || 0) + Math.round(net * 100));
  for (const c of getCachedCharges()) {
    if (c.status !== 'Paid' && c.status !== 'Refunded') continue;
    const ts = parseInt(c.created, 10);
    if (!ts) continue;
    const id = identOf(c.customer_email, c.customer_id);
    if (!id) continue;
    if (isDictionary(c.description)) {
      if (!dictBuys.has(id)) dictBuys.set(id, []);
      dictBuys.get(id).push(ts);
    }
    const net = (parseFloat(c.amount) || 0) - (parseFloat(c.amount_refunded) || 0);
    if (c.status !== 'Paid' || net <= 0) continue;
    if (c.channel === 'thrivecart' && !isDailyEmailOffer(c.description)) {
      // Every other ThriveCart sale is the Atomic Homework upsell.
      if (!isDictionary(c.description) && (!tcJoin.has(id) || ts < tcJoin.get(id))) tcJoin.set(id, ts);
      if (!isDictionary(c.description) && !isDictAmount(parseFloat(c.amount))) addCents(id, net);
      continue;
    }
    const awd = isAwdUpsell(c.description, parseFloat(c.amount) || 0);
    const daily = isDailyEmailOffer(c.description);
    if (!(awd || daily || isAtomicHomework(c.description))) continue;
    addCents(id, net);
    if (!join.has(id) || ts < join.get(id)) {
      join.set(id, ts);
      joinVia.set(id, c.channel === 'paypal' ? 'paypal' : 'stripe');
      joinAmount.set(id, parseFloat(c.amount) || 0);
      if (awd) joinAwd.add(id); else joinAwd.delete(id);
      if (daily) joinDaily.add(id); else joinDaily.delete(id);
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
  const allSubs = new Map();    // ident → [subs], both accounts
  for (const s of subs) {
    const id = identOf(s.customer_email, s.customer_id);
    if (!id) continue;
    if (!allSubs.has(id)) allSubs.set(id, []);
    allSubs.get(id).push(s);
    if (s.account !== 'main') continue;
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
    if (joinDaily.has(id)) source = 'daily_email';
    else if (firstDict <= signedUp + 300) {
      if (awd || signedUp - firstDict <= UPSELL_PAGE_WINDOW) source = 'dictionary_ad_upsell';
      else if (signedUp - firstDict <= UPSELL_SEQ_WINDOW) source = 'upsell_email';
      else source = 'daily_email';
    }
    else if (signup && TAGGABLE.has(signup.source_tag)) { source = signup.source_tag; tagged++; }
    else if (signup?.meta_ad) source = 'meta_ads';
    else if (awd) source = 'dictionary_ad_upsell';
    else if (priceIs(amount, STORE_PRICE)) source = 'store';
    else if (priceIs(amount, LAUNCH_PROMO_PRICE)) source = 'launch_promo';
    else if (priceIs(amount, APP_ANNUAL_PRICE)) source = 'app_annual';
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
      buyers.set(id, { bought, joined: j.date, source: j.source, paid: true, cents: ahCents.get(id) || 0 });
    }
    else dictionary.push({ bought, already: true });
    if (j) continue;
    // Not a paying member: their first Atomic Homework subscription (free trial) after the dictionary, if any.
    const sub = (allSubs.get(id) || []).filter((s) => s.start >= bought - 300).sort((a, b) => a.start - b.start)[0];
    if (!sub) continue;
    let source;
    if (isDailyEmailOffer(sub.product_name)) source = 'daily_email';
    else if (sub.account === 'thrivecart' || sub.awd_upsell || sub.start - bought <= UPSELL_PAGE_WINDOW) source = 'dictionary_ad_upsell';
    else if (sub.start - bought <= UPSELL_SEQ_WINDOW) source = 'upsell_email';
    else source = 'daily_email';
    buyers.set(id, { bought, joined: sub.start, source, paid: false, cents: 0 });
  }
  dictionary.sort((a, b) => a.bought - b.bought);
  return {
    buyers,
    identOf,
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
