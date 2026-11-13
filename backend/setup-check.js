/**
 * Setup check — makes sure every active Meta ad can be tracked on /ads.
 *
 * Runs hourly (cron) and on demand. For every ACTIVE ad in the ad account:
 *   1. The ad's link must carry the ad tag: utm_term (ad set id) and
 *      utm_content (ad id), in the creative's URL parameters or the link itself.
 *   2. Every sales page those ads send people to (mrvig.com pages) is fetched:
 *        - a page with a Stripe link (buy.stripe.com) must have the Stripe
 *          ad-tag script (sets client_reference_id)
 *        - a page with the PayPal subscribe link must have the PayPal button
 *          script (saves the ad tag in custom_id)
 *
 * Result: { checkedAt, problems: [{ level: 'red'|'yellow', what, where }], ads, pages }.
 * 'red' = sales from this ad or page will be missing from /ads. 'yellow' = could not check.
 */

import { metaAll, AD_ACCOUNT } from './ads.js';

const STRIPE_TAG = 'client_reference_id';   // in the Stripe ad-tag script
const PAYPAL_TAG = 'mvPayPalStarted';       // in the PayPal button script
const STRIPE_LINK = 'buy.stripe.com';
const PAYPAL_LINK = 'paypal.com/webapps/billing/plans/subscribe';
const CHECKED_HOSTS = /(^|\.)mrvig\.com$/i; // only our own pages are fetched

let last = null;
let running = null;

const hasTag = (s) => /(^|[?&])utm_term=/.test(s || '') && /(^|[?&])utm_content=/.test(s || '');

/** Every link URL and URL-parameter string found in an ad creative. */
function creativeLinks(cr) {
  const links = [];
  const tags = [];
  if (!cr) return { links, tags };
  if (cr.url_tags) tags.push(cr.url_tags);
  const oss = cr.object_story_spec || {};
  const push = (u) => { if (typeof u === 'string' && /^https?:/i.test(u)) links.push(u); };
  push(oss.link_data?.link);
  push(oss.link_data?.call_to_action?.value?.link);
  push(oss.video_data?.call_to_action?.value?.link);
  push(oss.template_data?.link);
  push(oss.photo_data?.url);
  for (const c of oss.link_data?.child_attachments || []) push(c.link);
  for (const l of cr.asset_feed_spec?.link_urls || []) {
    push(l.website_url);
    if (l.url_tags) tags.push(l.url_tags);
  }
  push(cr.link_url);
  return { links: [...new Set(links)], tags };
}

const pageKey = (u) => {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}`.replace(/\/$/, ''); } catch { return ''; }
};

async function checkPage(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'MrVigDashboardSetupCheck/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return {
    stripeLink: html.includes(STRIPE_LINK),
    stripeTag: html.includes(STRIPE_TAG),
    paypalLink: html.includes(PAYPAL_LINK),
    paypalTag: html.includes(PAYPAL_TAG),
  };
}

async function run() {
  const problems = [];
  if (!process.env.META_ACCESS_TOKEN) {
    return { checkedAt: new Date().toISOString(), problems: [{ level: 'yellow', what: 'META_ACCESS_TOKEN is not set, so ads could not be checked.', where: '' }], ads: [], pages: [] };
  }
  const rows = await metaAll(`${AD_ACCOUNT}/ads`, {
    fields: 'name,effective_status,adset{id,name},campaign{name},creative{url_tags,object_story_spec,asset_feed_spec,link_url}',
    effective_status: JSON.stringify(['ACTIVE']),
    limit: '200',
  });

  const pages = new Map(); // page key → { url, ads: [] }
  const ads = rows.map((a) => {
    const { links, tags } = creativeLinks(a.creative);
    const label = `${a.campaign?.name || '?'} › ${a.adset?.name || '?'} › ${a.name}`;
    const tagged = tags.some(hasTag) || (links.length > 0 && links.every((l) => hasTag(l.split('?')[1] || '')));
    if (!links.length && !tags.length) {
      problems.push({ level: 'yellow', what: 'Could not read this ad\'s link, so its ad tag was not checked.', where: label });
    } else if (!tagged) {
      problems.push({ level: 'red', what: 'Ad link has no ad tag (utm_term={{adset.id}} and utm_content={{ad.id}} in URL parameters). Its sales will not be matched to this ad set.', where: label });
    }
    for (const l of links) {
      const k = pageKey(l);
      if (!k) continue;
      if (!pages.has(k)) pages.set(k, { url: k, ads: [] });
      pages.get(k).ads.push(label);
    }
    return { label, links, tagged };
  });

  const pageResults = [];
  for (const p of pages.values()) {
    let host = '';
    try { host = new URL(p.url).host; } catch {}
    if (!CHECKED_HOSTS.test(host)) {
      pageResults.push({ ...p, skipped: true });
      continue;
    }
    try {
      const r = await checkPage(p.url);
      pageResults.push({ ...p, ...r });
      const used = `${p.url} (used by ${p.ads.length} active ad${p.ads.length === 1 ? '' : 's'})`;
      if (r.stripeLink && !r.stripeTag) problems.push({ level: 'red', what: 'Sales page has a Stripe link but no Stripe ad-tag script. Its card sales will be missing from the ad results.', where: used });
      if (r.paypalLink && !r.paypalTag) problems.push({ level: 'red', what: 'Sales page has the old PayPal link but no PayPal button script. Its PayPal sales cannot be matched to an ad set.', where: used });
    } catch (err) {
      pageResults.push({ ...p, error: err.message });
      problems.push({ level: 'yellow', what: `Could not open this sales page (${err.message}).`, where: p.url });
    }
  }
  const result = { checkedAt: new Date().toISOString(), problems, ads, pages: pageResults };
  console.log(`[setup-check] ${ads.length} active ads, ${pageResults.length} pages, ${problems.length} problems`);
  return result;
}

/** Run the check now (one at a time) and keep the result. */
export async function runSetupCheck() {
  if (running) return running;
  running = run()
    .then((r) => { last = r; return r; })
    .catch((err) => {
      console.error('[setup-check] failed:', err);
      last = { checkedAt: new Date().toISOString(), problems: [{ level: 'yellow', what: 'Setup check failed: ' + err.message, where: '' }], ads: [], pages: [] };
      return last;
    })
    .finally(() => { running = null; });
  return running;
}

/** Last result; runs the check first if there is none yet. */
export async function getSetupCheck() {
  return last || runSetupCheck();
}
