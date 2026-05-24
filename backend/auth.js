/**
 * Auth middleware.
 *
 * Expects an `Authorization: Bearer <firebase_id_token>` header on every
 * /api/* request. Verifies the token via Firebase Admin, then checks the
 * caller's email is in ALLOWED_EMAILS (case-insensitive, trimmed).
 *
 * Attaches the verified user to req.user on success.
 */

import { getAuth } from './firebase.js';

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

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
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
