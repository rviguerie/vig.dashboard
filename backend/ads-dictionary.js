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
 *   Upsell trials     completed checkouts of UPSELL_LINK (one per customer);
 *                     "paid" = its first non-zero invoice was paid
 *   Upsell revenue    everything paid so far on those subscriptions
 *   ThriveCart upsell Atomic Homework sold through ThriveCart to a dictionary
 *                     buyer (same email): a ThriveCart subscription started
 *                     within 2 hours of the order, or any non-dictionary
 *                     ThriveCart charge since the order. Counted as an upsell
 *                     of that buyer, with everything paid so far as revenue.
 * All Stripe amounts are in euros.
 * Charges whose description names another product are ignored.
 *
 * Sales go to an ad set by card country. Only ad sets with spend in the chosen
 * dates are used; ad sets with no spend are left out. Ad sets targeting exactly the same
 * countries form one group (Stripe can't tell them apart). A country targeted
 * by more than one group, or by none, gets its own row.
 */

import {
  AD_ACCOUNT, metaAll, metaInsights, stripeList, linkCheckouts, sessionIdent, identOf, trialOutcome, pool,
} from './ads.js';

export const DICT_CAMPAIGN = 'Atomic Dictionary - Cold - Ad Tests';
const UPSELL_LINK = 'plink_1U9NdTBRJTRkwDOL24SVW02T';
const DICT_CENTS = 700;
const BUMP_CENTS = 900;
const BOTH_CENTS = DICT_CENTS + BUMP_CENTS;
const BUMP_WINDOW = 2 * 3600;
const OTHER_PRODUCT = /atomic homework|awd upsell|vig village|vitamin v|speaking school/i;
const NOT_UPSELL = /dictionary|vig village|vitamin v|speaking school/i; // ThriveCart sales that aren't the Atomic Homework upsell
const UPSELL_WINDOW = 2 * 3600; // ThriveCart upsell subscription starts within 2 hours of the dictionary order

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
    ['created[gte]', String(from)], ['created[lt]', String(until)], ['expand[]', 'data.customer'],
  ], key);
}

/**
 * Atomic Homework upsells sold through ThriveCart, matched to dictionary
 * buyers by email. Every ThriveCart sale that isn't the dictionary or the bump
 * is the Atomic Homework upsell. For each order: a ThriveCart subscription
 * started within UPSELL_WINDOW of the order, or any upsell charge since the
 * order. Revenue = everything the buyer has paid for it so far.
 * Returns Map(order → { paid, inTrial, cents }).
 */
async function thrivecartUpsells(key, charges, orders, from, to) {
  const subs = await stripeList('/subscriptions', [
    ['status', 'all'], ['created[gte]', String(from)], ['created[lt]', String(to + UPSELL_WINDOW)], ['expand[]', 'data.customer'],
  ], key);
  const upsellCharges = charges.filter((c) => c.status === 'succeeded' && c.paid &&
    (c.amount || 0) > (c.amount_refunded || 0) && (c.currency || '').toLowerCase() === 'eur' &&
    ![DICT_CENTS, BUMP_CENTS, BOTH_CENTS].includes(c.amount) && !NOT_UPSELL.test(c.description || ''));
  const out = new Map();
  const usedCharges = new Set();
  const usedSubs = new Set();
  const now = Date.now() / 1000;
  for (const o of [...orders].sort((a, b) => a.created - b.created)) {
    if (!o.ident) continue;
    const mine = upsellCharges.filter((c) => !usedCharges.has(c.id) && custIdent(c) === o.ident && c.created >= o.created - 300);
    const sub = subs.find((s) => !usedSubs.has(s.id) && custIdent(s) === o.ident &&
      s.created >= o.created - 300 && s.created <= o.created + UPSELL_WINDOW);
    if (!mine.length && !sub) continue;
    mine.forEach((c) => usedCharges.add(c.id));
    if (sub) usedSubs.add(sub.id);
    const cents = mine.reduce((t, c) => t + c.amount - (c.amount_refunded || 0), 0);
    const inTrial = !mine.length && sub.status === 'trialing' && sub.trial_end > now;
    out.set(o, { paid: mine.length > 0, inTrial, cents });
  }
  return out;
}

/** Upsell trials from UPSELL_LINK, one per customer, with outcome and paid amount. */
async function upsellTrials(key, from, to) {
  const raw = await linkCheckouts(UPSELL_LINK, from, to, [
    'data.subscription.default_payment_method',
    'data.customer.invoice_settings.default_payment_method',
  ], key);
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
  return pool(subs, 5, ({ cs, s }) => trialOutcome(cs, s, 1, key));
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
  let tcCharges = null;
  for (const acct of ACCOUNTS) {
    const key = process.env[acct.env];
    const src = { account: acct.id, label: acct.label, configured: !!key, orders: 0, withBump: 0, unmatchedBumps: 0, upsellTrials: 0, thrivecartUpsells: 0 };
    sources.push(src);
    if (!key) continue;
    try {
      // ThriveCart charges are read up to now, so later upsell payments count as revenue.
      const isTc = acct.id === 'thrivecart';
      const raw = await listCharges(key, from, isTc ? Math.ceil(Date.now() / 1000) + 60 : to + BUMP_WINDOW);
      if (isTc) tcCharges = raw;
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
    try {
      const trials = await upsellTrials(key, from, to);
      src.upsellTrials = trials.length;
      for (const t of trials) {
        const st = bucketOf(t.country);
        st.upsellTrials++;
        if (t.state === 'paid') st.upsellPaid++;
        else if (t.state === 'in_trial') st.upsellInTrial++;
        st.upsellCents += t.paidCents;
      }
    } catch (err) {
      // A payment link only exists in one account; the other one answers "no such link".
      if (!/payment_link|No such/i.test(err.message)) {
        src.upsellError = err.message;
        warnings.push(`${acct.label}: could not read upsell checkouts: ${err.message}`);
      }
    }
  }

  // Atomic Homework upsells sold through ThriveCart, credited to the dictionary buyer.
  const tcKey = process.env.STRIPE_THRIVECART_KEY;
  if (tcKey && tcCharges) {
    const src = sources.find((x) => x.account === 'thrivecart');
    try {
      const ups = await thrivecartUpsells(tcKey, tcCharges, allOrders, from, to);
      src.thrivecartUpsells = ups.size;
      for (const [o, u] of ups) {
        const st = bucketOf(o.country);
        st.upsellTrials++;
        if (u.paid) st.upsellPaid++;
        else if (u.inTrial) st.upsellInTrial++;
        st.upsellCents += u.cents;
      }
    } catch (err) {
      warnings.push(`ThriveCart account: could not read upsells: ${err.message}`);
    }
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
    upsellLink: UPSELL_LINK,
    groups: groupList,
    overlap: { ...overlap, stats: finish(overlap.stats, 0) },
    other: { ...other, stats: finish(other.stats, 0) },
    total: { spend, metaPurchases: groupList.reduce((t, g) => t + g.metaPurchases, 0), stats: total },
    sources,
    warnings,
  };
}
