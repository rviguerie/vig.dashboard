/**
 * Firebase Admin SDK initialization.
 *
 * Reads the service-account JSON from FIREBASE_SERVICE_ACCOUNT_JSON env var.
 * Exposes a single shared App/Auth/Firestore instance so the rest of the
 * backend doesn't have to think about init ordering.
 */

import admin from 'firebase-admin';

let app;

export function initFirebase() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is not set.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return app;
}

export function getAuth() {
  initFirebase();
  return admin.auth();
}

export function getDb() {
  initFirebase();
  return admin.firestore();
}

/** Firestore FieldValue / Timestamp helpers for write paths. */
export { admin };
