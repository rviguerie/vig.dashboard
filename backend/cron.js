/**
 * In-process hourly Stripe refresh.
 *
 * Uses node-cron so we don't need a separate Railway cron service.
 * The schedule is configurable via REFRESH_CRON env var.
 */

import cron from 'node-cron';
import { refreshFromStripe } from './stripe-refresh.js';

const DEFAULT_SCHEDULE = '0 * * * *'; // top of every hour

export function startCron() {
  const schedule = process.env.REFRESH_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[cron] invalid REFRESH_CRON "${schedule}", falling back to default`);
  }
  const expr = cron.validate(schedule) ? schedule : DEFAULT_SCHEDULE;

  cron.schedule(expr, async () => {
    try {
      await refreshFromStripe();
    } catch (err) {
      console.error('[cron] refresh failed:', err);
    }
  });

  console.log(`[cron] scheduled refreshFromStripe on "${expr}"`);
}
