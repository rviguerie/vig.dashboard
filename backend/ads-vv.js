/**
 * /ads section for the campaign "Vig Village Reopen November 2026".
 *
 * Meta: spend and Meta's own purchase count (shown only) per ad set.
 *
 * Sales = new Vig Village buyers in the chosen dates:
 *   Stripe  completed, paid checkouts (main account, STRIPE_KEY) whose line items
 *           name "Vig Village", one per customer.
 *   PayPal  first "Vig Village" PayPal payment of a buyer who had never paid for
 *           Vig Village before (from the payments saved by the hourly refresh).
 *
 * Where a sale came from is read from its tag:
 *   "<ad set id>__<ad id>"  set by the sales page from the ad's utm_term / utm_content
 *                           (Stripe client_reference_id, PayPal custom) → that ad set
 *   "page_<page>"           set by the sales page when the visitor did not come from an
 *                           ad (emails, links) → "Not from ads", split by page
 *   no tag                  → "Not from ads", "no tag"
 * Revenue is the first payment, in euros.
 */

import { metaInsights, stripeList, sessionIdent } from './ads.js';
import { getCachedCharges } from './cache.js';

export const VV_CAMPAIGN = 'Vig Village Reopen November 2026';
const IS_VV = /vig village/i;
const NOT_VV = /golden visa|vocabulary|accelerator/i;

const isVvText = (s) => IS_VV.test(s || '') && !NOT_VV.test(s || '');
const parseRef = (ref) => {
  const r = String(ref || '').trim();
  const i = r.indexOf('__');
  if (i > 0) return { kind: 'ad', adset: r.slice(0, i), ad: r.slice(i + 2) };
  if (/^page_/i.test(r)) return { kind: 'page', page: r.slice(5) };
  return { kind: 'none' };
};

/** New Vig Village buyers through Stripe checkout in [from, to). */
async function stripeVvSales(from, to) {
  const raw = await stripeList('/checkout/sessions', [
    ['status', 'complete'],
    ['created[gte]', String(from)], ['created[lt]', String(to)],
    ['expand[]', 'data.line_items'],
  ]);
  const seen = new Set();
  const out = [];
  for (const cs of raw.sort((a, b) => a.created - b.created)) {
    if (cs.payment_status !== 'paid') continue;
    const items = cs.line_items?.data || [];
    if (!items.some((li) => isVvText(li.description) || isVvText(li.price?.nickname))) continue;
    const id = sessionIdent(cs);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push({
      channel: 'stripe',
      created: cs.created,
      email: (cs.customer_details?.email || '').toLowerCase(),
      country: cs.customer_details?.address?.country || '',
      amount: (cs.amount_total || 0) / 100,
      ref: cs.client_reference_id || '',
    });
  }
  return out;
}

/** First-ever Vig Village PayPal payments in [from, to), from the saved payments. */
function paypalVvSales(from, to) {
  const charges = getCachedCharges() || [];
  const firstVv = new Map(); // email → earliest Vig Village payment (any channel)
  for (const c of charges) {
    if (c.status !== 'Paid' || !(c.amount > 0)) continue;
    if (c.description !== 'Vig Village' && !isVvText(c.raw_description)) continue;
    const email = (c.customer_email || '').toLowerCase();
    if (!email) continue;
    const prev = firstVv.get(email);
    if (!prev || c.created < prev.created) firstVv.set(email, c);
  }
  const out = [];
  for (const [email, c] of firstVv) {
    if (c.channel !== 'paypal' || !(c.created >= from && c.created < to)) continue;
    out.push({
      channel: 'paypal',
      created: c.created,
      email,
      country: '',
      amount: Number(c.amount) || 0,
      ref: c.custom_field || '',
    });
  }
  return out;
}

export async function buildVigVillageSection(since, until, from, to, metaOk) {
  const warnings = [];
  let adsets = [];
  if (metaOk) {
    try {
      adsets = await metaInsights(since, until, VV_CAMPAIGN);
    } catch (err) {
      warnings.push('Could not read Meta for this campaign: ' + err.message);
    }
  }
  let stripe = [];
  try {
    stripe = await stripeVvSales(from, to);
  } catch (err) {
    warnings.push('Could not read Stripe checkouts for Vig Village: ' + err.message);
  }
  const paypal = paypalVvSales(from, to);
  const sales = [...stripe, ...paypal];

  const rows = adsets.map((a) => ({ ...a, stripe: 0, paypal: 0, revenue: 0, countries: {} }));
  const rowOf = (id) => rows.find((r) => String(r.id) === String(id));
  const notFromAds = { pages: {}, noTag: { stripe: 0, paypal: 0, revenue: 0 }, otherAdTag: { stripe: 0, paypal: 0, revenue: 0 } };
  for (const s of sales) {
    const t = parseRef(s.ref);
    if (t.kind === 'ad') {
      const r = rowOf(t.adset);
      if (r) {
        r[s.channel]++;
        r.revenue += s.amount;
        if (s.country) r.countries[s.country] = (r.countries[s.country] || 0) + 1;
        continue;
      }
      // Tagged with an ad set that isn't in this campaign (or Meta not read).
      notFromAds.otherAdTag[s.channel]++;
      notFromAds.otherAdTag.revenue += s.amount;
      continue;
    }
    const bucket = t.kind === 'page'
      ? (notFromAds.pages[t.page] ||= { stripe: 0, paypal: 0, revenue: 0 })
      : notFromAds.noTag;
    bucket[s.channel]++;
    bucket.revenue += s.amount;
  }
  for (const r of rows) {
    r.buyers = r.stripe + r.paypal;
    r.costPerBuyer = r.buyers && r.spend ? r.spend / r.buyers : null;
  }
  const sum = (arr, k) => arr.reduce((t, x) => t + (x[k] || 0), 0);
  const adBuyers = sum(rows, 'buyers');
  const spend = sum(rows, 'spend');
  const nfaList = [...Object.values(notFromAds.pages), notFromAds.noTag, notFromAds.otherAdTag];
  const total = {
    spend,
    metaPurchases: sum(rows, 'metaPurchases'),
    adBuyers,
    adRevenue: sum(rows, 'revenue'),
    costPerBuyer: adBuyers && spend ? spend / adBuyers : null,
    otherBuyers: nfaList.reduce((t, b) => t + b.stripe + b.paypal, 0),
    otherRevenue: nfaList.reduce((t, b) => t + b.revenue, 0),
    stripe: stripe.length,
    paypal: paypal.length,
  };
  if (!metaOk) warnings.push('Meta was not read, so spend is missing and ad-tagged sales show under "Not from these ads".');
  return {
    campaign: VV_CAMPAIGN,
    adsets: rows.sort((a, b) => b.spend - a.spend),
    notFromAds,
    total,
    warnings,
  };
}
