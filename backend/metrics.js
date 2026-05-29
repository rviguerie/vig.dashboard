/**
 * Server-side metrics — the single source of truth for both the dashboard
 * tiles (via the data the frontend computes) and the chat agent's tools.
 *
 * This is a faithful Node port of the dashboard's compute() logic: same
 * price rules, same Sale/Rebill classification, same active-sub and churn
 * definitions, same channel split. It operates on the in-memory charge
 * cache so the chat tools never re-read Firestore.
 *
 * IMPORTANT: keep PRICE_RULES and the active/churn logic in sync with
 * public/dashboard.html.
 */

import { getCachedCharges } from './cache.js';

const PRICE_RULES = {
  'Mr. Vigs Atomic Homework': [[29, 1], [33.5, 1], [39, 1], [49, 1], [71, 1], [261, 12], [268, 12], [300.5, 12], [351, 12], [441, 12]],
  'Vig Village': [[60, 1], [99, 1], [198, 2], [540, 12]],
  'Vitamin V EXTRA STRENGTH': [[29, 1]],
  'Speaking School': [[29, 1], [87, 3]],
};
const TRACKED = Object.keys(PRICE_RULES);

const DAY = 86400000;

function normalizeProduct(desc) {
  desc = (desc || '').trim();
  if (!desc) return null;
  if (desc.startsWith('Invoice ') || desc === 'Subscription creation' || desc.startsWith('Payment for invoice ')) {
    return '__native_sub_unattributed__';
  }
  return desc;
}

function monthsFor(product, amount) {
  const rules = PRICE_RULES[product];
  if (!rules) return null;
  for (const [amt, months] of rules) if (Math.abs(amt - amount) < 0.01) return months;
  return null;
}

const ymd = (d) => d.toISOString().slice(0, 10);
const ym = (d) => d.toISOString().slice(0, 7);

/** Build the normalized charge list from cache (date objects, net, etc.). */
function loadCharges() {
  const out = [];
  for (const r of getCachedCharges()) {
    const ts = parseInt(r.created, 10);
    if (!ts) continue;
    const date = new Date(ts * 1000);
    if (isNaN(date)) continue;
    const status = r.status || '';
    if (status !== 'Paid' && status !== 'Refunded') continue;
    const amount = parseFloat(r.amount || 0);
    const refunded = parseFloat(r.amount_refunded || 0);
    out.push({
      date,
      amount,
      refunded,
      net: amount - refunded,
      currency: (r.currency || '').toLowerCase(),
      email: (r.customer_email || '').toLowerCase(),
      customerId: r.customer_id || '',
      invoiceId: r.invoice_id || '',
      product: normalizeProduct(r.description),
      channel: r.channel || (r.invoice_id ? 'native_stripe_sub' : 'kartra_orchestrated'),
      status,
    });
  }
  return out;
}

