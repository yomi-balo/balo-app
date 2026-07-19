import { Worker, type Job } from 'bullmq';
import { creditReceivablesRepository, type CreditReceivable } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { publishSettlementFailure } from '../services/credit-session/notify.js';

/**
 * BAL-378 (ADR-1040 Lane 2 / §14 Q1) — the daily receivable dunning sweep. Re-notifies the
 * company's billing admins about each OPEN receivable (a failed / SCA-pending settlement) that
 * hasn't been dunned within the cadence window, then stamps `lastDunningAt`. Publishes the same
 * `session.settlement_failed` event (re-notifiable via its attempt-stamped correlationId) — no
 * money moves. Per-row try/catch so one bad receivable never aborts the batch (dormancy-sweep
 * precedent). The receivable is auto-cleared by a later successful settlement webhook (§14 Q2),
 * so it drops out of this sweep once resolved.
 */
export const RECEIVABLE_DUNNING_SWEEP_QUEUE = 'receivable-dunning-sweep';
export const RECEIVABLE_DUNNING_SWEEP_CRON = '0 9 * * *'; // daily 09:00 UTC

const MS_PER_HOUR = 60 * 60 * 1000;
/** Re-dun a receivable at most once per this window (< 24h so the daily 09:00 tick always fires). */
const DUNNING_CADENCE_HOURS = 20;

const logger = createLogger('receivable-dunning-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-notify + stamp one receivable. Throws on failure so the caller's try/catch isolates it. */
async function dunOne(receivable: CreditReceivable, now: Date): Promise<void> {
  await publishSettlementFailure({
    session: {
      id: receivable.sessionId,
      companyId: receivable.companyId,
      walletId: receivable.walletId,
    },
    reason: receivable.reason === 'settlement_requires_action' ? 'requires_action' : 'declined',
    amountMinor: receivable.amountMinor,
    attemptEpochMs: now.getTime(),
  });
  await creditReceivablesRepository.markDunned(receivable.id, now);
}

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runReceivableDunningSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ dunned: number }> {
  const notDunnedSince = new Date(now.getTime() - DUNNING_CADENCE_HOURS * MS_PER_HOUR);
  const receivables = await creditReceivablesRepository.listOpenForDunning(notDunnedSince);
  let dunned = 0;
  for (const receivable of receivables) {
    try {
      await dunOne(receivable, now);
      dunned += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`dunning failed for receivable ${receivable.id}: ${message}`);
      logger.error({ receivableId: receivable.id, error: message }, 'Receivable dunning failed');
    }
  }
  logger.info({ dunned }, 'Receivable dunning sweep complete');
  return { dunned };
}

/** Start the receivable dunning sweep worker. */
export function startReceivableDunningSweepWorker(): Worker {
  return new Worker(
    RECEIVABLE_DUNNING_SWEEP_QUEUE,
    async (job: Job) => {
      const { dunned } = await runReceivableDunningSweep(new Date(), (m) => job.log(m));
      job.log(`receivable dunning sweep: ${dunned} re-notified`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable daily receivable dunning sweep (09:00 UTC). */
export async function registerReceivableDunningSweepCron(): Promise<void> {
  const queue = getQueue(RECEIVABLE_DUNNING_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: RECEIVABLE_DUNNING_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
