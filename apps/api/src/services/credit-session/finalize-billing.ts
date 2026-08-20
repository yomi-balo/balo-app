/**
 * BAL-399 (ADR-1040 / ADR-1043) — the Case billing-slice FINALIZATION publisher. Called
 * post-`end()` (post-commit), gated on `!alreadyEnded`, by BOTH the live-capture `endSessionAsSystem`
 * path and the external BAL-133 finalizer.
 *
 * The expert payout-record UNIQUE is the SINGLE source of exactly-once: `record()` returns
 * `created=false` when the obligation already exists (reaper `end()` + route `end()` + external
 * finalizer racing all converge on it), so ALL side-effects — both notifications AND all three
 * server analytics — are gated on `created`. The payout amount is READ from the ALREADY-FINALIZED
 * `session.expertAccruedMinor`, NEVER re-derived from minutes (double-count hazard O3).
 */
import {
  expertPayoutRecordsRepository,
  type CreditSession,
  type CreditFinalizationPath,
} from '@balo/db';
import { trackServer, CASE_BILLING_SERVER_EVENTS } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  publishPaymentCharged,
  publishPayoutRecorded,
  publishSessionMissedCall,
} from './notify.js';

const log = createLogger('credit-session');

/** Whole minutes a session spent in grace (from `graceEnteredAt` to its terminal `endedAt`). */
function graceMinutesUsed(session: CreditSession): number {
  if (session.graceEnteredAt === null || session.endedAt === null) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor((session.endedAt.getTime() - session.graceEnteredAt.getTime()) / 60_000)
  );
}

/**
 * BAL-412 — the three OPTIONAL `case_billing_finalized` properties a presence-settled session
 * carries, all three OMITTED (never `null`, never guessed) on a `live_capture` / `external`
 * session and on every row written before migration 0071.
 *
 * ⚠ `floored` READS THE SNAPSHOT (`credit_sessions.floor_applied`) AND MUST NEVER BE RE-DERIVED
 * (F14). It was previously computed as `connectedMinutes > actualMinutes`, which is WRONG on the
 * Q1 no-refund clamp: `connected_minutes` is post-clamp, so a 6-minute call that had already
 * drawn 10 minutes reported `floored: true` with no floor involved — inflating exactly the "how
 * often does the minimum bind" metric (D7) with every overcharge. The pure core's answer
 * (`ruleMinutes > actualMinutes`) is snapshotted at settlement; this reads it.
 *
 * ⚠ Extracted from {@link finalizeBilling} rather than inlined: three conditional spreads inside
 * that already-branchy function push its cognitive complexity past the SonarCloud limit of 15.
 */
function presenceAnalyticsProps(session: CreditSession): {
  actual_min?: number;
  floored?: boolean;
  settlement_outcome?: NonNullable<CreditSession['settlementShape']>;
} {
  return {
    ...(session.actualMinutes === null ? {} : { actual_min: session.actualMinutes }),
    ...(session.floorApplied === null ? {} : { floored: session.floorApplied }),
    ...(session.settlementShape === null ? {} : { settlement_outcome: session.settlementShape }),
  };
}

/**
 * Finalize a session's billing side-effects EXACTLY ONCE: book the expert payout obligation, then
 * (only on the first booking) publish the member receipt + the expert payout notice and fire the
 * server analytics. A no-op when the obligation already existed (`created=false`).
 */
