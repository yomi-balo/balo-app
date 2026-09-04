import { Worker, type Job } from 'bullmq';
import { creditWalletsRepository, type CreditWallet } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { TOPUP_RECONCILE_AFTER_MS } from '@balo/shared/pricing';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  reconcileStuckAutoTopup,
  type AutoTopupReconcileAlarmReason,
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

/**
 * ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below.
 *
 * ⚠ BAL-521 (AMEND-6) — WHAT A FULL BATCH MEANS CHANGED. Pre-BAL-521 a full batch meant stuck
 * reloads were DROPPED from this tick outright. Under the §2 rotation, a never-alarmed row ALWAYS
 * leads the batch, so a filled batch no longer implies a fresh row was dropped — it means the
 * backlog (never-alarmed + alarmed) is at least this limit. Still a no-silent-caps signal; the
 * warning below is rewritten to say so rather than to claim rows were dropped.
 */
const AUTO_TOPUP_RECONCILE_BATCH_LIMIT = 100;

const logger = createLogger('auto-topup-reconcile-sweep');

/**
 * The batched escalation copy, one entry per alarm reason. ⚠ BAL-521 (D1) — "writes nothing" is
 * QUALIFIED here, not overturned: both reasons write no money and clear no marker — every piece
 * of crossing evidence stays intact — and now ALSO stamp an observability/fairness column
 * (`pending_topup_alarmed_at`, via `stampAlarmedRows` below) that affects only batch ORDER, never
 * the crossing itself. Every row here therefore still re-presents on a LATER tick with all of its
 * evidence intact — the copy must say what a responder should DO, and must not invent a deadline.
 *
 * ⚠ THE COPY MUST NOT INVENT A DEADLINE. `payment_intent_unresolvable` used to say "before the
 * 15-minute TTL lets a later crossing re-arm the marker". A re-arm needs a LATER CROSSING, and a
 * wallet whose auto-top-up is stuck has stopped reloading — a dormant company may never cross
 * again. For those rows there is no deadline at all and no self-healing.
 *
 * ⚠ BAL-521 (AMEND-4) — "alarm every minute until then" is now FALSE and has been rewritten.
 * `findStuckPendingTopups` now rotates: never-alarmed rows lead, alarmed rows follow
 * least-recently-alarmed first (BAL-521 §2, D2). An alarmed row alarms on its ROTATION TURN, not
 * necessarily every tick — a large enough alarmed backlog spreads across consecutive ticks. Each
 * message below appends the DEC-5 slice sentence so a responder can size the backlog beyond what
 * this tick reached.
 */
const ALARM_ESCALATION: Record<
  AutoTopupReconcileAlarmReason,
  { summary: string; message: string }
> = {
  payment_intent_unresolvable: {
    summary: 'auto-top-up markers with an unresolvable PaymentIntent',
    message:
      'Auto-top-up in-flight markers whose PaymentIntent could not be resolved — nothing was written and nothing will self-heal; resolve each crossing in the Stripe Dashboard. These rows alarm on their rotation turn, and on a wallet that keeps spending a later crossing can re-arm the marker after TOPUP_IN_FLIGHT_TTL_MS (15 min) and overwrite this evidence. This record lists only the wallets this tick reached — alarmed rows are de-prioritised behind never-alarmed ones and rotate least-recently-alarmed first, so a backlog larger than the batch is reported across consecutive ticks: `alarmedBacklogTotal` is the whole backlog, `reportedThisTick` is this slice',
  },
  partial_refund: {
    summary: 'auto-top-up charges PARTIALLY refunded with no ledger credit',
    message:
      'Auto-top-up charges that succeeded, were PARTIALLY refunded, and have no ledger credit — nothing was written and nothing was cleared, because the un-refunded remainder is credit the company is genuinely owed and this pass may not invent a ledger amount that no Stripe balance transaction backs. Resolve each in the Stripe Dashboard: either complete the refund (the next tick then closes the crossing) or credit the remainder by hand. This record lists only the wallets this tick reached — alarmed rows are de-prioritised behind never-alarmed ones and rotate least-recently-alarmed first, so a backlog larger than the batch is reported across consecutive ticks: `alarmedBacklogTotal` is the whole backlog, `reportedThisTick` is this slice',
  },
};

