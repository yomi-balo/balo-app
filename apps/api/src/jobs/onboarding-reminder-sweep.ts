import { Worker, type Job } from 'bullmq';
import { usersRepository } from '@balo/db';
import { classifyEmailDomain } from '@balo/shared/domains';
import { trackServer, ONBOARDING_REMINDER_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';

/**
 * BAL-374 — the onboarding-completion reminder sweep: a single repeatable BullMQ job
 * that, each tick, finds un-onboarded, non-deleted users whose `created_at` crossed one
 * of three cadence steps (~+24h / +72h / +7d after signup) in the last cron period and
 * publishes ONE `onboarding.reminder` domain event (email, recipient 'self'). Modelled
 * on the D7 `auto-accept-sweep` — a repeatable sweep, not per-signup delayed jobs. Once
 * `onboarding_completed` flips true the user drops out of the query, so the sweep
 * self-cancels with zero leak risk and needs NO cancellation code.
 *
 * IDEMPOTENCY: no schema state. The reminder rides the notification engine's
 * correlationId (`${userId}:onboarding_reminder:${step}`) — a repeated publish for the
 * same (user, step) collapses to one delivery via the BullMQ jobId. The window design
 * (each band exactly ONE cron period wide) makes each (user, step) eligible on ~1 tick,
 * so `_sent` fires once per step (clean funnel) and the correlationId is belt-and-braces.
 *
 * HARD STOP + NO BACKFILL both fall out of the window math (nothing older than step-3's
 * ceiling ever matches) — there is no separate `created_at` floor. This is a CONVERSION
 * mechanism, not a safety one: a full-hour outage at a user's exact crossing hour simply
 * skips that one nudge (acceptable per the ticket).
 */
export const ONBOARDING_REMINDER_SWEEP_QUEUE = 'onboarding-reminder-sweep';
export const ONBOARDING_REMINDER_SWEEP_CRON = '0 * * * *'; // hourly (matches auto-accept)

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Each window is exactly ONE cron period wide, so a user's `created_at` lands in a given
 * step's `(after, until]` band on EXACTLY ONE hourly tick → `_sent` fires once per step
 * (clean funnel). The correlationId is the belt-and-suspenders that also dedups the
 * EMAIL if clock jitter ever double-matches. Widen `WINDOW_MS` to trade `_sent`
 * over-count for outage tolerance (this is NOT a safety mechanism — an hour of downtime
 * at a user's crossing hour simply skips that one nudge).
 */
const WINDOW_MS = HOUR_MS;

/** The three cadence steps: age of `created_at` at which each nudge fires. */
export const ONBOARDING_REMINDER_STEPS = [
  { step: 1 as const, ageMs: 24 * HOUR_MS },
  { step: 2 as const, ageMs: 72 * HOUR_MS },
  { step: 3 as const, ageMs: 7 * DAY_MS },
] as const;

// Note: unlike the D7 auto-accept sweep (whose auto path has no acting user and so
// tags a stable `system:*` distinct-id), the per-user `_sent` here uses the user's OWN
// id — the reminder always has a known subject — so no system distinct-id is needed.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish the reminder for one (user, step) and emit the `_sent` analytics. Isolated in
 * the caller's try/catch — one bad row never aborts the batch. `domainClass` is
 * recomputed from the durable email (pure `classifyEmailDomain`, no PII persisted).
 */
async function remindOne(user: { id: string; email: string }, step: 1 | 2 | 3): Promise<void> {
  const domainClass = classifyEmailDomain(user.email);

  await notificationEvents.publish('onboarding.reminder', {
    correlationId: `${user.id}:onboarding_reminder:${step}`,
    userId: user.id, // → recipient 'self' + resolver hydrates data.user
    cadenceStep: step, // → template builds the ?step=N CTA
  });

  trackServer(ONBOARDING_REMINDER_SERVER_EVENTS.SENT, {
    cadence_step: step,
    domain_class: domainClass,
    distinct_id: user.id, // the user is the reminder subject (we know who)
  });
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). For each
 * cadence step, resolves the half-open `(after, until]` window and publishes ONE
 * reminder per matching un-onboarded user. Each row is isolated in its own try/catch —
 * one bad row never aborts the batch. Returns the count of successful publishes.
 */
export async function runOnboardingReminderSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ sent: number }> {
  let sent = 0;
  for (const { step, ageMs } of ONBOARDING_REMINDER_STEPS) {
    const until = new Date(now.getTime() - ageMs); // created_at <= until  (age >= ageMs)
    const after = new Date(now.getTime() - ageMs - WINDOW_MS); // created_at > after (age < ageMs+window)
    const users = await usersRepository.findIncompleteOnboardingCreatedBetween(after, until);
    for (const user of users) {
      try {
        await remindOne(user, step);
        sent += 1;
      } catch (error) {
        log(`onboarding reminder step ${step} failed for user ${user.id}: ${errorMessage(error)}`);
      }
    }
  }
  return { sent };
}

/** Start the onboarding-reminder sweep worker. */
export function startOnboardingReminderSweepWorker(): Worker {
  return new Worker(
    ONBOARDING_REMINDER_SWEEP_QUEUE,
    async (job: Job) => {
      const { sent } = await runOnboardingReminderSweep(new Date(), (m) => job.log(m));
      job.log(`onboarding reminder sweep: ${sent} reminders published`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable onboarding-reminder sweep (hourly). */
export async function registerOnboardingReminderSweepCron(): Promise<void> {
  const queue = getQueue(ONBOARDING_REMINDER_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: ONBOARDING_REMINDER_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
