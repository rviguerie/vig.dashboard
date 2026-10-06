/**
 * Express server entry point.
 *
 * Routes:
 *   GET  /api/health           Liveness probe (no auth)
 *   GET  /firebase-config.js   Public Firebase web config (no auth)
 *   GET  /api/charges          Cached charge list (auth required)
 *   POST /api/refresh          Force a Stripe pull now (auth required)
 *   GET  /api/members          Atomic Homework member join dates + sources (auth required)
 *   GET  /                     → /login (or /dashboard if authed in browser)
 *   /login, /dashboard         Static HTML
 *
 * Boot sequence:
 *   1. Load env, init Firebase Admin
 *   2. Warm cache from Firestore
 *   3. Schedule hourly cron
 *   4. Listen on PORT
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initFirebase } from './firebase.js';
import { requireAuth } from './auth.js';
import { warmCache, getCachedCharges, getCacheMeta } from './cache.js';
import { refreshFromStripe } from './stripe-refresh.js';
import { refreshPayPal } from './paypal-refresh.js';
import { chatWithData } from './chat.js';
import { warmMembers, syncMembers, buildMembers, getMembersMeta, SOURCES } from './members.js';
import { startCron } from './cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Public endpoints ────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  const meta = getCacheMeta();
  res.json({ ok: true, ...meta });
});

/**
 * Expose Firebase web config as a JS file so login.html can <script src=…>.
 * These values are NOT secrets — they're meant to be in client code.
 */
app.get('/firebase-config.js', (_req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  };
  res.type('application/javascript');
  res.send(`window.FIREBASE_CONFIG = ${JSON.stringify(config)};\n`);
});

// ─── Protected API ───────────────────────────────────────────────────

const auth = requireAuth();

app.get('/api/me', auth, (req, res) => {
  res.json(req.user);
});

app.get('/api/charges', auth, (_req, res) => {
  const meta = getCacheMeta();
  res.json({
    charges: getCachedCharges(),
    warming: !meta.warmedAt, // cache still loading right after a deploy
    ...meta,
  });
});

app.post('/api/refresh', auth, async (_req, res) => {
  const out = {};
  try {
    out.stripe = await refreshFromStripe();
  } catch (err) {
    console.error('[/api/refresh] Stripe failed:', err);
    out.stripeError = err.message;
  }
  if (process.env.PAYPAL_CLIENT_ID) {
    try {
      out.paypal = await refreshPayPal();
    } catch (err) {
      console.error('[/api/refresh] PayPal failed:', err);
      out.paypalError = err.message;
    }
  }
  try {
    out.members = await syncMembers();
  } catch (err) {
    console.error('[/api/refresh] member sync failed:', err);
    out.membersError = err.message;
  }
  const added = (out.stripe?.added || 0) + (out.paypal?.added || 0);
  res.json({ ok: true, result: { added, ...out }, meta: getCacheMeta() });
});

app.get('/api/members', auth, (_req, res) => {
  const meta = getMembersMeta();
  if (!getCacheMeta().warmedAt || !meta.warmedAt) return res.json({ warming: true });
  res.json({ ...buildMembers(), sources: SOURCES, ...meta });
});

app.post('/api/chat', auth, async (req, res) => {
  if (!process.env.OPENROUTER_KEY) {
    return res.status(503).json({ ok: false, error: 'Chat is not configured (OPENROUTER_KEY missing).' });
  }
  if (!getCacheMeta().warmedAt) {
    return res.status(503).json({ ok: false, error: 'Data is still warming up — try again in a few seconds.' });
  }
  const history = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!history || !history.length) {
    return res.status(400).json({ ok: false, error: 'Provide messages: [{role, content}].' });
  }
  // Keep only role/content, cap history length to bound cost
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await chatWithData(clean, today);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[/api/chat] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Static files & routing ──────────────────────────────────────────

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => res.redirect('/login'));

// SPA-ish fallback for unmatched routes (excluding /api/*)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// ─── Boot ────────────────────────────────────────────────────────────

function boot() {
  console.log('[boot] starting…');

  // Bind the port FIRST so the platform healthcheck passes within ~1s, then
  // warm the cache in the background. This avoids a multi-second boot-to-listen
  // gap (the cache reads ~40k Firestore docs) that made deploy swaps flaky.
  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => console.log(`[boot] listening on :${port}`));

  try {
    initFirebase();
    console.log('[boot] Firebase initialized');
    warmCache()
      .then(() => {
        startCron();
        console.log('[boot] cache warm complete; data + cron ready');
      })
      .catch((err) => console.error('[boot] cache warm failed:', err));
    // Member-source data is independent: a failure here must not block the main dashboard.
    warmMembers()
      .then(() => syncMembers())
      .catch((err) => console.error('[boot] member warm/sync failed:', err));
  } catch (err) {
    console.error('[boot] init failed:', err);
  }
}

boot();
