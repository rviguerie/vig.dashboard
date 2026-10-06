/**
 * One-shot: create tagged Stripe Payment Links for Atomic Homework, one per
 * source (store, upsell emails, daily emails) per price. Each link stamps
 * `metadata.source` onto the subscription it creates, which the
 * "Where members come from" page reads.
 *
 * Needs a SEPARATE write key, used only for this run (the dashboard's own
 * keys stay read-only):
 *   Stripe → Developers → API keys → Create restricted key
 *     Payment Links: Write, Products: Read, Prices: Read
 *
 * Usage:
 *   STRIPE_WRITE_KEY=rk_live_... npm run make-links
 *   STRIPE_WRITE_KEY=rk_live_... npm run make-links -- price_123 price_456
 *
 * With no price IDs, it uses every active recurring price on products whose
 * name contains "Atomic Homework". Safe to re-run: existing active links with
 * the same source + price are reused, not duplicated.
 */

import 'dotenv/config';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const LINK_SOURCES = ['store', 'upsell_email', 'daily_email'];

const key = process.env.STRIPE_WRITE_KEY;

async function stripe(method, path, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const url = method === 'GET' && body ? `${STRIPE_BASE}${path}?${body}` : `${STRIPE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status} on ${path}: ${json.error?.message || JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function listAll(path, params = []) {
  const out = [];
  let after = null;
  for (;;) {
    const q = [...params, ['limit', '100']];
    if (after) q.push(['starting_after', after]);
    const page = await stripe('GET', path, q);
    out.push(...page.data);
    if (!page.has_more || !page.data.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

async function atomicPrices() {
  const products = await listAll('/products', [['active', 'true']]);
  const atomic = products.filter((p) => /atomic homework/i.test(p.name || ''));
  if (!atomic.length) throw new Error('No active product with "Atomic Homework" in its name.');
  const prices = [];
  for (const p of atomic) {
    const list = await listAll('/prices', [['product', p.id], ['active', 'true'], ['type', 'recurring']]);
    prices.push(...list.map((pr) => ({ ...pr, productName: p.name })));
  }
  return prices;
}

function describePrice(p) {
  const amt = p.unit_amount != null ? (p.unit_amount / 100).toFixed(2) + ' ' + (p.currency || '').toUpperCase() : '?';
  const every = p.recurring ? `/${p.recurring.interval_count > 1 ? p.recurring.interval_count + ' ' : ''}${p.recurring.interval}` : '';
  return `${p.productName || p.product} · ${amt}${every}${p.nickname ? ' · ' + p.nickname : ''}`;
}

async function main() {
  if (!key) throw new Error('Set STRIPE_WRITE_KEY (restricted key: Payment Links Write, Products Read, Prices Read).');

  const argIds = process.argv.slice(2).filter((a) => a.startsWith('price_'));
  const prices = argIds.length
    ? await Promise.all(argIds.map((id) => stripe('GET', `/prices/${id}`, [['expand[]', 'product']])
        .then((p) => ({ ...p, productName: p.product?.name }))))
    : await atomicPrices();

  const existing = await listAll('/payment_links', [['active', 'true']]);
  const rows = [];
  for (const price of prices) {
    for (const source of LINK_SOURCES) {
      let link = existing.find((l) => l.metadata?.source === source && l.metadata?.price === price.id);
      const reused = !!link;
      if (!link) {
        link = await stripe('POST', '/payment_links', [
          ['line_items[0][price]', price.id],
          ['line_items[0][quantity]', '1'],
          ['metadata[source]', source],
          ['metadata[price]', price.id],
          ['subscription_data[metadata][source]', source],
        ]);
      }
      rows.push({ price: describePrice(price), source, url: link.url, reused });
    }
  }

  console.log('\nTagged Atomic Homework checkout links:\n');
  for (const r of rows) {
    console.log(`  ${r.source.padEnd(13)} ${r.url}   (${r.price}${r.reused ? ', already existed' : ''})`);
  }
  console.log('\nUse the "store" link on the store page, "upsell_email" in upsell emails, and "daily_email" in daily emails.\n');
}

main().catch((err) => {
  console.error('[make-links] failed:', err.message);
  process.exit(1);
});