/** Schema for the agent: what products/channels/date range exist. */
export function getSchema() {
  const charges = loadCharges();
  let min = Infinity, max = -Infinity;
  for (const c of charges) {
    const t = c.date.getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return {
    tracked_products: TRACKED,
    channels: ['kartra_orchestrated', 'native_stripe_sub', 'paypal'],
    channel_meaning: {
      kartra_orchestrated: 'Legacy subs where Kartra triggers a Stripe charge',
      native_stripe_sub: 'New direct-link customers paying via native Stripe subscriptions',
      paypal: 'All PayPal payments (mostly Kartra-orchestrated, small direct-button share)',
    },
    primary_currency: 'EUR',
    data_min_date: isFinite(min) ? ymd(new Date(min)) : null,
    data_max_date: isFinite(max) ? ymd(new Date(max)) : null,
    total_charges: charges.length,
    notes: 'Amounts are EUR unless noted. "active" = had a paid charge whose covered period (by price→cadence rule) has not lapsed. Sale = a customer\'s first ever paid charge for a product; Rebill = any subsequent. Churn% = cancelled-in-window / cohort-active-at-window-start.',
  };
}

/**
 * Core metrics for a window + optional product/channel filter.
 * Mirrors the dashboard's compute() exactly.
 */
export function queryMetrics({ start_date, end_date, product, channel } = {}) {
  const all = loadCharges();
  const asOf = end_date ? new Date(end_date + 'T23:59:59Z') : new Date(Math.max(...all.map((c) => c.date.getTime())));
  const cutoff = start_date ? new Date(start_date + 'T00:00:00Z') : new Date(asOf.getTime() - 30 * DAY);

  const charges = all.filter((c) => {
    if (c.date > asOf) return false;
    if (channel && c.channel !== channel) return false;
    if (product) {
      if (product === 'Other') {
        if (!c.product || c.product === '__native_sub_unattributed__' || TRACKED.includes(c.product)) return false;
      } else if (c.product !== product) return false;
    }
    return true;
  });

  // first-charge map for Sale/Rebill
  const firstDate = new Map();
  for (const c of charges) {
    if (c.status !== 'Paid' || c.net <= 0 || !c.product) continue;
    const id = c.email || c.customerId || c.invoiceId;
    if (!id) continue;
    const k = c.product + '||' + id;
    const cur = firstDate.get(k);
    if (!cur || c.date < cur) firstDate.set(k, c.date);
  }

  const totals = { eur: 0, usd: 0 };
  let sales = 0, rebills = 0, salesCount = 0, rebillsCount = 0, refunds = 0;
  const channels = {};
  const perProductRev = {};

  for (const c of charges) {
    const inWin = c.date >= cutoff && c.date <= asOf;
    if (c.net > 0 && inWin) {
      totals[c.currency] = (totals[c.currency] || 0) + c.net;
      channels[c.channel] = (channels[c.channel] || 0) + (c.currency === 'eur' ? c.net : 0);
      if (c.product) perProductRev[c.product] = (perProductRev[c.product] || 0) + (c.currency === 'eur' ? c.net : 0);
      let isSale = false;
      if (c.status === 'Paid' && c.product) {
        const id = c.email || c.customerId || c.invoiceId;
        if (id) {
          const f = firstDate.get(c.product + '||' + id);
          if (f && c.date.getTime() === f.getTime()) isSale = true;
        }
      }
      if (c.currency === 'eur') {
        if (isSale) { sales += c.net; salesCount++; } else { rebills += c.net; rebillsCount++; }
      }
    }
    if (c.refunded > 0 && inWin && c.currency === 'eur') refunds += c.refunded;
  }

  // active subs + churn
  const histories = new Map();
  for (const c of charges) {
    if (c.status !== 'Paid' || c.net <= 0 || !c.product) continue;
    const id = c.email || c.customerId || c.invoiceId;
    if (!id) continue;
    const k = c.product + '||' + id;
    if (!histories.has(k)) histories.set(k, []);
    histories.get(k).push(c);
  }
  let activeCount = 0, mrr = 0, cancelled = 0;
  const cohortStart = new Set();
  const activeIdents = new Set();
  const cancelledIdents = new Set();
  const perProductActive = {};
  for (const [k, hist] of histories) {
    hist.sort((a, b) => a.date - b.date);
    const prod = k.split('||')[0];
    const id = k.split('||')[1];
    let best = null;
    for (const c of hist) {
      const m = monthsFor(prod, c.amount);
      if (m === null) continue;
      if (!best || c.date > best.date) {
        best = { date: c.date, amount: c.amount, months: m, activeUntil: new Date(c.date.getTime() + (m * 30 + 7) * DAY), mrr: c.amount / m };
      }
    }
    if (!best) continue;
    if (best.activeUntil >= cutoff) cohortStart.add(id);
    if (best.activeUntil >= asOf) {
      activeCount++; mrr += best.mrr; activeIdents.add(id);
      perProductActive[prod] = (perProductActive[prod] || 0) + 1;
    } else if (best.activeUntil >= cutoff && best.activeUntil < asOf) {
      cancelled++; cancelledIdents.add(id);
    }
  }
  const churnPct = cohortStart.size > 0 ? (100 * cancelledIdents.size / cohortStart.size) : 0;

  return {
    window: { start: ymd(cutoff), end: ymd(asOf) },
    filter: { product: product || 'all', channel: channel || 'all' },
    revenue_eur: round(totals.eur),
    revenue_usd: round(totals.usd),
    sales_eur: round(sales),
    sales_count: salesCount,
    rebills_eur: round(rebills),
    rebills_count: rebillsCount,
    refunds_eur: round(refunds),
    active_subscribers: activeIdents.size,
    mrr_eur: round(mrr),
    cancelled_in_window: cancelledIdents.size,
    cohort_at_window_start: cohortStart.size,
    churn_pct: Math.round(churnPct * 10) / 10,
    channel_revenue_eur: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, round(v)])),
    per_product: TRACKED.map((p) => ({
      product: p,
      active: perProductActive[p] || 0,
      revenue_eur: round(perProductRev[p] || 0),
    })),
  };
}

