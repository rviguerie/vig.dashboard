/**
 * Ad results (/ads) — Meta ad sets in one campaign vs. Stripe sales.
 *
 * Meta (META_ACCESS_TOKEN, read-only): spend and Meta's own purchase count
 * per ad set in CAMPAIGN for the chosen dates. Meta's purchases are shown in
 * their own column only and never counted as sales.
 *
 * Stripe (STRIPE_KEY, the "Mr. Vig - Kartra" account), read live for the same
 * dates and split by card country into regions:
 *   ee      BG CZ HR HU LT LV PL RO SK UA   → the Eastern Europe A/B test ad sets
 *   w_eu    DE AT CH NL BE FR LU            → the W_EUROPE ad set
 *   s_eu    ES PT IT GR CY                  → the S_EUROPE ad set
 *   other   every other country
 *
 *   €39 sales     paid €39 EUR charges in the range that are the customer's
 *                 first €39 payment (renewals excluded) and are not the first
 *                 payment after a free trial (those are counted as paid trials)
 *   Trials        subscriptions at €39 whose free trial started in the range
 *                 (one per customer)
 *   Paid trials   trials whose first €39 invoice was paid (whenever that was)
 *   Cost per paying customer = spend ÷ (€39 sales + paid trials)
 *
 * Dates are read in the ad account's time zone so Meta and Stripe line up.
 */

import { getCachedCharges } from './cache.js';

const CAMPAIGN = 'Atomic Homework September 2026';
const AD_ACCOUNT = 'act_796462494198580';
const META_BASE = 'https://graph.facebook.com';
const STRIPE_BASE = 'https://api.stripe.com/v1';
// Pinned so invoice.charge / charge.invoice exist whatever the account default is.
const STRIPE_VERSION = '2024-06-20';
const PRICE_CENTS = 3900;
const MAX_PAGES = 200;
const CACHE_MS = 10 * 60 * 1000;
const DAY = 86400;

export const REGIONS = {
  ee: { label: 'Eastern Europe (A/B test)', countries: ['BG', 'CZ', 'HR', 'HU', 'LT', 'LV', 'PL', 'RO', 'SK', 'UA'] },
  w_eu: { label: 'Western Europe (W_EUROPE)', countries: ['DE', 'AT', 'CH', 'NL', 'BE', 'FR', 'LU'] },
  s_eu: { label: 'Southern Europe (S_EUROPE)', countries: ['ES', 'PT', 'IT', 'GR', 'CY'] },
  other: { label: 'Other countries (no ad set)', countries: [] },
};
const regionOf = (country) => {
  const c = (country || '').toUpperCase();
  for (const [k, r] of Object.entries(REGIONS)) if (r.countries.includes(c)) return k;
  return 'other';
};
// Ad sets are matched to a region by name; anything else in the campaign is the A/B test.
const adsetRegion = (name) => {
  if (/w[_\s-]?europe/i.test(name || '')) return 'w_eu';
  if (/s[_\s-]?europe/i.test(name || '')) return 's_eu';
  return 'ee';
};

const cache = new Map(); // "since|until" → { at, data }

// ─── Time zone helpers ───────────────────────────────────────────────

/** Unix seconds for 00:00 on `ymd` in time zone `tz`. */
function zonedMidnight(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.floor((guess - (asLocal - guess)) / 1000);
}

// ─── API helpers ─────────────────────────────────────────────────────

async function metaGet(path, params) {
  const token = process.env.META_ACCESS_TOKEN;
  const version = process.env.META_API_VERSION || 'v23.0';
  const q = new URLSearchParams(params);
  q.set('access_token', token);
  const res = await fetch(`${META_BASE}/${version}/${path}?${q.toString()}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Meta ${res.status}: ${body.error?.message || 'request failed'}`);
  return body;
}

