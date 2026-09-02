import { Worker, type Job } from 'bullmq';
import { creditWalletsRepository, type CreditWallet } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { TOPUP_RECONCILE_AFTER_MS } from '@balo/shared/pricing';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  reconcileStuckAutoTopup,
  type AutoTopupReconcileOutcome,
} from '../services/credit/auto-topup-reconcile.js';

/**
 * BAL-515 — the per-minute auto-top-up reconcile sweep. Finds wallets whose in-flight reload
 * marker has stood past `TOPUP_RECONCILE_AFTER_MS` and hands each to `reconcileStuckAutoTopup`,
 * which repairs a charged-but-uncredited crossing through the ordinary crediting pipeline.
 *
 * ⚠ WHY A SEPARATE MODULE RATHER THAN AN EIGHTH PASS ON `credit-session-meter-sweep.ts`:
 *  1. GRAIN. Every pass of that sweep is driven by a `creditSessionsRepository` finder and its
 *     own header calls it "the per-minute credit-session reaper". This finder is
 *     `creditWalletsRepository` and there is no session. Widening that file makes its stated
 *     contract false.
 *  2. BLAST RADIUS ON THE METERING PATH. This pass makes a `paymentIntents.retrieve` (and
 *     occasionally a `paymentIntents.list`) PER CANDIDATE ROW. Putting seconds of Stripe latency
 *     in front of the per-minute drawdown meter is a money-path regression for a repair that is
 *     not urgent to the second.
 *  3. PASS 7's ORDERING CONTRACT. `runSettledMissingCreditPass` has no per-row try/catch and is
 *     documented as safe only BECAUSE it runs last. Any insertion re-opens that argument.
 *  4. FAILURE ISOLATION. A throw from this finder fails only its own BullMQ job, and the cadence
 *     is an independent knob.
 *
 * ⚠ PER-MINUTE IS NOT A FREE KNOB. `TOPUP_RECONCILE_AFTER_MS` (5 min) leaves a 10-minute retry
 * budget before `TOPUP_IN_FLIGHT_TTL_MS` (15 min) lets a later crossing RE-ARM the marker — which
 * overwrites `pending_topup_triggering_entry_id` and nulls `pending_topup_payment_intent_id`, i.e.
 * erases the evidence this sweep repairs from. A slower cadence spends that budget. The daily
 * `wallet-dormancy-sweep` cadence would be ~96× too slow; it is disqualified on arithmetic.
 */
export const AUTO_TOPUP_RECONCILE_SWEEP_QUEUE = 'auto-topup-reconcile-sweep';
export const AUTO_TOPUP_RECONCILE_SWEEP_CRON = '* * * * *'; // every minute

/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below. */
const AUTO_TOPUP_RECONCILE_BATCH_LIMIT = 100;

const logger = createLogger('auto-topup-reconcile-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tallies one tick reports (and the sweep's unit-test surface). */
export interface AutoTopupReconcileSweepResult {
  /** Credits applied here because the webhook never landed. The RATE is the health signal. */
  repaired: number;
  /** PI succeeded and the ledger row existed — only a stale marker was cleared. */
  alreadyCredited: number;
  /** PI succeeded then the charge was REFUNDED — marker cleared, deliberately NOT credited. */
  refunded: number;
  /** PI canceled / hard-declined — marker cleared, failed notice published. */
  failedClosed: number;
  /** Markers drained because no charge was ever created. */
  drained: number;
  /** Unresolvable PaymentIntents — nothing was written; each needs a human. */
  alarms: number;
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker).
 *
 * Per-row `try/catch`: one wallet's Stripe or DB fault must never abort the batch, and the row is
 * simply retried on the next tick (nothing is cleared ahead of the money, by construction in
 * `reconcileStuckAutoTopup`).
 */
