/**
 * Stripe native-subscription product enrichment.
 *
 * Native Stripe sub charges store a generic description ("Subscription
 * creation", "Invoice XXXX-0002") instead of the product name — the product
 * lives on the subscription's Price/Plan. This module resolves the real
 * product per charge by looking up its invoice, then overwrites the charge's
 * `description` with the canonical product name so the existing dashboard
 * attribution (which keys off description) picks it up. The original text is
 * preserved in `raw_description` and the charge is flagged `enriched: true`
 * for idempotency.
 *
 * Handles both modern invoices (line.price.product) and legacy ones
 * (line.plan.product / line.plan.name).
 */

import { getDb } from './firebase.js';
import { getCachedCharges, updateCachedCharges } from './cache.js';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const COLLECTION = 'charges';
const WRITE_BATCH = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getKey() {
  const k = process.env.STRIPE_KEY;
  if (!k) throw new Error('STRIPE_KEY not set');
  return k;
}

// Canonical product mapping — kept in sync with dashboard PRICE_RULES keys
// and paypal-refresh.js normalizeProductName.
function normalizeProductName(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low.includes('atomic homework')) return 'Mr. Vigs Atomic Homework';
  if (low.includes('vitamin v')) return 'Vitamin V EXTRA STRENGTH';
  if (low.includes('speaking school')) return 'Speaking School';
  if (low.includes('vig village') &&
      !low.includes('golden visa') &&
      !low.includes('vocabulary') &&
      !low.includes('accelerator')) {
    return 'Vig Village';
  }
  return s; // real but untracked product → falls into "Other"
}

function isUnattributedNative(c) {
  if (c.channel !== 'native_stripe_sub') return false;
  if (c.enriched) return false;
  const d = (c.description || '').trim();
  return d === '' ||
    d === 'Subscription creation' ||
    d.startsWith('Invoice ') ||
    d.startsWith('Payment for invoice ');
}

async function resolveProductFromInvoice(invoiceId, key) {
  const url = `${STRIPE_BASE}/invoices/${invoiceId}` +
    '?expand[]=lines.data.price.product&expand[]=lines.data.plan.product';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
  if (res.status === 429) {
    await sleep(2000);
    return resolveProductFromInvoice(invoiceId, key);
  }
  if (!res.ok) return null;
  const inv = await res.json();
  const line = (inv.lines?.data || [])[0] || {};
  const rawName =
    (line.price && typeof line.price.product === 'object' && line.price.product.name) ||
    (line.plan && typeof line.plan.product === 'object' && line.plan.product.name) ||
    (line.plan && line.plan.name) ||
    line.description ||
    null;
  return rawName ? rawName.trim() : null;
}

async function persistUpdates(updates) {
  if (!updates.length) return 0;
  const db = getDb();
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const chunk = updates.slice(i, i + WRITE_BATCH);
    const batch = db.batch();
    for (const u of chunk) {
      batch.set(
        db.collection(COLLECTION).doc(u.id),
        { description: u.description, raw_description: u.raw_description, enriched: true },
        { merge: true }
      );
    }
    await batch.commit();
  }
  updateCachedCharges(updates.map((u) => ({
    id: u.id, description: u.description, raw_description: u.raw_description, enriched: true,
  })));
  return updates.length;
}

/**
 * Enrich a specific set of charge objects (used by the hourly refresh for
 * newly-arrived native subs).
 */
export async function enrichCharges(charges) {
  const key = getKey();
  const targets = charges.filter(isUnattributedNative);
  if (!targets.length) return { scanned: charges.length, enriched: 0 };
  const updates = [];
  for (const c of targets) {
    if (!(c.invoice_id || '').startsWith('in_')) continue;
    const name = await resolveProductFromInvoice(c.invoice_id, key);
    if (name) {
      updates.push({ id: c.id, description: normalizeProductName(name), raw_description: c.description || '' });
    }
    await sleep(60);
  }
  const n = await persistUpdates(updates);
  return { scanned: targets.length, enriched: n };
}

/**
 * One-shot: scan the whole cache for unattributed native subs and enrich.
 */
export async function enrichAllNativeSubs() {
  const key = getKey();
  const t0 = Date.now();
  const targets = getCachedCharges().filter(isUnattributedNative);
  console.log(`[enrich] ${targets.length} unattributed native-sub charges to resolve`);

  const updates = [];
  let done = 0;
  let failed = 0;
  for (const c of targets) {
    if (!(c.invoice_id || '').startsWith('in_')) { failed++; continue; }
    const name = await resolveProductFromInvoice(c.invoice_id, key);
    if (name) {
      updates.push({ id: c.id, description: normalizeProductName(name), raw_description: c.description || '' });
    } else {
      failed++;
    }
    done++;
    if (done % 100 === 0) {
      console.log(`[enrich] resolved ${done}/${targets.length} (writing in batches as we go)…`);
      // flush periodically so progress is durable on long runs
      await persistUpdates(updates.splice(0, updates.length));
    }
    await sleep(60);
  }
  const written = await persistUpdates(updates);
  const result = {
    targets: targets.length,
    enriched: done - failed,
    failed,
    durationMs: Date.now() - t0,
    finishedAt: new Date().toISOString(),
  };
  console.log(`[enrich] done: ${JSON.stringify(result)} (final batch wrote ${written})`);
  return result;
}
