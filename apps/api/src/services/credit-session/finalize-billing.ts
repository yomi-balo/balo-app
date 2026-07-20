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
import { publishPaymentCharged, publishPayoutRecorded } from './notify.js';

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
  try {
    // Notifications — deterministic correlationIds → BullMQ jobId dedup.
    await publishPaymentCharged(session, now);
    await publishPayoutRecorded(session, now);

    // Server analytics (distinct_id = companyId).
    const clientChargeMinor = session.connectedMinutes * session.clientRateMinorPerMinute;
    trackServer(CASE_BILLING_SERVER_EVENTS.CASE_BILLING_FINALIZED, {
      session_id: session.id,
      company_id: session.companyId,
      amount_aud_minor: clientChargeMinor,
      duration_min: session.connectedMinutes,
      path,
      distinct_id: session.companyId,
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