export async function runAutoTopupReconcileSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<AutoTopupReconcileSweepResult> {
  const cutoff = new Date(now.getTime() - TOPUP_RECONCILE_AFTER_MS);
  const wallets = await creditWalletsRepository.findStuckPendingTopups(
    cutoff,
    AUTO_TOPUP_RECONCILE_BATCH_LIMIT
  );
  if (wallets.length === AUTO_TOPUP_RECONCILE_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means stuck reloads were DROPPED from this tick, and the
    // counts below would read as the whole of the backlog.
    const [oldest] = wallets;
    logger.warn(
      { limit: AUTO_TOPUP_RECONCILE_BATCH_LIMIT, oldestWalletId: oldest?.id },
      'Auto-top-up reconcile batch FILLED — further stuck reloads were dropped from this tick'
    );
  }

  const result: AutoTopupReconcileSweepResult = {
    repaired: 0,
    alreadyCredited: 0,
    refunded: 0,
    failedClosed: 0,
    drained: 0,
    alarms: 0,
  };
  const alarmed: CreditWallet[] = [];

  for (const wallet of wallets) {
    let outcome: AutoTopupReconcileOutcome;
    try {
      outcome = await reconcileStuckAutoTopup(wallet, { now });
    } catch (error) {
      const message = errorMessage(error);
      log(`auto-top-up reconcile failed for wallet ${wallet.id}: ${message}`);
      logger.error({ walletId: wallet.id, error: message }, 'Auto-top-up reconcile failed');
      continue;
    }
    switch (outcome.outcome) {
      case 'repaired':
        result.repaired += 1;
        break;
      case 'already_credited':
        result.alreadyCredited += 1;
        break;
      case 'refunded':
        result.refunded += 1;
        break;
      case 'failed_closed':
        result.failedClosed += 1;
        break;
      case 'alarm':
        result.alarms += 1;
        alarmed.push(wallet);
        break;
      case 'skipped':
        if (outcome.reason === 'no_charge_found') result.drained += 1;
        break;
      default:
        // `deferred` — genuinely still in flight or momentarily unreadable. Not a tally.
        break;
    }
  }

  if (alarmed.length > 0) {
    // ONE error per TICK, not per row. This sweep runs every minute forever, and each alarmed row
    // needs a HUMAN — per-row errors would turn one stuck wallet into 1,440 identical records a
    // day (Pino → Axiom) while adding nothing a responder can act on. That is the lesson pass 7
    // of the meter sweep records; the per-wallet identifiers all ride in this record's array.
    log(`auto-top-up markers with an unresolvable PaymentIntent: ${alarmed.length} wallet(s)`);
    logger.error(
      {
        count: alarmed.length,
        wallets: alarmed.map((wallet) => ({
          walletId: wallet.id,
          companyId: wallet.companyId,
          pendingTopupAt: wallet.pendingTopupAt,
          triggeringEntryId: wallet.pendingTopupTriggeringEntryId,
          mandateStatus: wallet.mandateStatus,
        })),
      },
      // ⚠ THE COPY MUST NOT INVENT A DEADLINE. It used to say "before the 15-minute TTL lets a
      // later crossing re-arm the marker". A re-arm needs a LATER CROSSING, and a wallet whose
      // auto-top-up is stuck has stopped reloading — a dormant company may never cross again. For
      // those rows there is no deadline at all and no self-healing: the wallet alarms every minute
      // until a human resolves it. Only an ACTIVE wallet faces the re-arm race.
      'Auto-top-up in-flight markers whose PaymentIntent could not be resolved — nothing was written and nothing will self-heal; resolve each crossing in the Stripe Dashboard. These rows alarm every minute until then, and on a wallet that keeps spending a later crossing can re-arm the marker after TOPUP_IN_FLIGHT_TTL_MS (15 min) and overwrite this evidence'
    );
  }

  logger.info({ ...result, candidates: wallets.length }, 'Auto-top-up reconcile sweep complete');
  return result;
}

/** Start the auto-top-up reconcile worker (concurrency 1 — one serialised pass per tick). */
export function startAutoTopupReconcileSweepWorker(): Worker {
  return new Worker(
    AUTO_TOPUP_RECONCILE_SWEEP_QUEUE,
    async (job: Job) => {
      const { repaired, alreadyCredited, refunded, failedClosed, drained, alarms } =
        await runAutoTopupReconcileSweep(new Date(), (m) => job.log(m));
      job.log(
        `auto-top-up reconcile: ${repaired} repaired, ${alreadyCredited} already-credited, ${refunded} refunded, ${failedClosed} failed-closed, ${drained} drained, ${alarms} alarms`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable per-minute auto-top-up reconcile sweep. */
export async function registerAutoTopupReconcileSweepCron(): Promise<void> {
  const queue = getQueue(AUTO_TOPUP_RECONCILE_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: AUTO_TOPUP_RECONCILE_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
