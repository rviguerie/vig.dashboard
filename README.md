# Mr. Vig LLC — Revenue Dashboard

Self-hosted Node.js app. Pulls Stripe charges hourly, stores them in Firestore, serves a dashboard behind Google sign-in. Designed for Railway deployment.

```
Browser  →  Express (Railway)  →  Firestore
                ↓ hourly cron
            Stripe API
```

## Stack
- **Backend:** Node 20 + Express + node-cron
- **Data:** Firestore (`charges` collection, one doc per Stripe charge ID)
- **Auth:** Firebase Auth (Google OAuth) + server-side email allowlist
- **Hosting:** Railway

---

## Local development

```bash
cd app
npm install
cp .env.example .env
# fill in real values in .env  (see "Env vars" below)
npm run dev
# → http://localhost:3000
```

On first start the server warms its in-memory cache from Firestore (one query). All subsequent dashboard loads serve from cache. The hourly cron pulls Stripe deltas in-process.

---

## Initial seed (one time, before first deploy)

The `unified_payments (1).csv` file sits in the parent folder. To bulk-load ~35k historical charges into Firestore:

```bash
cd app
npm run seed
```

This:
1. Streams the CSV row by row, skips non-Paid/non-Refunded rows
2. Writes to Firestore in 500-doc batches (~70 batches, ~30 seconds total)
3. Triggers one Stripe API refresh to grab any charges newer than the CSV's max date
4. Warms the cache and exits

Safe to re-run — dedupes by charge ID.

---

## Env vars

See `.env.example`. Required ones:

| Var | Source |
|---|---|
| `STRIPE_KEY` | Stripe dashboard → Developers → API keys → Create restricted key (Read for Charges, Customers, Invoices, Subscriptions) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase console → Project settings → Service accounts → Generate new private key. Paste the entire JSON as a single-line string. |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | Firebase console → Project settings → "Your apps" → Web app config |
| `ALLOWED_EMAILS` | Comma-separated list of Google email addresses allowed to sign in |
| `REFRESH_CRON` | Optional. Cron syntax. Default: `0 * * * *` (top of every hour) |

---

## One-time Firebase setup

1. Create project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Authentication** → Sign-in method → enable **Google**
3. **Firestore Database** → Create database → production mode → pick region
4. **Project settings** → Service accounts → "Generate new private key" → save the JSON
5. **Project settings** → General → "Your apps" → register a Web app, copy the config values
6. **Authentication** → Settings → Authorized domains → add your Railway URL (e.g. `*.up.railway.app` and your custom domain if you have one)

### Firestore security rules

Since all reads/writes go through the server (which uses Admin SDK and bypasses rules), the safe default is to **deny all client access**:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

Paste this into Firebase console → Firestore → Rules → Publish.

---

## Deploying to Railway

1. Push this `app/` folder to a new GitHub repo
2. [railway.com](https://railway.com) → New Project → Deploy from GitHub repo
3. Set env vars under the service's **Variables** tab — paste each from your `.env`
4. Railway auto-builds (Nixpacks detects Node, runs `npm install` and `npm start`)
5. Generate a public domain under **Settings** → Networking → Generate Domain
6. Add that domain to Firebase Authentication → Authorized domains
7. Open the domain → sign in with Google → dashboard

### First-time deploy: seed afterwards or before?

You can run `npm run seed` **either locally before deploy** (pointing at production Firebase) or **once after deploy** by SSHing into the Railway shell. Local-before is simpler since you already have the CSV.

```bash
# Local seed against production Firebase
cd app
cp .env.example .env.production
# fill .env.production with prod credentials
node -r dotenv/config backend/seed.js  dotenv_config_path=.env.production
```

---

## Operations

- **Manual refresh:** dashboard → "Refresh from Stripe" button
- **Hourly auto-refresh:** in-process node-cron, no Railway cron service needed
- **Logs:** Railway dashboard → Deployments → tail logs. Look for `[cron]`, `[refresh]`, `[cache]`, `[auth]`
- **Add/remove allowed user:** update `ALLOWED_EMAILS` env var in Railway, redeploy (or restart)
- **Force key rotation:** generate new restricted key in Stripe → update `STRIPE_KEY` in Railway → restart service

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login screen shows "Firebase is not configured" | Check `FIREBASE_API_KEY`/`AUTH_DOMAIN`/`PROJECT_ID`/`APP_ID` env vars are set |
| Login works but `/api/charges` returns 403 | Caller's email isn't in `ALLOWED_EMAILS`. Add it, restart service. |
| `/api/health` returns 500 or `count: 0` | Firestore probably empty. Run `npm run seed`. Or check `FIREBASE_SERVICE_ACCOUNT_JSON` is valid JSON. |
| Refresh fails with Stripe 401 | `STRIPE_KEY` invalid or revoked. Generate a new restricted key and update env. |
| Dashboard loads but is empty | Server cache is empty. Check server logs — if you see `[cache] warmed: 0 charges`, the Firestore collection is empty. Run seed. |
| Cron isn't firing | Check `REFRESH_CRON` syntax. Verify in logs that `[cron] scheduled refreshFromStripe on "0 * * * *"` appears at boot. |

---

## File map

```
app/
├── backend/
│   ├── server.js          # Express app, routes, boot sequence
│   ├── firebase.js        # Admin SDK init
│   ├── auth.js            # Token verify + email allowlist middleware
│   ├── cache.js           # In-memory charge cache
│   ├── stripe-refresh.js  # Incremental Stripe API pull → Firestore
│   ├── cron.js            # node-cron hourly schedule
│   └── seed.js            # One-shot CSV → Firestore bulk load
├── public/
│   ├── login.html         # Google sign-in
│   └── dashboard.html     # The dashboard (calls /api/charges)
├── package.json
├── railway.json
├── .env.example
└── .gitignore
```