/** Stable emission order — Sonar-safe iteration over the record above without `Object.entries`. */
const ALARM_ESCALATION_ORDER: readonly AutoTopupReconcileAlarmReason[] = [
  'payment_intent_unresolvable',
  'partial_refund',
];

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
  /**
   * BAL-521 (AMEND-5) — every alarm row THIS TICK REACHED (both reasons); nothing was written for
   * any of them and each needs a human. NOT the whole alarmed backlog — see `alarmedBacklogTotal`,
   * which is: under the §2 rotation, alarmed rows are de-prioritised and rotate, so one tick only
   * ever reaches a SLICE of the backlog.
   */
  alarms: number;
  /**
   * The subset of `alarms` (this tick's slice) that are PARTIAL refunds — a succeeded charge,
   * part of it back with the customer, no ledger credit, and a remainder the company is still
   * owed. Counted separately because it is a different job for the responder than an
   * unidentifiable PaymentIntent, and because it is the arm that used to silently write off the
   * remainder.
   */
  partialRefundAlarms: number;
  /**
   * BAL-521 §1 — `processing` PaymentIntents past `TOPUP_RECONCILE_ESCALATE_AFTER_MS`. NOT a
   * money tally and NOT an alarm: nothing was written, nothing was cleared, and the charge can
   * still settle. Reported ONCE per tick, and deliberately NEVER stamped as alarmed (D6) —
   * de-prioritising a live crossing would strand real money.
   */
  escalatedStillInFlight: number;
  /**
   * BAL-521 §2 (DEC-5) — the WHOLE alarmed backlog past the cutoff (BOTH reasons), measured
   * AFTER this tick's stamps land. ⚠ NOT derivable from `alarms`: alarmed rows are de-prioritised
   * and rotate, so one tick only ever reaches a slice of the backlog. Without this figure a
   * filled batch of 100 is indistinguishable from a backlog of 10,000 — the no-silent-caps rule.
   */
  alarmedBacklogTotal: number;
}

/**
 * Steps 5/6 of the tick share one shape: a `job.log` summary line plus exactly ONE `logger.error`
 * carrying every row this tick collected for that reason. Extracted so the alarm-reason loop and
 * the new escalated-set record (BAL-521 §1) cannot drift, and so this HELPER never writes —
 * keeping the stamp (driven only by `alarmed`, never by `escalated`) structurally unable to reach
 * an escalated `still_in_flight` row (D6). (The MODULE as a whole does write — `stampAlarmedRows`
 * below issues the batched UPDATE; it is this function specifically that stays read-only.)
 */
function emitBatchedEscalation(
  fields: Record<string, unknown>,
  message: string,
  log: (m: string) => void,
  summary: string,
  count: number
): void {
  log(`${summary}: ${count} wallet(s)`);
  logger.error(fields, message);
}

/** One row that alarmed this tick — the shape the stamp AND the per-reason emitter both read. */
interface AlarmedRow {
  wallet: CreditWallet;
  reason: AutoTopupReconcileAlarmReason;
}

/** One row that escalated (§1) this tick — never stamped (D6), only ever reported. */
interface EscalatedRow {
  wallet: CreditWallet;
  paymentIntentId: string;
  piStatus: string;
  stuckForMs: number;
}

/**
 * Reconcile one candidate and fold its outcome into the tallies / collection arrays. Extracted
 * from the tick loop (cognitive-complexity gate) — this is the ENTIRE outcome switch, so the
 * loop itself stays a single `try/catch` + one call.
 */
async function reconcileAndTally(
  wallet: CreditWallet,
  now: Date,
  result: AutoTopupReconcileSweepResult,
  alarmed: AlarmedRow[],
  escalated: EscalatedRow[],
  log: (message: string) => void
): Promise<void> {
  let outcome: AutoTopupReconcileOutcome;
  try {
    outcome = await reconcileStuckAutoTopup(wallet, { now });
  } catch (error) {
    const message = errorMessage(error);
    log(`auto-top-up reconcile failed for wallet ${wallet.id}: ${message}`);
    logger.error({ walletId: wallet.id, error: message }, 'Auto-top-up reconcile failed');
    return;
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
      if (outcome.reason === 'partial_refund') result.partialRefundAlarms += 1;
      alarmed.push({ wallet, reason: outcome.reason });
      break;
    case 'skipped':
      if (outcome.reason === 'no_charge_found') result.drained += 1;
      break;
    default:
      // `deferred` — genuinely still in flight or momentarily unreadable. Not a tally.
      // BAL-521 §1: the ESCALATED variant is collected here and reported ONCE per tick below,
      // instead of the service emitting one `log.error` per row per tick.
      if (outcome.reason === 'still_in_flight_escalated') {
        result.escalatedStillInFlight += 1;
        escalated.push({
          wallet,
          paymentIntentId: outcome.paymentIntentId,
          piStatus: outcome.piStatus,
          stuckForMs: outcome.stuckForMs,
        });
      }
      break;
  }
}

