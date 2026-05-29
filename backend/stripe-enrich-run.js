/**
 * One-shot runner for native-sub enrichment.
 * Usage: node backend/stripe-enrich-run.js   (or npm run enrich-stripe)
 */

import 'dotenv/config';
import { initFirebase } from './firebase.js';
import { warmCache } from './cache.js';
import { enrichAllNativeSubs } from './stripe-enrich.js';

async function main() {
  initFirebase();
  await warmCache();
  const result = await enrichAllNativeSubs();
  console.log('[enrich-run] result:', result);
  process.exit(0);
}

main().catch((err) => {
  console.error('[enrich-run] failed:', err);
  process.exit(1);
});
