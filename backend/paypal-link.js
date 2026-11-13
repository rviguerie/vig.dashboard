/**
 * PayPal checkout that keeps the ad tag — for the sales pages' own PayPal image link.
 *
 * GET /pay/paypal?ref=<adset id>__<ad id>&back=<sales page URL>
 *   Creates a PayPal subscription to the €39 plan with custom_id = ref, then answers
 *   with { url } (PayPal's approve page). With &go=1 it redirects there instead.
 *   If anything fails it answers with the plain PayPal subscribe link, so a buyer is
 *   never stuck. The sales page script calls this when the PayPal image is clicked.
 *
 * Public on purpose (buyers are not signed in). It can only start a subscription to
 * the plans below, and only sends buyers back to mrvig.com pages.
 */

import { getAccessToken } from './paypal-refresh.js';

const PP_BASE = 'https://api-m.paypal.com';
const DEFAULT_PLAN = 'P-7DC78955SS332610WNH6M4JI';
const ALLOWED_PLANS = new Set([DEFAULT_PLAN]);
const THANK_YOU = 'https://english.mrvig.com/ah-welcome-39';
const OUR_SITE = /(^|\.)mrvig\.com$/i;

const plainLink = (plan) => `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${encodeURIComponent(plan)}`;
const cleanRef = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 127);
const ourUrl = (u, fallback) => {
  try { const x = new URL(u); return x.protocol === 'https:' && OUR_SITE.test(x.host) ? x.toString() : fallback; } catch { return fallback; }
};

export async function paypalCheckoutUrl({ ref, back, plan }) {
  const planId = ALLOWED_PLANS.has(plan) ? plan : DEFAULT_PLAN;
  const tag = cleanRef(ref);
  if (!tag || !process.env.PAYPAL_CLIENT_ID) return { url: plainLink(planId), tagged: false };
  const token = await getAccessToken();
  const res = await fetch(`${PP_BASE}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: tag,
      application_context: {
        brand_name: 'Mr. Vig',
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: THANK_YOU,
        cancel_url: ourUrl(back, 'https://english.mrvig.com/amazing'),
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  const approve = (body.links || []).find((l) => l.rel === 'approve')?.href;
  if (!res.ok || !approve) throw new Error(`PayPal ${res.status}: ${body.message || body.name || 'no approve link'}`);
  return { url: approve, tagged: true };
}

/** Express handler. */
export async function paypalLinkHandler(req, res) {
  const origin = req.get('origin') || '';
  try { if (OUR_SITE.test(new URL(origin).host)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); } } catch {}
  res.set('Cache-Control', 'no-store');
  const plan = String(req.query.plan || DEFAULT_PLAN);
  let out;
  try {
    out = await paypalCheckoutUrl({ ref: req.query.ref, back: req.query.back, plan });
  } catch (err) {
    console.error('[paypal-link] failed, sending plain PayPal link:', err.message);
    out = { url: plainLink(ALLOWED_PLANS.has(plan) ? plan : DEFAULT_PLAN), tagged: false };
  }
  if (req.query.go === '1') return res.redirect(302, out.url);
  res.json(out);
}
