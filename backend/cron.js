/**
 * In-process hourly Stripe refresh.
 *
 * Uses node-cron so we don't need a separate Railway cron service.
 * The schedule is configurable via REFRESH_CRON env var.
 */

import cron from 'node-cron';
import { refreshFromStripe } from './stripe-refresh.js';
import { refreshPayPal } from './paypal-refresh.js';
import { syncMembers } from './members.js';

const DEFAULT_SCHEDULE = '0 * * * *'; // top of every hour

export function startCron() {
  const schedule = process.env.REFRESH_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[cron] invalid REFRESH_CRON "${schedule}", falling back to default`);
  }
  const expr = cron.validate(schedule) ? schedule : DEFAULT_SCHEDULE;

  cron.schedule(expr, async () => {
    // Run both sources; isolate failures so one source can't block the other.
    try {
      await refreshFromStripe();
    } catch (err) {
      console.error('[cron] Stripe refresh failed:', err);
    }
    if (process.env.PAYPAL_CLIENT_ID) {
      try {
        await refreshPayPal();
      } catch (err) {
        console.error('[cron] PayPal refresh failed:', err);
      }
    }
    try {
      await syncMembers();
    } catch (err) {
      console.error('[cron] member sync failed:', err);
    }
  });

  console.log(`[cron] scheduled Stripe + PayPal refresh on "${expr}"`);
}