export async function finalizeBilling(
  session: CreditSession,
  path: CreditFinalizationPath,
  now: Date = new Date()
): Promise<void> {
  // 1. Book the payout obligation idempotently — READ the finalized accrual (never re-derive).
  let created: boolean;
  let payoutRecordId: string;
  try {
    const result = await expertPayoutRecordsRepository.record({
      sessionId: session.id,
      expertProfileId: session.expertProfileId,
      companyId: session.companyId,
      amountMinor: session.expertAccruedMinor,
      durationMinutes: session.connectedMinutes,
      finalizationPath: path,
      idempotencyKey: `payout:${session.id}`,
    });
    created = result.created;
    payoutRecordId = result.record.id;
  } catch (error) {
    log.error(
      {
        sessionId: session.id,
        path,
        expertAccruedMinor: session.expertAccruedMinor,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to book expert payout record — billing finalization aborted'
    );
    throw error;
  }

  if (!created) {
    // Already finalized — exactly-once guard (O3). No notifications, no analytics.
    return;
  }

  log.info(
    {
      sessionId: session.id,
      path,
      expertAccruedMinor: session.expertAccruedMinor,
      connectedMinutes: session.connectedMinutes,
    },
    'Case billing finalized — payout obligation booked'
  );

  // 2 + 3. Post-commit side-effects (notifications + analytics) are BEST-EFFORT: the payout
  // obligation is already durably booked (created=true) and the expert is paid, so a publish/track
  // failure must NOT rethrow — rethrowing would bubble out of `endSessionAsSystem`, and the retry
  // would see `created=false` and never re-send, permanently losing the receipt/notice. Log and
  // move on. (The `record()` call above is deliberately OUTSIDE this block — its failure SHOULD
  // abort + retry, since nothing is committed yet.)
  // BAL-412 (ADR-1044 §7, D8) — the two ZERO settlement shapes must SUPPRESS the ordinary
  // payment.charged / payout.recorded notices (they would otherwise send "You were charged
  // A$0.00", the wrong register and a claim nobody wants to read). `missed_call` gets its OWN
  // apologetic/factual notice instead; `abandoned_wait` publishes NOTHING (D2 — the expert left
  // below the floor is NOT a reliability judgement, and a notice would be exactly that
  // judgement). The payout obligation is still booked above UNCONDITIONALLY (zero-valued is a
  // real, durable fact `findFinalizedMissingPayout` must never see as "missing").
  const isMissedCall = session.settlementShape === 'missed_call';
  const isAbandonedWait = session.settlementShape === 'abandoned_wait';

  try {
    // Notifications — deterministic correlationIds → BullMQ jobId dedup.
    if (isMissedCall) {
      await publishSessionMissedCall(session, now);
    } else if (!isAbandonedWait) {
      await publishPaymentCharged(session, now);
      await publishPayoutRecorded(session, now);
    }
    // else: abandoned_wait — publish nothing (D2, commented above).

    // Server analytics (distinct_id = companyId) — fire on EVERY path, including the two zero
    // shapes: a zero settlement is a real data point (D7 / the plan's §8.2).
    const clientChargeMinor = session.connectedMinutes * session.clientRateMinorPerMinute;
    trackServer(CASE_BILLING_SERVER_EVENTS.CASE_BILLING_FINALIZED, {
      session_id: session.id,
      company_id: session.companyId,
      amount_aud_minor: clientChargeMinor,
      duration_min: session.connectedMinutes,
      path,
      distinct_id: session.companyId,
      // BAL-412 — optional, present only on a presence-settled session. ⚠ `floored` is READ,
      // never re-derived (F14) — see `presenceAnalyticsProps`.
      ...presenceAnalyticsProps(session),
    });
    trackServer(CASE_BILLING_SERVER_EVENTS.EXPERT_PAYOUT_RECORDED, {
      payout_record_id: payoutRecordId,
      expert_profile_id: session.expertProfileId,
      session_id: session.id,
      amount_aud_minor: session.expertAccruedMinor,
      duration_min: session.connectedMinutes,
      path,
      distinct_id: session.companyId,
    });
    // Owner Decision O2: a finalization-time per-session grace summary — ONLY when grace was used.
    if (session.graceEnteredAt !== null) {
      trackServer(CASE_BILLING_SERVER_EVENTS.CASE_OVERDRAFT_GRACE_USED, {
        session_id: session.id,
        company_id: session.companyId,
        overdraft_settled_minor: session.overdraftSettledMinor ?? 0,
        grace_minutes: graceMinutesUsed(session),
        distinct_id: session.companyId,
      });
    }
  } catch (error) {
    log.error(
      {
        sessionId: session.id,
        path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Case billing finalized (obligation booked, expert paid) but a post-commit notification/analytics side-effect failed — not retrying'
    );
  }
}
