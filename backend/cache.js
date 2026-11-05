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
let warmError = null;      // last startup-load error message, cleared on success
let warmAttempts = 0;
let warmPromise = null;    // in-flight load, shared by everyone waiting on it

const WARM_TIMEOUT_MS = 3 * 60 * 1000;

export function getCachedCharges() {
  return charges;
}

export function isWarm() {
  return !!warmedAt;
}

export function getCacheMeta() {
  return {
    count: charges.length,
    warmedAt,
    warmError,
    warmAttempts,
    lastRefreshAt,
    lastRefreshResult,
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadOnce() {
  warmAttempts++;
  const db = getDb();
  console.log(`[cache] warming from Firestore (attempt ${warmAttempts})…`);
  const t0 = Date.now();
  const snap = await withTimeout(db.collection(COLLECTION).get(), WARM_TIMEOUT_MS, 'Firestore load');
  const next = [];
  const nextIdx = new Map();
  snap.forEach(doc => {
    const d = doc.data();
    nextIdx.set(doc.id, next.length);
    next.push({ id: doc.id, ...d });
  });
  // Keep anything a refresh added while the load was running.
  for (const c of charges) {
    if (!nextIdx.has(c.id)) { nextIdx.set(c.id, next.length); next.push(c); }
  }
  charges = next;
  byId = nextIdx;
  warmedAt = new Date().toISOString();
  warmError = null;
  const ms = Date.now() - t0;
  console.log(`[cache] warmed: ${charges.length.toLocaleString()} charges in ${ms}ms`);
}

/** One load attempt. Concurrent callers share it. Throws on failure. */
export function ensureWarm() {
  if (warmedAt) return Promise.resolve();
  if (!warmPromise) {
    warmPromise = loadOnce()
      .catch(err => {
        warmError = err.message || String(err);
        console.error(`[cache] warm failed (attempt ${warmAttempts}): ${warmError}`);
        throw err;
      })
      .finally(() => { warmPromise = null; });
  }
  return warmPromise;
}

/**
 * Load the cache from Firestore.
 *   retry: keep trying until it works (5s, 10s, 20s … then every 2 min). Used at server boot.
 *   force: reload even if already loaded (scripts re-checking totals).
 */
export async function warmCache({ retry = false, force = false } = {}) {
  if (force) { warmedAt = null; charges = []; byId = new Map(); }
  let delay = 5000;
  for (;;) {
    try {
      await ensureWarm();
      return;
    } catch (err) {
      if (!retry) throw err;
      console.error(`[cache] retrying Firestore load in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 120000);
    }
  }
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
  // A failed run is kept in lastRefreshResult but doesn't move "last sync".
  if (!result?.error) lastRefreshAt = new Date().toISOString();
  lastRefreshResult = result;
}

/**
 * Patch fields onto already-cached charges in place (used by enrichment).
 * `updates` is an array of { id, ...fieldsToMerge }.
 */
export function updateCachedCharges(updates) {
  let n = 0;
  for (const u of updates) {
    const idx = byId.get(u.id);
    if (idx !== undefined) {
      Object.assign(charges[idx], u);
      n++;
    }
  }
  return n;
}
