/**
 * /ads section for the campaign "Atomic Dictionary - Cold - Ad Tests".
 *
 * Meta: spend, Meta's purchase count (shown only, never used) and each ad
 * set's country targeting (targeting.geo_locations.countries).
 *
 * Stripe: both accounts are read (STRIPE_KEY and STRIPE_THRIVECART_KEY), since
 * the dictionary may be sold in either; the report says which one had sales.
 *   Dictionary order  a paid €7 charge, or €16 (dictionary + order bump in one charge)
 *   Order bump        €16 charge, or a separate €9 charge by the same customer
 *                     within 2 hours of a €7 dictionary charge
 *   Upsell            the dictionary buyer started Atomic Homework after their
 *                     first dictionary purchase, as the members page sees it
 *                     (members.js dictionaryBuyerSales: charges ledger + saved
 *                     subscriptions). "paid" = paid at least once; otherwise a
 *                     trial that hasn't paid (yet). Revenue = everything paid
 *                     for Atomic Homework so far. One upsell per buyer (email).
 *                     The same data feeds the totals, the ad set rows, the A/B
 *                     test and "Sales by source", so they always agree.
 * Sales by source:  those upsells split as the members page sorts them (timed
 *                   from the first dictionary purchase): upsell page
 *                   (ThriveCart, "AWD Upsell" or ≤1 hour), upsell sequence
 *                   (1 hour – 6 days), daily emails (> 6 days).
 * All Stripe amounts are in euros.
 * Charges whose description names another product are ignored.
 *
 * Upsell A/B test: ThriveCart puts the product number on each payment
 * (payment_intent.metadata.thrivecart_product_id). Orders from product #15
 * belong to test version A (free trial, long video), #14 to version B (€39,
 * short video). Ad sets named "Test A …" / "Test B …" supply the spend; within
 * a version, orders go to an ad set by card country.
 *
 * Sales go to an ad set by card country. Only ad sets with spend in the chosen
 * dates are used; ad sets with no spend are left out. Ad sets targeting exactly the same
 * countries form one group (Stripe can't tell them apart). A country targeted
 * by more than one group, or by none, gets its own row.
 */

import {
  AD_ACCOUNT, metaAll, metaInsights, stripeList, identOf,
} from './ads.js';
import { dictionaryBuyerSales } from './members.js';

export const DICT_CAMPAIGN = 'Atomic Dictionary - Cold - Ad Tests';
const DICT_CENTS = 700;
const BUMP_CENTS = 900;
const BOTH_CENTS = DICT_CENTS + BUMP_CENTS;
const BUMP_WINDOW = 2 * 3600;
const OTHER_PRODUCT = /atomic homework|awd upsell|vig village|vitamin v|speaking school/i;

// Upsell A/B test: ThriveCart product number → test version.
const AB_VERSIONS = [
  { version: 'A', product: '15', label: 'A · free trial, long video (ThriveCart #15)' },
  { version: 'B', product: '14', label: 'B · €39, short video (ThriveCart #14)' },
];
const AB_ADSET = /^\s*test\s+([ab])\b/i;

// Atomic Homework sources for dictionary buyers (same keys as the members page).
const HOMEWORK_SOURCES = [
  { key: 'dictionary_ad_upsell', label: 'Upsell page' },
  { key: 'upsell_email', label: 'Upsell sequence' },
  { key: 'daily_email', label: 'Daily emails' },
];

const productOf = (c) => {
  const pi = typeof c.payment_intent === 'object' && c.payment_intent ? c.payment_intent : null;
  return String(pi?.metadata?.thrivecart_product_id || c.metadata?.thrivecart_product_id || '');
};

const ACCOUNTS = [
  { id: 'main', env: 'STRIPE_KEY', label: 'Main account (STRIPE_KEY)' },
  { id: 'thrivecart', env: 'STRIPE_THRIVECART_KEY', label: 'ThriveCart account (STRIPE_THRIVECART_KEY)' },
];

// ─── Meta ────────────────────────────────────────────────────────────

async function metaTargeting() {
  const rows = await metaAll(`${AD_ACCOUNT}/adsets`, {
    fields: 'id,name,targeting,campaign{name}',
    filtering: JSON.stringify([{ field: 'campaign.name', operator: 'EQUAL', value: DICT_CAMPAIGN }]),
    limit: '500',
  });
  return rows
    .filter((r) => r.campaign?.name === DICT_CAMPAIGN)
    .map((r) => ({
      id: r.id,
      name: r.name,
      countries: [...new Set((r.targeting?.geo_locations?.countries || []).map((c) => c.toUpperCase()))].sort(),
    }));
}

// ─── Stripe ──────────────────────────────────────────────────────────

const custIdent = (c) => {
  const cust = typeof c.customer === 'object' && c.customer ? c.customer : null;
  return identOf(cust?.email || c.billing_details?.email || c.receipt_email, cust?.id || c.customer || '');
};