/** Monthly series of one metric across a window. For charts/trends. */
export function monthlySeries({ metric = 'revenue', start_date, end_date, product, channel } = {}) {
  const all = loadCharges();
  const asOf = end_date ? new Date(end_date + 'T23:59:59Z') : new Date(Math.max(...all.map((c) => c.date.getTime())));
  const cutoff = start_date ? new Date(start_date + 'T00:00:00Z') : new Date(asOf.getTime() - 365 * DAY);

  const buckets = {};
  const ensure = (mk) => (buckets[mk] = buckets[mk] || 0);

  // For revenue/sales/rebills we sum EUR by month. For churn we count lapses.
  const charges = all.filter((c) => {
    if (c.date > asOf || c.date < cutoff) return false;
    if (channel && c.channel !== channel) return false;
    if (product && product !== 'Other' && c.product !== product) return false;
    if (product === 'Other' && (!c.product || c.product === '__native_sub_unattributed__' || TRACKED.includes(c.product))) return false;
    return true;
  });

  if (metric === 'churn') {
    // approximate: count subs whose coverage lapsed in each month
    const histories = new Map();
    for (const c of charges) {
      if (c.status !== 'Paid' || c.net <= 0 || !c.product) continue;
      const id = c.email || c.customerId || c.invoiceId;
      if (!id) continue;
      const k = c.product + '||' + id;
      if (!histories.has(k)) histories.set(k, []);
      histories.get(k).push(c);
    }
    for (const [k, hist] of histories) {
      hist.sort((a, b) => a.date - b.date);
      const prod = k.split('||')[0];
      let best = null;
      for (const c of hist) {
        const m = monthsFor(prod, c.amount);
        if (m === null) continue;
        if (!best || c.date > best.date) best = { activeUntil: new Date(c.date.getTime() + (m * 30 + 7) * DAY) };
      }
      if (best && best.activeUntil < asOf && best.activeUntil >= cutoff) {
        ensure(ym(best.activeUntil));
        buckets[ym(best.activeUntil)] += 1;
      }
    }
  } else {
    // revenue | sales | rebills
    const firstDate = new Map();
    if (metric === 'sales' || metric === 'rebills') {
      for (const c of charges) {
        if (c.status !== 'Paid' || c.net <= 0 || !c.product) continue;
        const id = c.email || c.customerId || c.invoiceId;
        if (!id) continue;
        const kk = c.product + '||' + id;
        const cur = firstDate.get(kk);
        if (!cur || c.date < cur) firstDate.set(kk, c.date);
      }
    }
    for (const c of charges) {
      if (c.net <= 0 || c.currency !== 'eur') continue;
      const mk = ym(c.date);
      if (metric === 'revenue') { ensure(mk); buckets[mk] += c.net; }
      else {
        const id = c.email || c.customerId || c.invoiceId;
        const f = c.product && id ? firstDate.get(c.product + '||' + id) : null;
        const isSale = f && c.date.getTime() === f.getTime();
        if ((metric === 'sales' && isSale) || (metric === 'rebills' && !isSale)) { ensure(mk); buckets[mk] += c.net; }
      }
    }
  }

  // fill gaps
  const m0 = new Date(cutoff); m0.setUTCDate(1);
  const mZ = new Date(asOf); mZ.setUTCDate(1);
  for (let d = new Date(m0); d <= mZ; d.setUTCMonth(d.getUTCMonth() + 1)) ensure(ym(d));
  const points = Object.keys(buckets).sort().map((m) => ({ month: m, value: round(buckets[m]) }));
  return { metric, window: { start: ymd(cutoff), end: ymd(asOf) }, filter: { product: product || 'all', channel: channel || 'all' }, points };
}

/** Exact period-vs-period comparison for one metric. */
export function comparePeriods({ metric = 'revenue_eur', a_start, a_end, b_start, b_end, product, channel } = {}) {
  const a = queryMetrics({ start_date: a_start, end_date: a_end, product, channel });
  const b = queryMetrics({ start_date: b_start, end_date: b_end, product, channel });
  const av = a[metric], bv = b[metric];
  const delta = round((av || 0) - (bv || 0));
  const pct = bv ? Math.round((delta / bv) * 1000) / 10 : null;
  return {
    metric,
    period_a: { window: a.window, value: av },
    period_b: { window: b.window, value: bv },
    delta,
    pct_change: pct,
  };
}

function round(n) { return Math.round((n || 0) * 100) / 100; }

export { TRACKED };