/**
 * BAL-521 §2 (D1) — THE STAMP. ONE batched UPDATE for the whole tick, off the `alarmed` array
 * the caller already built — never one per row. ⚠ NEVER stamps an escalated `still_in_flight`
 * row (D6): that row is `deferred`, not `alarm`, and its PaymentIntent can still settle — it is
 * never pushed onto `alarmed` in the first place, so this function is structurally unable to
 * reach it (`alarmed` is its only input).
 */
async function stampAlarmedRows(alarmed: readonly AlarmedRow[], now: Date): Promise<void> {
  if (alarmed.length === 0) return;
  const pairs = alarmed.flatMap(({ wallet }) => {
    const triggeringEntryId = wallet.pendingTopupTriggeringEntryId;
    if (triggeringEntryId === null) {
      // Unreachable in practice — `findStuckPendingTopups`'s WHERE requires this column
      // non-null for every row it returns (BAL-515). Guarded rather than asserted
      // (`noUncheckedIndexedAccess` — never `!`), and warned so a future relaxation of that
      // WHERE is caught HERE, not as a silently-mis-stamped row.
      logger.warn(
        { walletId: wallet.id },
        'Alarmed wallet has no pendingTopupTriggeringEntryId — cannot stamp it (should be unreachable)'
      );
      return [];
    }
    return [{ walletId: wallet.id, triggeringEntryId }];
  });
  const stamped = await creditWalletsRepository.markPendingTopupAlarmed(pairs, now);
  if (stamped !== alarmed.length) {
    logger.warn(
      { alarmed: alarmed.length, stamped },
      'Some alarmed markers moved on between the read and the stamp — not stamped'
    );
  }
}

/**
 * ONE error per alarm REASON per TICK, never per row. This sweep runs every minute forever, and
 * each alarmed row needs a HUMAN — per-row errors would turn one stuck wallet into 1,440
 * identical records a day (Pino → Axiom) while adding nothing a responder can act on. That is
 * the lesson pass 7 of the meter sweep records; the per-wallet identifiers all ride in each
 * record's array.
 */
function emitAlarmRecords(
  alarmed: readonly AlarmedRow[],
  alarmedBacklogTotal: number,
  log: (message: string) => void
): void {
  for (const reason of ALARM_ESCALATION_ORDER) {
    const rows = alarmed.filter((entry) => entry.reason === reason);
    if (rows.length === 0) continue;
    const copy = ALARM_ESCALATION[reason];
    emitBatchedEscalation(
      {
        reason,
        // BAL-521 (F8) — `count` was the SAME value as `reportedThisTick` on every alarm record
        // (both `rows.length`); dropped in favour of the one name the copy already references.
        alarmedBacklogTotal,
        reportedThisTick: rows.length,
        wallets: rows.map(({ wallet }) => ({
          walletId: wallet.id,
          companyId: wallet.companyId,
          pendingTopupAt: wallet.pendingTopupAt,
          triggeringEntryId: wallet.pendingTopupTriggeringEntryId,
          paymentIntentId: wallet.pendingTopupPaymentIntentId,
          mandateStatus: wallet.mandateStatus,
        })),
      },
      copy.message,
      log,
      copy.summary,
      rows.length
    );
  }
}

/**
 * BAL-521 §1 — ONE error for the escalated set, emitted only when non-empty. `alarmedBacklogTotal`
 * is deliberately NOT on this record: escalated rows are never stamped as alarmed (D6), so the
 * alarmed backlog says nothing about them.
 */
