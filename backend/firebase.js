/**
 * Firebase Admin SDK initialization.
 *
 * Reads the service-account JSON from FIREBASE_SERVICE_ACCOUNT_JSON env var.
 * Exposes a single shared App/Auth/Firestore instance so the rest of the
 * backend doesn't have to think about init ordering.
 *
 * Sign-in tokens are checked against FIREBASE_PROJECT_ID — the same project
 * the browser signs in to — so a service account from another project can't
 * make every login fail with "Invalid or expired token".
 */

import admin from 'firebase-admin';

let app;
let authApp;
let serviceAccountProjectId = '';

/**
 * Parse the service-account env var, tolerating the usual ways it gets
 * mangled when pasted into a hosting dashboard such as Railway:
 *   - wrapped in an extra pair of quotes
 *   - base64-encoded
 *   - private_key with literal "\n" instead of real line breaks
 */
function parseServiceAccount(raw) {
  let text = raw.trim();

  // Strip one layer of surrounding quotes ("{...}" or '{...}').
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const inner = text.slice(1, -1);
    // A JSON-encoded string ("{\"type\":...}") — decode it properly.
    try {
      const decoded = JSON.parse(text);
      text = typeof decoded === 'string' ? decoded.trim() : inner.trim();
    } catch {
      text = inner.trim();
    }
  }

  // Allow base64 of the JSON file.
  if (!text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) text = decoded;
    } catch { /* fall through to the JSON error below */ }
  }

  let sa;
  try {
    sa = JSON.parse(text);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
  }

  if (typeof sa.private_key === 'string') {
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!sa[field]) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is missing "${field}".`);
    }
  }
  return sa;
}

export function initFirebase() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is not set.');
  }

  const serviceAccount = parseServiceAccount(raw);
  serviceAccountProjectId = serviceAccount.project_id;

  const webProjectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  if (webProjectId && webProjectId !== serviceAccountProjectId) {
    console.warn(
      `[firebase] Project mismatch: FIREBASE_PROJECT_ID is "${webProjectId}" but ` +
      `FIREBASE_SERVICE_ACCOUNT_JSON is for "${serviceAccountProjectId}". ` +
      `Sign-in tokens are checked against "${webProjectId}"; Firestore uses ` +
      `"${serviceAccountProjectId}". Generate the service-account key from the same project.`
    );
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccountProjectId,
  });

  return app;
}

/** Project the browser signs in to (falls back to the service account's). */
export function getAuthProjectId() {
  initFirebase();
  return (process.env.FIREBASE_PROJECT_ID || '').trim() || serviceAccountProjectId;
}

export function getAuth() {
  initFirebase();
  const projectId = getAuthProjectId();
  if (projectId === serviceAccountProjectId) return admin.auth(app);

  // Checking a sign-in token only needs Google's public keys and the project
  // ID, so a separate app pinned to the browser's project is enough.
  if (!authApp) {
    authApp = admin.initializeApp({ projectId }, 'auth-verify');
  }
  return admin.auth(authApp);
}

export function getDb() {
  initFirebase();
  return admin.firestore();
}

/** Firestore FieldValue / Timestamp helpers for write paths. */
export { admin };
