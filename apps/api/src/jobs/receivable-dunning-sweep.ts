import { Worker, type Job } from 'bullmq';
import { creditReceivablesRepository, type DailyDunningDueWallet } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  DUNNING_CADENCE_HOURS,
  publishHoldDunningNotice,
  type HoldDunningOutcome,
} from '../services/credit-session/notify.js';

/**
 * BAL-378 (ADR-1040 Lane 2 / §14 Q1) → BAL-474 (ADR-1040 Amendment 7 §G, D6.2, D7.1) — the daily
 * dunning sweep. Re-notifies each WALLET that is still on hold with ONE notice stating the top-up that
 * clears the hold — neutral about how many consultations ran over, stating the total needed (owner
 * ruling D6.2) — no money moves. Per-row try/catch so one bad wallet never aborts the batch
 * (dormancy-sweep precedent). A hold is released by a covering credit, so a wallet drops out of this
 * sweep once it is cleared.
 *
 * ⚠⚠ WALLET GRAIN, NOT RECEIVABLE GRAIN. This used to re-publish one notice per open receivable, each
 * quoting that receivable's own stale `amount_minor` — false the moment a second debt, a partial top-up
 * or a promo landed. It now lists WALLETS due (`listWalletsDueForDailyDunning`) and hands each to
 * `publishHoldDunningNotice`, which CLAIMS the notice under the wallet advisory lock (the figure read
 * and the daily stamp in one transaction) and publishes post-commit. A covered-but-held wallet is
 * HEALED there, never dunned for A$0.00. It no longer calls `publishSettlementFailure`, so the
 * per-session `SESSION_SETTLED{fail}` and `RECEIVABLE_OPENED` analytics are not re-fired every day.
 *
 * The due set is least-recently-reminded first (never-reminded wallets lead), so a batch that FILLS can
 * never keep starving the same tail: each day's leftovers lead the next day's batch. ⚠ The daily stamp
 * is written ONLY by this arm — a `receivable_opened` notice is never throttled and never stamps, so an
 * off-cycle notice never pushes this sweep's due set back.
 */
export const RECEIVABLE_DUNNING_SWEEP_QUEUE = 'receivable-dunning-sweep';
export const RECEIVABLE_DUNNING_SWEEP_CRON = '0 9 * * *'; // daily 09:00 UTC

const MS_PER_HOUR = 60 * 60 * 1000;
/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below. */
const DUNNING_BATCH_LIMIT = 100;

const logger = createLogger('receivable-dunning-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remind one wallet. Throws on failure so the caller's try/catch isolates it. */
async function dunOne(wallet: DailyDunningDueWallet, now: Date): Promise<HoldDunningOutcome> {
  return publishHoldDunningNotice({
    walletId: wallet.walletId,
    companyId: wallet.companyId,
    trigger: 'daily_reminder',
    // Per WRITE: one daily notice per wallet per sweep instant. `buildJobId` escapes the colon.
    correlationKey: `${wallet.walletId}:${String(now.getTime())}`,
    now,
  });
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). `dunned` counts only the
 * dunning notices actually PUBLISHED; a wallet whose balance already covered its debt is `healed`
 * (an account-clear notice, not a reminder), and a wallet another sweep already reminded, or one no
 * longer on hold, counts as neither.
 */
export async function runReceivableDunningSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ dunned: number; healed: number }> {
  const notRemindedSince = new Date(now.getTime() - DUNNING_CADENCE_HOURS * MS_PER_HOUR);
  const wallets = await creditReceivablesRepository.listWalletsDueForDailyDunning(
    notRemindedSince,
    DUNNING_BATCH_LIMIT
  );
  if (wallets.length === DUNNING_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means due wallets were DROPPED from this tick. The ordering
    // (least recently reminded first) makes tomorrow's batch lead with them.
    logger.warn(
      { limit: DUNNING_BATCH_LIMIT },
      'Dunning batch FILLED — due wallets were left for the next sweep'
    );
  }
  let dunned = 0;
  let healed = 0;
  for (const wallet of wallets) {
    try {
      const outcome = await dunOne(wallet, now);
      if (outcome === 'published') {
        dunned += 1;
      } else if (outcome === 'healed') {
        healed += 1;
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`dunning failed for wallet ${wallet.walletId}: ${message}`);
      logger.error(
        {
          walletId: wallet.walletId,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Wallet dunning failed'
      );
    }
  }
  logger.info({ dunned, healed }, 'Receivable dunning sweep complete');
  return { dunned, healed };
}

/** Start the receivable dunning sweep worker. */
export function startReceivableDunningSweepWorker(): Worker {
  return new Worker(
    RECEIVABLE_DUNNING_SWEEP_QUEUE,
    async (job: Job) => {
      const { dunned, healed } = await runReceivableDunningSweep(new Date(), (m) => job.log(m));
      job.log(`receivable dunning sweep: ${dunned} re-notified, ${healed} healed`);
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
