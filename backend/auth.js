/**
 * Auth middleware.
 *
 * Expects an `Authorization: Bearer <firebase_id_token>` header on every
 * /api/* request. Verifies the token via Firebase Admin, then checks the
 * caller's email is in ALLOWED_EMAILS (case-insensitive, trimmed).
 *
 * Attaches the verified user to req.user on success.
 */

import { getAuth, getAuthProjectId } from './firebase.js';

/** Turn a Firebase verify error into a plain-English reason. */
function explain(err, projectId) {
  const code = err.code || '';
  const msg = err.message || '';
  if (code === 'auth/id-token-expired') return 'Sign-in token has expired. Sign in again.';
  if (/"aud"|audience/i.test(msg)) {
    return `Token is for a different Firebase project than the server checks ("${projectId}"). ` +
      'FIREBASE_PROJECT_ID and the FIREBASE_SERVICE_ACCOUNT_JSON project must match the web app config.';
  }
  if (/"iat"|issued-at|future/i.test(msg)) return 'Server clock is out of sync with Google.';
  return msg;
}

function getAllowedEmails() {
  const raw = process.env.ALLOWED_EMAILS || '';
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function requireAuth() {
  const allowlist = getAllowedEmails();
  if (allowlist.size === 0) {
    console.warn('[auth] ALLOWED_EMAILS is empty — nobody can sign in.');
  }

  return async function (req, res, next) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
    }
    const token = match[1].trim();

    let verifier, projectId;
    try {
      verifier = getAuth();
      projectId = getAuthProjectId();
    } catch (err) {
      // Server setup problem (bad or missing service account), not the user's token.
      console.error('[auth] Firebase Admin is not configured:', err.message);
      return res.status(500).json({ error: 'Server sign-in is not configured', detail: err.message });
    }

    let decoded;
    try {
      decoded = await verifier.verifyIdToken(token);
    } catch (err) {
      const detail = explain(err, projectId);
      console.warn(`[auth] token rejected (${err.code || 'unknown'}): ${err.message}`);
      return res.status(401).json({ error: 'Invalid or expired token', detail });
    }

    const email = (decoded.email || '').toLowerCase();
    if (!email) {
      return res.status(403).json({ error: 'Token has no email claim' });
    }
    if (!allowlist.has(email)) {
      return res.status(403).json({
        error: 'Email not allowed',
        email,
        hint: 'Ask the admin to add this address to ALLOWED_EMAILS.',
      });
    }

    req.user = { uid: decoded.uid, email, name: decoded.name || '' };
    next();
  };
}
