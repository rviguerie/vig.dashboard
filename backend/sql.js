/**
 * Read-only SQL over the charge ledger, for the chat agent.
 *
 * The agent writes SELECT queries against a `charges` table; we execute them
 * deterministically with alasql and return exact rows. This unlocks anything
 * the pre-baked metric tools can't express — LTV, cohort retention, "bought X
 * then Y", per-customer rollups — while keeping numbers exact (the model never
 * does the arithmetic; the query engine does).
 *
 * Hard read-only: only SELECT/WITH, single statement, no DDL/DML keywords. The
 * table is rebuilt from a fresh cache copy on every call, so a query can never
 * mutate persistent state.
 */

import alasqlPkg from 'alasql';
import { getCachedCharges } from './cache.js';

const alasql = alasqlPkg.default || alasqlPkg;

const MAX_ROWS = 500;
const TABLE = 'charges';

// Columns exposed to the agent (derived from each raw charge).
export const SQL_COLUMNS = [
  { name: 'id', desc: 'charge id (Stripe ch_… or PayPal txn id)' },
  { name: 'date', desc: 'charge date, YYYY-MM-DD string (use for = and range filters; do NOT use MIN/MAX on it — alasql cannot aggregate strings, use created instead)' },
  { name: 'ym', desc: "charge month as 'YYYY-MM' string (handy for GROUP BY month)" },
  { name: 'cohort_month', desc: "the customer's FIRST paid-charge month as 'YYYY-MM' — use this for cohort analysis (e.g. cohort_month='2026-01')" },
  { name: 'created', desc: 'unix timestamp seconds (numeric — use this for MIN/MAX / earliest / latest / first-purchase logic)' },
  { name: 'amount', desc: 'gross amount in the charge currency' },
  { name: 'amount_refunded', desc: 'refunded portion' },
  { name: 'net', desc: 'amount - amount_refunded' },
  { name: 'currency', desc: "'eur' or 'usd' (revenue is overwhelmingly eur)" },
  { name: 'status', desc: "'Paid' or 'Refunded'" },
  { name: 'product', desc: 'product name (e.g. "Vig Village", "Mr. Vigs Atomic Homework")' },
  { name: 'customer_email', desc: 'customer email (the join key for per-customer work)' },
  { name: 'customer_id', desc: 'Stripe/PayPal customer id' },
  { name: 'invoice_id', desc: 'Stripe invoice id, if any' },
  { name: 'channel', desc: "'kartra_orchestrated' | 'native_stripe_sub' | 'paypal'" },
  { name: 'source', desc: "'csv' | 'stripe_api' | 'paypal_api'" },
];

let tableReady = false;

function ensureTable() {
  if (!tableReady) {
    try { alasql('DROP TABLE IF EXISTS ' + TABLE); } catch { /* ignore */ }
    alasql('CREATE TABLE ' + TABLE);
    tableReady = true;
  }
  // Rebuild data fresh each call (cheap at ~40k rows) so no query can leave
  // mutated state behind for the next one.
  const cache = getCachedCharges();

  // Pass 1: each customer's first Paid-charge month → acquisition cohort.
  // Pre-computing this avoids the AI needing MIN() on a string date column,
  // which alasql cannot aggregate (it silently returns empty).
  const firstTs = new Map();
  for (const c of cache) {
    if (c.status !== 'Paid') continue;
    const email = (c.customer_email || '').toLowerCase();
    if (!email) continue;
    const ts = parseInt(c.created, 10);
    if (!ts) continue;
    const cur = firstTs.get(email);
    if (cur === undefined || ts < cur) firstTs.set(email, ts);
  }
  const cohortOf = (email) => {
    const ts = firstTs.get(email);
    return ts ? new Date(ts * 1000).toISOString().slice(0, 7) : '';
  };

  const rows = [];
  for (const c of cache) {
    const ts = parseInt(c.created, 10);
    const amount = parseFloat(c.amount || 0);
    const refunded = parseFloat(c.amount_refunded || 0);
    const email = (c.customer_email || '').toLowerCase();
    const iso = ts ? new Date(ts * 1000).toISOString() : null;
    rows.push({
      id: c.id,
      date: iso ? iso.slice(0, 10) : null,
      ym: iso ? iso.slice(0, 7) : null,
      cohort_month: cohortOf(email),
      created: ts || 0,
      amount,
      amount_refunded: refunded,
      net: amount - refunded,
      currency: (c.currency || '').toLowerCase(),
      status: c.status || '',
      product: c.description || '',
      customer_email: email,
      customer_id: c.customer_id || '',
      invoice_id: c.invoice_id || '',
      channel: c.channel || '',
      source: c.source || '',
    });
  }
  alasql.tables[TABLE].data = rows;
  return rows.length;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|truncate|replace|into|pragma|copy|merge|grant|revoke)\b/i;

function validate(query) {
  const q = (query || '').trim().replace(/;+\s*$/, ''); // allow a single trailing semicolon
  if (!q) return { error: 'Empty query.' };
  if (q.includes(';')) return { error: 'Only a single statement is allowed (no semicolons).' };
  if (!/^(select|with)\b/i.test(q)) return { error: 'Only SELECT/WITH queries are allowed.' };
  if (FORBIDDEN.test(q)) return { error: 'Query contains a forbidden (write/DDL) keyword. Read-only SELECT only.' };
  if (q.length > 4000) return { error: 'Query too long.' };
  return { q };
}

/**
 * Run a read-only SELECT. Returns { columns, rows, rowCount, truncated } or { error }.
 */
export function runSql(query) {
  const v = validate(query);
  if (v.error) return { error: v.error };
  try {
    ensureTable();
    const result = alasql(v.q);
    if (!Array.isArray(result)) {
      return { columns: [], rows: [], rowCount: 0, note: 'Query returned no tabular result.' };
    }
    const truncated = result.length > MAX_ROWS;
    const rows = truncated ? result.slice(0, MAX_ROWS) : result;
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: result.length, truncated };
  } catch (err) {
    return { error: 'SQL error: ' + err.message };
  }
}
