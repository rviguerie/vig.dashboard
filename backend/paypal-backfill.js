/**
 * One-shot PayPal historical backfill.
 *
 * Pulls ~3 years of PayPal transactions (the API's history limit), filters
 * to real payments + refunds, and writes them into the same Firestore
 * `charges` collection used by Stripe. Run locally against production
 * Firebase credentials, once.
 *
 * Usage:  node backend/paypal-backfill.js [years]
 *         (years defaults to 3)
 */

import 'dotenv/config';
import { initFirebase } from './firebase.js';
import { warmCache } from './cache.js';
import { backfillPayPal } from './paypal-refresh.js';

async function main() {
  const years = parseInt(process.argv[2] || '3', 10);
  initFirebase();
  // Warm cache first so backfill dedupes against anything already present
  await warmCache();
  const result = await backfillPayPal(years);
  console.log('[paypal-backfill] result:', result);
  await warmCache();
  console.log('[paypal-backfill] cache re-warmed; done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[paypal-backfill] failed:', err);
  process.exit(1);
});