/** Dictionary orders (with bump flag) and the number of €9 bumps that matched no order. */
async function dictionaryOrders(account, key, from, to, raw) {
  const orders = [];
  const bumps = [];
  for (const c of raw.sort((a, b) => a.created - b.created)) {
    if (c.status !== 'succeeded' || !c.paid || c.refunded) continue;
    if ((c.currency || '').toLowerCase() !== 'eur' || OTHER_PRODUCT.test(c.description || '')) continue;
    const row = {
      account,
      created: c.created,
      ident: custIdent(c),
      country: c.payment_method_details?.card?.country || c.billing_details?.address?.country || '',
      product: productOf(c),
    };
    if (c.amount === DICT_CENTS || c.amount === BOTH_CENTS) {
      if (c.created < to) orders.push({ ...row, bump: c.amount === BOTH_CENTS });
    } else if (c.amount === BUMP_CENTS) bumps.push(row);
  }
  let unmatchedBumps = 0;
  for (const b of bumps) {
    const o = b.ident && orders.find((x) => !x.bump && x.ident === b.ident && Math.abs(x.created - b.created) <= BUMP_WINDOW);
    if (o) o.bump = true;
    else if (b.created < to) unmatchedBumps++;
  }
  return { orders, unmatchedBumps };
}

async function listCharges(key, from, until) {
  return stripeList('/charges', [
    ['created[gte]', String(from)], ['created[lt]', String(until)], ['expand[]', 'data.customer'], ['expand[]', 'data.payment_intent'],
  ], key);
}

/**
 * Sets o.upsell = { paid, inTrial, cents, source } on each order whose buyer
 * started Atomic Homework after the dictionary (first order per buyer only).
 * Returns the number of distinct buyers.
 */
function attachUpsells(orders) {
  const buyers = dictionaryBuyerSales();
  const seen = new Set();
  for (const o of [...orders].sort((a, b) => a.created - b.created)) {
    if (!o.ident || seen.has(o.ident)) continue;
    seen.add(o.ident);
    const b = buyers.get(o.ident);
    if (b) o.upsell = { paid: b.paid, inTrial: !b.paid, cents: b.cents, source: b.source };
  }
  return seen.size;
}

/** Those upsells split by source. */
function homeworkBySource(orders, buyerCount) {
  const out = Object.fromEntries(HOMEWORK_SOURCES.map((s) => [s.key, { label: s.label, buyers: 0, paid: 0, trials: 0, cents: 0 }]));
  for (const o of orders) {
    const u = o.upsell;
    if (!u || !out[u.source]) continue;
    out[u.source].buyers++;
    if (u.paid) out[u.source].paid++; else out[u.source].trials++;
    out[u.source].cents += u.cents;
  }
  return { buyers: buyerCount, sources: HOMEWORK_SOURCES.map((s) => ({ key: s.key, ...out[s.key] })) };
}

// ─── Report ──────────────────────────────────────────────────────────

const emptyStats = () => ({
  orders: 0, withBump: 0, dictCents: 0, bumpCents: 0,
  upsellTrials: 0, upsellPaid: 0, upsellInTrial: 0, upsellCents: 0, countries: {},
});

function finish(st, spend) {
  st.bumpPct = st.orders ? st.withBump / st.orders : null;
  st.revenueCents = st.dictCents + st.bumpCents + st.upsellCents;
  st.costPerBuyer = st.orders && spend ? spend / st.orders : null;
  st.revenuePerBuyer = st.orders ? st.revenueCents / 100 / st.orders : null;
  return st;
}

/** Adds one order (with its ThriveCart upsell, if any) to a stats object. */
function addOrder(st, o) {
  st.orders++;
  st.dictCents += DICT_CENTS;
  if (o.bump) { st.withBump++; st.bumpCents += BUMP_CENTS; }
  if (o.country) st.countries[o.country] = (st.countries[o.country] || 0) + 1;
  const u = o.upsell;
  if (u) {
    st.upsellTrials++;
    if (u.paid) st.upsellPaid++;
    else if (u.inTrial) st.upsellInTrial++;
    st.upsellCents += u.cents;
  }
}

/**
 * Upsell A/B test: orders split by ThriveCart product (#15 = A, #14 = B).
 * Each version lists its "Test A/B …" ad sets (spend, and orders from their
 * countries) and a version total (all orders of that product, any country).
 */
