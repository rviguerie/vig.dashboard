/**
 * In-memory charge cache.
 *
 * Strategy:
 *   - On boot: warmCache() reads every doc from Firestore once.
 *   - On refresh: appendToCache() adds the new docs (no re-read).
 *   - GET /api/charges serves the in-memory array directly.
 *
 * This keeps Firestore reads to ~1 query per process lifetime, regardless
 * of how many dashboard loads happen. Well within the free tier.
 */

import { getDb } from './firebase.js';

const COLLECTION = 'charges';

let charges = [];          // array of charge objects (Firestore docs flattened)
let byId = new Map();      // id → index in `charges` for fast dedupe
let warmedAt = null;       // ISO timestamp of last full warm
let lastRefreshAt = null;  // ISO timestamp of last successful refresh
let lastRefreshResult = null;

export function getCachedCharges() {
  return charges;
}

export function getCacheMeta() {
  return {
    count: charges.length,
    warmedAt,
    lastRefreshAt,
    lastRefreshResult,
  };
}

export async function warmCache() {
  const db = getDb();
  console.log('[cache] warming from Firestore…');
  const t0 = Date.now();
  const snap = await db.collection(COLLECTION).get();
  const next = [];
  const nextIdx = new Map();
  snap.forEach(doc => {
    const d = doc.data();
    nextIdx.set(doc.id, next.length);
    next.push({ id: doc.id, ...d });
  });
  charges = next;
  byId = nextIdx;
  warmedAt = new Date().toISOString();
  const ms = Date.now() - t0;
  console.log(`[cache] warmed: ${charges.length.toLocaleString()} charges in ${ms}ms`);
}

/**
 * Merge a batch of fresh charges into the cache. Used by refreshFromStripe()
 * after a successful Firestore write so the cache stays hot without a re-read.
 */
export function appendToCache(newCharges) {
  let added = 0;
  let updated = 0;
  for (const c of newCharges) {
    const existingIdx = byId.get(c.id);
    if (existingIdx === undefined) {
      byId.set(c.id, charges.length);
      charges.push(c);
      added++;
    } else {
      charges[existingIdx] = c;
      updated++;
    }
  }
  return { added, updated };
}

export function recordRefresh(result) {
  lastRefreshAt = new Date().toISOString();
  lastRefreshResult = result;
}