async function stripeGet(pathAndQuery) {
  const key = process.env.STRIPE_KEY;
  if (!key) throw new Error('STRIPE_KEY env var is not set.');
  const res = await fetch(`${STRIPE_BASE}${pathAndQuery}`, {
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': STRIPE_VERSION },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${res.status} on ${pathAndQuery.split('?')[0]}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function stripeList(path, params) {
  const out = [];
  let startingAfter = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const q = new URLSearchParams(params);
    q.set('limit', '100');
    if (startingAfter) q.set('starting_after', startingAfter);
    const data = await stripeGet(`${path}?${q.toString()}`);
    const page = data?.data || [];
    out.push(...page);
    if (!data.has_more || !page.length) break;
    startingAfter = page[page.length - 1].id;
  }
  return out;
}

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const cardCountry = (pm) => (pm && typeof pm === 'object' ? pm.card?.country : '') || '';

// ─── Meta ────────────────────────────────────────────────────────────

async function metaAccount() {
  return metaGet(AD_ACCOUNT, { fields: 'name,currency,timezone_name' });
}

// Meta reports a purchase under several action types; take the first that's present.
const PURCHASE_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
function purchases(actions) {
  for (const t of PURCHASE_TYPES) {
    const a = (actions || []).find((x) => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

async function metaAdsets(since, until) {
  const params = {
    level: 'adset',
    fields: 'campaign_name,adset_id,adset_name,spend,actions',
    time_range: JSON.stringify({ since, until }),
    filtering: JSON.stringify([{ field: 'campaign.name', operator: 'EQUAL', value: CAMPAIGN }]),
    limit: '500',
  };
  const rows = [];
  let body = await metaGet(`${AD_ACCOUNT}/insights`, params);
  for (let pages = 0; pages < 20; pages++) {
    rows.push(...(body.data || []));
    const next = body.paging?.next;
    if (!next) break;
    const res = await fetch(next);
    body = await res.json();
    if (body.error) throw new Error(`Meta: ${body.error.message}`);
  }
  return rows
    .filter((r) => r.campaign_name === CAMPAIGN)
    .map((r) => ({
      id: r.adset_id,
      name: r.adset_name,
      region: adsetRegion(r.adset_name),
      spend: Number(r.spend) || 0,
      metaPurchases: purchases(r.actions),
    }));
}

// ─── Stripe ──────────────────────────────────────────────────────────

const identOf = (email, customerId) => (email || '').toLowerCase() || customerId || '';

/** ident → sorted unix times of every paid €39 charge in the ledger. */
function ledger39() {
  const m = new Map();
  for (const c of getCachedCharges()) {
    if (c.status !== 'Paid' && c.status !== 'Refunded') continue;
    if (c.channel === 'thrivecart' || c.channel === 'paypal') continue;
    if (Math.abs((parseFloat(c.amount) || 0) - PRICE_CENTS / 100) > 0.005) continue;
    const id = identOf(c.customer_email, c.customer_id);
    if (!id) continue;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(parseInt(c.created, 10));
  }
  return m;
}

/** First-time €39 sales in [from, to), excluding first payments after a free trial. */
async function stripeSales(from, to) {
  const raw = await stripeList('/charges', [
    ['created[gte]', String(from)], ['created[lt]', String(to)],
    ['expand[]', 'data.customer'], ['expand[]', 'data.invoice'],
  ]);
  const earlier = ledger39();
  const seen = new Set();
  const sales = [];
  let renewals = 0;
  let trialFirstPayments = 0;
  for (const c of raw.sort((a, b) => a.created - b.created)) {
    if (c.status !== 'succeeded' || !c.paid || c.refunded) continue;
    if (c.amount !== PRICE_CENTS || (c.currency || '').toLowerCase() !== 'eur') continue;
    const cust = typeof c.customer === 'object' && c.customer ? c.customer : null;
    const email = cust?.email || c.billing_details?.email || c.receipt_email || '';
    const id = identOf(email, cust?.id || c.customer || '');
    if (id && ((earlier.get(id) || []).some((t) => t < c.created) || seen.has(id))) { renewals++; continue; }
    if (id) seen.add(id);
    // A customer's first €39 payment on a regular billing cycle invoice comes right after a free trial.
    const inv = typeof c.invoice === 'object' && c.invoice ? c.invoice : null;
    if (inv && inv.billing_reason === 'subscription_cycle') { trialFirstPayments++; continue; }
    const country = c.payment_method_details?.card?.country || c.billing_details?.address?.country || '';
    sales.push({ region: regionOf(country), country });
  }
  return { sales, renewals, trialFirstPayments };
}

const subPriceCents = (s) => {
  const it = s.items?.data?.[0];
  return it?.price?.unit_amount ?? it?.plan?.amount ?? null;
};

/** €39 subscriptions whose free trial started in [from, to), with whether the first €39 invoice was paid. */
async function stripeTrials(from, to) {
  // A trial starts when the subscription is created, so this window holds every trial that started in range.
  const raw = await stripeList('/subscriptions', [
    ['status', 'all'], ['created[gte]', String(from)], ['created[lt]', String(to)],
    ['expand[]', 'data.default_payment_method'],
    ['expand[]', 'data.customer.invoice_settings.default_payment_method'],
  ]);
  const seen = new Set();
  const subs = [];
  for (const s of raw.sort((a, b) => a.created - b.created)) {
    if (!s.trial_start || s.trial_start < from || s.trial_start >= to) continue;
    if (subPriceCents(s) !== PRICE_CENTS) continue;
    const cust = typeof s.customer === 'object' && s.customer ? s.customer : null;
    const id = identOf(cust?.email, cust?.id || s.customer);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    subs.push(s);
  }
  const now = Date.now() / 1000;
  return pool(subs, 5, async (s) => {
    const cust = typeof s.customer === 'object' && s.customer ? s.customer : null;
    let country = cardCountry(s.default_payment_method) || cardCountry(cust?.invoice_settings?.default_payment_method);
    let state = 'unpaid';
    if (s.trial_end && s.trial_end > now && s.status === 'trialing') state = 'in_trial';
    else {
      const invoices = await stripeList('/invoices', [['subscription', s.id], ['expand[]', 'data.charge']]);
      const first = invoices.filter((i) => (i.total || 0) >= PRICE_CENTS).sort((a, b) => a.created - b.created)[0];
      if (!first) state = s.status === 'trialing' ? 'in_trial' : 'unpaid';
      else if (first.status === 'paid' && (first.amount_paid || 0) >= PRICE_CENTS) state = 'paid';
      else if (first.status === 'open' || first.status === 'draft') state = 'pending';
      if (!country && first?.charge && typeof first.charge === 'object') {
        country = first.charge.payment_method_details?.card?.country || '';
      }
    }
    return { region: regionOf(country), country, state };
  });
}

// ─── Report ──────────────────────────────────────────────────────────

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export async function buildAdsReport(since, until) {
  if (!isYmd(since) || !isYmd(until) || since > until) throw new Error('Pick a valid date range.');
  const cacheKey = `${since}|${until}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const warnings = [];
  const hasMeta = !!process.env.META_ACCESS_TOKEN;
  let account = null;
  let adsets = [];
  if (!hasMeta) warnings.push('META_ACCESS_TOKEN is not set in Railway, so spend and Meta purchases are missing.');
  else {
    try {
      account = await metaAccount();
      adsets = await metaAdsets(since, until);
    } catch (err) {
      console.error('[ads] Meta failed:', err.message);
      warnings.push('Could not read Meta: ' + err.message);
    }
  }
  const tz = account?.timezone_name || 'Europe/Berlin';
  const from = zonedMidnight(since, tz);
  const [y, m, d] = until.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const to = zonedMidnight(nextDay, tz);

  const [salesRes, trials] = await Promise.all([stripeSales(from, to), stripeTrials(from, to)]);

  const regions = {};
  for (const k of Object.keys(REGIONS)) {
    regions[k] = { label: REGIONS[k].label, spend: 0, metaPurchases: 0, sales: 0, trials: 0, paidTrials: 0, inTrial: 0, pendingTrials: 0, countries: {} };
  }
  for (const a of adsets) { regions[a.region].spend += a.spend; regions[a.region].metaPurchases += a.metaPurchases; }
  const bump = (r, c) => { if (c) r.countries[c] = (r.countries[c] || 0) + 1; };
  for (const s of salesRes.sales) { regions[s.region].sales++; bump(regions[s.region], s.country); }
  for (const t of trials) {
    const r = regions[t.region];
    r.trials++;
    if (t.state === 'paid') { r.paidTrials++; bump(r, t.country); }
    else if (t.state === 'in_trial') r.inTrial++;
    else if (t.state === 'pending') r.pendingTrials++;
  }
  for (const r of Object.values(regions)) {
    r.paying = r.sales + r.paidTrials;
    r.costPerPaying = r.paying && r.spend ? r.spend / r.paying : null;
  }

  const data = {
    campaign: CAMPAIGN,
    adAccount: AD_ACCOUNT.replace('act_', ''),
    since, until,
    timezone: tz,
    currency: account?.currency || 'EUR',
    metaConfigured: hasMeta,
    adsets: adsets.sort((a, b) => a.region.localeCompare(b.region) || b.spend - a.spend),
    regions,
    regionOrder: Object.keys(REGIONS),
    excluded: { renewals: salesRes.renewals, trialFirstPayments: salesRes.trialFirstPayments },
    warnings,
    builtAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

export function clearAdsCache() { cache.clear(); }