export function buildAbTest(adsets, orders) {
  const versions = AB_VERSIONS.map((v) => {
    const mine = orders.filter((o) => o.product === v.product);
    const sets = adsets
      .filter((a) => (AB_ADSET.exec(a.name)?.[1] || '').toUpperCase() === v.version)
      .map((a) => {
        const st = emptyStats();
        for (const o of mine) if (a.countries.includes((o.country || '').toUpperCase())) addOrder(st, o);
        return { id: a.id, name: a.name, countries: a.countries, spend: a.spend, metaPurchases: a.metaPurchases, stats: finish(st, a.spend) };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
    const total = emptyStats();
    for (const o of mine) addOrder(total, o);
    const spend = sets.reduce((t, a) => t + a.spend, 0);
    return { ...v, adsets: sets, spend, metaPurchases: sets.reduce((t, a) => t + a.metaPurchases, 0), stats: finish(total, spend) };
  });
  return { versions, active: versions.some((v) => v.adsets.length || v.stats.orders) };
}

/** The dictionary campaign section. `from`/`to` are unix seconds in the ad account's time zone. */
export async function buildDictionarySection(since, until, from, to, hasMeta) {
  const warnings = [];
  let targeting = [];
  let insights = [];
  if (hasMeta) {
    try {
      [targeting, insights] = await Promise.all([metaTargeting(), metaInsights(since, until, DICT_CAMPAIGN)]);
    } catch (err) {
      console.error('[ads] dictionary Meta failed:', err.message);
      warnings.push('Could not read Meta for this campaign: ' + err.message);
    }
  }

  // Ad sets with spend for the dates. Ad sets with no spend are ignored, so
  // their countries don't take sales away from the ones that ran.
  const byId = new Map(targeting.map((t) => [t.id, { ...t, spend: 0, metaPurchases: 0 }]));
  for (const i of insights) {
    const a = byId.get(i.id) || { id: i.id, name: i.name, countries: [] };
    byId.set(i.id, { ...a, spend: i.spend, metaPurchases: i.metaPurchases });
  }
  const adsets = [...byId.values()].filter((a) => a.spend > 0);

  // Groups: ad sets with the same country list.
  const groups = new Map();
  for (const a of adsets) {
    const key = a.countries.join(',') || '(no countries)';
    if (!groups.has(key)) groups.set(key, { key, countries: a.countries, adsets: [], spend: 0, metaPurchases: 0, stats: emptyStats() });
    const g = groups.get(key);
    g.adsets.push({ id: a.id, name: a.name, spend: a.spend, metaPurchases: a.metaPurchases });
    g.spend += a.spend;
    g.metaPurchases += a.metaPurchases;
  }
  const targetedBy = new Map(); // country → [group keys]
  for (const g of groups.values()) for (const c of g.countries) targetedBy.set(c, [...(targetedBy.get(c) || []), g.key]);
  const overlap = { label: 'Countries targeted by more than one group', stats: emptyStats() };
  const other = { label: 'Other countries (not targeted)', stats: emptyStats() };
  const bucketOf = (country) => {
    const keys = targetedBy.get((country || '').toUpperCase()) || [];
    if (keys.length === 1) return groups.get(keys[0]).stats;
    return keys.length > 1 ? overlap.stats : other.stats;
  };
  const bump = (st, c) => { if (c) st.countries[c] = (st.countries[c] || 0) + 1; };

  // Stripe: both accounts.
  const sources = [];
  const allOrders = [];
  for (const acct of ACCOUNTS) {
    const key = process.env[acct.env];
    const src = { account: acct.id, label: acct.label, configured: !!key, orders: 0, withBump: 0, unmatchedBumps: 0 };
    sources.push(src);
    if (!key) continue;
    try {
      const raw = await listCharges(key, from, to + BUMP_WINDOW);
      const { orders, unmatchedBumps } = await dictionaryOrders(acct.id, key, from, to, raw);
      allOrders.push(...orders);
      src.orders = orders.length;
      src.withBump = orders.filter((o) => o.bump).length;
      src.unmatchedBumps = unmatchedBumps;
      for (const o of orders) {
        const st = bucketOf(o.country);
        st.orders++;
        st.dictCents += DICT_CENTS;
        if (o.bump) { st.withBump++; st.bumpCents += BUMP_CENTS; }
        bump(st, o.country);
      }
    } catch (err) {
      src.error = err.message;
      warnings.push(`${acct.label}: could not read charges: ${err.message}`);
    }
  }

  // Upsells: one per buyer, from the same data as "Sales by source".
  const buyerCount = attachUpsells(allOrders);
  for (const o of allOrders) {
    const u = o.upsell;
    if (!u) continue;
    const st = bucketOf(o.country);
    st.upsellTrials++;
    if (u.paid) st.upsellPaid++; else st.upsellInTrial++;
    st.upsellCents += u.cents;
  }

  const groupList = [...groups.values()]
    .map((g) => ({ ...g, stats: finish(g.stats, g.spend) }))
    .sort((a, b) => b.spend - a.spend);
  const total = emptyStats();
  for (const st of [...groupList.map((g) => g.stats), overlap.stats, other.stats]) {
    for (const k of Object.keys(total)) if (k !== 'countries') total[k] += st[k];
  }
  const spend = groupList.reduce((t, g) => t + g.spend, 0);
  finish(total, spend);
  // Buyers in untargeted countries didn't come from these ads, so cost per buyer leaves them out.
  const targetedOrders = total.orders - other.stats.orders;
  total.costPerBuyer = targetedOrders && spend ? spend / targetedOrders : null;
  return {
    campaign: DICT_CAMPAIGN,
    abTest: buildAbTest(adsets, allOrders),
    homework: homeworkBySource(allOrders, buyerCount),
    groups: groupList,
    overlap: { ...overlap, stats: finish(overlap.stats, 0) },
    other: { ...other, stats: finish(other.stats, 0) },
    total: { spend, metaPurchases: groupList.reduce((t, g) => t + g.metaPurchases, 0), stats: total },
    sources,
    warnings,
  };
}