function emitEscalatedRecord(
  escalated: readonly EscalatedRow[],
  log: (message: string) => void
): void {
  if (escalated.length === 0) return;
  emitBatchedEscalation(
    {
      count: escalated.length,
      wallets: escalated.map(({ wallet, paymentIntentId, piStatus, stuckForMs }) => ({
        walletId: wallet.id,
        companyId: wallet.companyId,
        pendingTopupAt: wallet.pendingTopupAt,
        triggeringEntryId: wallet.pendingTopupTriggeringEntryId,
        paymentIntentId,
        mandateStatus: wallet.mandateStatus,
        piStatus,
        stuckForMs,
      })),
    },
    'Auto-top-up PaymentIntents still in flight far past the escalation window — nothing was written for any of them; manual handling required. This is NOT an alarm: each PaymentIntent is still processing and can still settle, so these rows are never de-prioritised in the finder rotation',
    log,
    'auto-top-up PaymentIntents stuck in flight past the escalation window',
    escalated.length
  );
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
    // ⚠ NO SILENT CAPS. BAL-521 (AMEND-6) — under the §2 rotation a never-alarmed row ALWAYS
    // leads the batch, so a filled batch no longer proves a fresh row was dropped; it proves the
    // backlog (never-alarmed + alarmed) is AT LEAST this limit — still a signal worth a warn.
    //
    // BAL-521 (F7) — this is the HEAD of the rotation (`alarmed_at ASC NULLS FIRST,
    // pending_topup_at ASC`), NOT necessarily the oldest marker: in a fully-alarmed backlog
    // (exactly the case an operator is debugging) the least-recently-alarmed row and the
    // oldest-by-`pending_topup_at` row can differ. Named for what it structurally is.
    const [head] = wallets;
    logger.warn(
      { limit: AUTO_TOPUP_RECONCILE_BATCH_LIMIT, headWalletId: head?.id },
      'Auto-top-up reconcile batch FILLED — the stuck-reload backlog is at least this limit; some rows will reach a later tick (never dropped — each re-presents next tick with its evidence intact)'
    );
  }

  const result: AutoTopupReconcileSweepResult = {
    repaired: 0,
    alreadyCredited: 0,
    refunded: 0,
    failedClosed: 0,
    drained: 0,
    alarms: 0,
    partialRefundAlarms: 0,
    escalatedStillInFlight: 0,
    alarmedBacklogTotal: 0,
  };
  const alarmed: AlarmedRow[] = [];
  const escalated: EscalatedRow[] = [];

  for (const wallet of wallets) {
    await reconcileAndTally(wallet, now, result, alarmed, escalated, log);
  }

  await stampAlarmedRows(alarmed, now);

  // BAL-521 §2 (DEC-5) — THE BACKLOG COUNT, ALWAYS, not only when something alarmed THIS tick.
  // `alarmed.length === 0` with a non-zero backlog is reachable (100 fresh rows fill the batch
  // and push every alarmed row out of this tick), and reporting `0` there would be exactly the
  // silent under-reporting the no-silent-caps rule forbids. Measured AFTER the stamp above, so
  // this tick's newly-alarmed rows are included and the figures in one record stay consistent.
  // No try/catch: if this throws, the DB is unavailable and the tick is worthless anyway — the
  // BullMQ job fails and retries next minute with every row's evidence intact.
  result.alarmedBacklogTotal = await creditWalletsRepository.countAlarmedPendingTopups(cutoff);

  emitAlarmRecords(alarmed, result.alarmedBacklogTotal, log);
  emitEscalatedRecord(escalated, log);

  logger.info({ ...result, candidates: wallets.length }, 'Auto-top-up reconcile sweep complete');
  return result;
}

/** Start the auto-top-up reconcile worker (concurrency 1 — one serialised pass per tick). */
export function startAutoTopupReconcileSweepWorker(): Worker {
  return new Worker(
    AUTO_TOPUP_RECONCILE_SWEEP_QUEUE,
    async (job: Job) => {
      const {
        repaired,
        alreadyCredited,
        refunded,
        failedClosed,
        drained,
        alarms,
        partialRefundAlarms,
        alarmedBacklogTotal,
        escalatedStillInFlight,
      } = await runAutoTopupReconcileSweep(new Date(), (m) => job.log(m));
      job.log(
        `auto-top-up reconcile: ${repaired} repaired, ${alreadyCredited} already-credited, ${refunded} refunded, ${failedClosed} failed-closed, ${drained} drained, ${alarms} alarms (${partialRefundAlarms} partial-refund, ${alarmedBacklogTotal} alarmed in total), ${escalatedStillInFlight} escalated still-in-flight`
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
