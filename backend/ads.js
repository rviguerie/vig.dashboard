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
 * Only two payment links count; every other €39 payment or trial is ignored:
 *   €39 sales     paid checkouts of DIRECT_LINK in the range (one per customer)
 *   Trials        completed checkouts of TRIAL_LINK in the range (one per customer)
 *   Paid trials   trials whose first €39 invoice was paid (whenever that was)
 *   Cost per paying customer = spend ÷ (€39 sales + paid trials)
 *
 * In the Eastern Europe A/B test the ad sets are not combined: €39 sales go
 * only to EE_DIRECT_ADSET and trials only to EE_TRIAL_ADSET, each with its own
 * cost per paying customer.
 *
 * Dates are read in the ad account's time zone so Meta and Stripe line up.
 */

const CAMPAIGN = 'Atomic Homework September 2026';
const AD_ACCOUNT = 'act_796462494198580';
const META_BASE = 'https://graph.facebook.com';
const STRIPE_BASE = 'https://api.stripe.com/v1';
// Pinned so invoice.charge / charge.invoice exist whatever the account default is.
const STRIPE_VERSION = '2024-06-20';
const PRICE_CENTS = 3900;
// Only sales through these two Stripe payment links count.
const DIRECT_LINK = 'plink_1TAh4gBRJTRkwDOLrKOnTE5R'; // €39, pays straight away
const TRIAL_LINK = 'plink_1UPnBuBRJTRkwDOL5OuauwiB';  // free trial, then €39
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

// In the Eastern Europe A/B test, €39 sales belong to the full-price ad set and
// trials to the free-trial ad set; each gets its own cost per paying customer.
const EE_DIRECT_ADSET = 'E_EUROPE_COLD_AMAZING_Full-Price';
const EE_TRIAL_ADSET = 'Test B - E_EUROPE_COLD_AMAZING - Free Trial';
const sameName = (a, b) => (a || '').trim().toLowerCase() === b.toLowerCase();

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

/** Completed checkouts of one payment link started in [from, to). */
async function linkCheckouts(link, from, to, expand) {
  const raw = await stripeList('/checkout/sessions', [
    ['payment_link', link], ['status', 'complete'],
    ['created[gte]', String(from)], ['created[lt]', String(to)],
    ...expand.map((e) => ['expand[]', e]),
  ]);
  return raw.sort((a, b) => a.created - b.created);
}

const sessionIdent = (cs) => {
  const cust = typeof cs.customer === 'object' && cs.customer ? cs.customer : null;
  return identOf(cs.customer_details?.email || cust?.email, cust?.id || cs.customer || '');
};

/** Paid checkouts of the €39 direct link, one per customer. */
async function stripeSales(from, to) {
  const raw = await linkCheckouts(DIRECT_LINK, from, to, [
    'data.payment_intent.latest_charge', 'data.subscription.latest_invoice.charge',
  ]);
  const seen = new Set();
  const sales = [];
  for (const cs of raw) {
    if (cs.payment_status !== 'paid') continue;
    const id = sessionIdent(cs);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const charge = cs.payment_intent?.latest_charge || cs.subscription?.latest_invoice?.charge;
    const country = (typeof charge === 'object' && charge?.payment_method_details?.card?.country) ||
      cs.customer_details?.address?.country || '';
    sales.push({ region: regionOf(country), country });
  }
  return sales;
}

/** Checkouts of the free-trial link, one per customer, with whether the first €39 invoice was paid. */
async function stripeTrials(from, to) {
  const raw = await linkCheckouts(TRIAL_LINK, from, to, [
    'data.subscription.default_payment_method',
    'data.customer.invoice_settings.default_payment_method',
  ]);
  const seen = new Set();
  const subs = [];
  for (const cs of raw) {
    const s = typeof cs.subscription === 'object' && cs.subscription ? cs.subscription : null;
    if (!s) continue;
    const id = sessionIdent(cs);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    subs.push({ cs, s });
  }
  const now = Date.now() / 1000;
  return pool(subs, 5, async ({ cs, s }) => {
    const cust = typeof cs.customer === 'object' && cs.customer ? cs.customer : null;
    let country = cardCountry(s.default_payment_method) || cardCountry(cust?.invoice_settings?.default_payment_method);
    let state = 'unpaid';
    if (s.status === 'trialing' && s.trial_end && s.trial_end > now) state = 'in_trial';
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
    if (!country) country = cs.customer_details?.address?.country || '';
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

  let sales = [];
  let trials = [];
  try {
    [sales, trials] = await Promise.all([stripeSales(from, to), stripeTrials(from, to)]);
  } catch (err) {
    if (/Stripe 403/.test(err.message)) throw new Error('The Stripe key cannot read checkouts. Add "Checkout Sessions: Read" to the restricted key (STRIPE_KEY). ' + err.message);
    throw err;
  }

  const regions = {};
  for (const k of Object.keys(REGIONS)) {
    regions[k] = { label: REGIONS[k].label, spend: 0, metaPurchases: 0, sales: 0, trials: 0, paidTrials: 0, inTrial: 0, pendingTrials: 0, countries: {}, salesCountries: {}, trialCountries: {} };
  }
  for (const a of adsets) { regions[a.region].spend += a.spend; regions[a.region].metaPurchases += a.metaPurchases; }
  const bump = (m, c) => { if (c) m[c] = (m[c] || 0) + 1; };
  for (const s of sales) {
    const r = regions[s.region];
    r.sales++;
    bump(r.countries, s.country);
    bump(r.salesCountries, s.country);
  }
  for (const t of trials) {
    const r = regions[t.region];
    r.trials++;
    if (t.state === 'paid') { r.paidTrials++; bump(r.countries, t.country); bump(r.trialCountries, t.country); }
    else if (t.state === 'in_trial') r.inTrial++;
    else if (t.state === 'pending') r.pendingTrials++;
  }
  for (const r of Object.values(regions)) {
    r.paying = r.sales + r.paidTrials;
    r.costPerPaying = r.paying && r.spend ? r.spend / r.paying : null;
  }

  // Eastern Europe: give each A/B ad set only its own Stripe numbers. Both rows
  // are shown even when Meta reports no spend for one of them in the range.
  const ee = regions.ee;
  for (const name of [EE_DIRECT_ADSET, EE_TRIAL_ADSET]) {
    if (!adsets.some((a) => sameName(a.name, name))) adsets.push({ id: '', name, region: 'ee', spend: 0, metaPurchases: 0 });
  }
  for (const a of adsets) {
    if (a.region !== 'ee') continue;
    const direct = sameName(a.name, EE_DIRECT_ADSET);
    const trial = sameName(a.name, EE_TRIAL_ADSET);
    if (!direct && !trial) { a.stripe = null; continue; }
    const st = direct
      ? { sales: ee.sales, trials: 0, paidTrials: 0, inTrial: 0, pendingTrials: 0, countries: ee.salesCountries }
      : { sales: 0, trials: ee.trials, paidTrials: ee.paidTrials, inTrial: ee.inTrial, pendingTrials: ee.pendingTrials, countries: ee.trialCountries };
    st.paying = st.sales + st.paidTrials;
    st.costPerPaying = st.paying && a.spend ? a.spend / st.paying : null;
    a.stripe = st;
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
    links: { direct: DIRECT_LINK, trial: TRIAL_LINK },
    warnings,
    builtAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

export function clearAdsCache() { cache.clear(); }
