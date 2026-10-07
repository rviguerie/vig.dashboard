/**
 * Tagged checkout links for Atomic Homework.
 *
 * Copies an existing Stripe Payment Link (same price, thank-you page and
 * checkout settings) once per source: store, upsell emails, daily emails.
 * Each copy stamps `metadata.source` onto the subscription it creates, which
 * the members page reads (see members.js).
 *
 * Creating links needs STRIPE_WRITE_KEY (main account, restricted key with
 * Payment Links: Write, Prices: Read, Products: Read). It's only needed while
 * creating; the links are saved to Firestore (`source_links`) so the page can
 * keep showing them after the key is removed.
 */

import { getDb } from './firebase.js';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const COLLECTION = 'source_links';
export const LINK_SOURCES = ['store', 'upsell_email', 'daily_email'];

const writeKey = () => process.env.STRIPE_WRITE_KEY || '';
export const hasWriteKey = () => !!writeKey();

async function stripe(method, path, params = []) {
  const body = new URLSearchParams(params).toString();
  const url = method === 'GET' && body ? `${STRIPE_BASE}${path}?${body}` : `${STRIPE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + writeKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status} on ${path}: ${json.error?.message || 'unknown error'}`);
  return json;
}

async function listAll(path, params = []) {
  const out = [];
  let after = null;
  for (let i = 0; i < 100; i++) {
    const q = [...params, ['limit', '100']];
    if (after) q.push(['starting_after', after]);
    const page = await stripe('GET', path, q);
    out.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

function describePrice(p) {
  if (!p) return '';
  const amt = p.unit_amount != null ? (p.unit_amount / 100).toFixed(2).replace(/\.00$/, '') + ' ' + (p.currency || '').toUpperCase() : '';
  const r = p.recurring;
  const every = r ? ` / ${r.interval_count > 1 ? r.interval_count + ' ' : ''}${r.interval}` : '';
  return amt + every;
}

/**
 * Active, untagged payment links — the templates to copy. Every link is
 * offered (product names vary), Atomic Homework ones first.
 */
export async function listTemplates() {
  const links = await listAll('/payment_links', [['active', 'true']]);
  const out = [];
  for (const l of links) {
    if (l.metadata?.source) continue; // already a tagged copy
    const items = await stripe('GET', `/payment_links/${l.id}/line_items`, [['expand[]', 'data.price.product']]);
    const line = items.data?.[0];
    if (!line) continue;
    const productName = line.price?.product?.name || line.description || '';
    out.push({
      atomic: /atomic homework/i.test(productName),
      id: l.id,
      url: l.url,
      product: productName,
      price: describePrice(line.price),
      thankYou: l.after_completion?.type === 'redirect' ? l.after_completion.redirect.url : 'Stripe confirmation page',
      trialDays: l.subscription_data?.trial_period_days || 0,
    });
  }
  return out.sort((a, b) => (b.atomic - a.atomic) || a.product.localeCompare(b.product) || a.price.localeCompare(b.price));
}

/** Form params for a copy of `t` tagged with `source`. */
function copyParams(t, items, source, noTrial) {
  const p = [];
  items.forEach((it, i) => {
    p.push([`line_items[${i}][price]`, it.price.id], [`line_items[${i}][quantity]`, String(it.quantity || 1)]);
  });
  const ac = t.after_completion;
  if (ac?.type === 'redirect') p.push(['after_completion[type]', 'redirect'], ['after_completion[redirect][url]', ac.redirect.url]);
  else if (ac?.hosted_confirmation?.custom_message) {
    p.push(['after_completion[type]', 'hosted_confirmation'], ['after_completion[hosted_confirmation][custom_message]', ac.hosted_confirmation.custom_message]);
  }
  if (t.allow_promotion_codes) p.push(['allow_promotion_codes', 'true']);
  if (t.billing_address_collection) p.push(['billing_address_collection', t.billing_address_collection]);
  if (t.phone_number_collection?.enabled) p.push(['phone_number_collection[enabled]', 'true']);
  if (t.automatic_tax?.enabled) p.push(['automatic_tax[enabled]', 'true']);
  if (t.tax_id_collection?.enabled) p.push(['tax_id_collection[enabled]', 'true']);
  if (t.payment_method_collection) p.push(['payment_method_collection', t.payment_method_collection]);
  for (const m of t.payment_method_types || []) p.push(['payment_method_types[]', m]);
  const sd = t.subscription_data || {};
  if (sd.trial_period_days && !noTrial) p.push(['subscription_data[trial_period_days]', String(sd.trial_period_days)]);
  if (sd.description) p.push(['subscription_data[description]', sd.description]);
  // Keep any metadata the original carries (automations may rely on it), then add the tag.
  for (const [k, v] of Object.entries(t.metadata || {})) p.push([`metadata[${k}]`, v]);
  for (const [k, v] of Object.entries(sd.metadata || {})) p.push([`subscription_data[metadata][${k}]`, v]);
  p.push(['metadata[source]', source], ['metadata[copied_from]', t.id], ['subscription_data[metadata][source]', source]);
  return p;
}

/** Create (or reuse) tagged copies of template `templateId`, one per source, and save them. */
export async function createTaggedLinks(templateId, sources = LINK_SOURCES, noTrial = false) {
  sources = LINK_SOURCES.filter((s) => sources.includes(s));
  if (!sources.length) throw new Error('Pick at least one place the link is for.');
  const t = await stripe('GET', `/payment_links/${templateId}`);
  const items = (await stripe('GET', `/payment_links/${templateId}/line_items`, [['expand[]', 'data.price.product']])).data || [];
  if (!items.length) throw new Error('That checkout link has no items.');
  const existing = await listAll('/payment_links', [['active', 'true']]);
  const rows = [];
  for (const source of sources) {
    const trialTag = noTrial && t.subscription_data?.trial_period_days ? 'none' : '';
    let link = existing.find((l) => l.metadata?.source === source && l.metadata?.copied_from === templateId &&
      (l.metadata?.trial || '') === trialTag);
    if (!link) {
      const params = copyParams(t, items, source, noTrial);
      if (trialTag) params.push(['metadata[trial]', trialTag]);
      link = await stripe('POST', '/payment_links', params);
    }
    const trialDays = trialTag ? 0 : (t.subscription_data?.trial_period_days || 0);
    rows.push({
      id: link.id,
      source,
      url: link.url,
      copied_from: templateId,
      product: items[0].price?.product?.name || '',
      price: describePrice(items[0].price) + (trialDays ? ` · ${trialDays}-day free trial` : ''),
      created: link.created || Math.floor(Date.now() / 1000),
    });
  }
  const db = getDb();
  const batch = db.batch();
  for (const r of rows) batch.set(db.collection(COLLECTION).doc(r.id), r, { merge: true });
  await batch.commit();
  return rows;
}

/** Switch off a tagged copy in Stripe and drop it from the saved list. */
export async function deactivateLink(id) {
  const doc = await getDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) throw new Error('Not one of the saved tagged links.');
  await stripe('POST', `/payment_links/${id}`, [['active', 'false']]);
  await getDb().collection(COLLECTION).doc(id).delete();
}

/** Links saved by earlier runs (works without the write key). */
export async function savedLinks() {
  const snap = await getDb().collection(COLLECTION).get();
  const out = [];
  snap.forEach((d) => out.push(d.data()));
  return out.sort((a, b) => (a.price || '').localeCompare(b.price || '') || LINK_SOURCES.indexOf(a.source) - LINK_SOURCES.indexOf(b.source));
}
