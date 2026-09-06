/**
 * BAL-378 (ADR-1040 Lane 2) — the SINGLE-AUTHORITY publish + analytics path for in-session
 * drawdown / settlement events. Called by the meter driver (transition notices), `endSession`
 * (settlement outcomes), the settlement webhook (`dispatch.ts`), and the nudge route.
 *
 * Feature code NEVER sends email/SMS directly (notification-engine contract) — it publishes a
 * domain event via `notificationEvents.publish`. Server analytics fire via `trackServer`
 * (`distinct_id = companyId`). Defined here ONCE so the payload/analytics shapes never drift
 * across the meter driver, `endSession`, and the webhook (Sonar new-code duplication gate).
 */
import {
  expertsRepository,
  usersRepository,
  meetingsRepository,
  type CreditSession,
  // BAL-412 (F17) — the four settlement shapes come from the pgEnum's own derived type, never
  // re-spelled inline (CLAUDE.md's repeated-string-union rule). This file already imports from
  // `@balo/db`, so it costs no new dependency.
  type CreditSettlementShape,
} from '@balo/db';
import { trackServer, SESSION_SERVER_EVENTS } from '@balo/analytics/server';
import {
  minutesOfRunway,
  type CashCreditReason,
  type SettleableSession,
} from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { notificationEvents } from '../../notifications/publisher.js';
import { resolveBillingFloorMinutes } from '../../config/billing-floor.js';
import { ceilingRoomMinor, graceRemainingMinutes, overdraftMagnitude } from './settlement.js';

const log = createLogger('credit-session');

export type { SettleableSession };

/** Long UTC date for the settled receipt copy (matches the credit-email date convention). */
function formatSettledOn(now: Date): string {
  return now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Resolve the expert's display name (best-effort — degrades to 'your expert'). */
async function resolveExpertName(expertProfileId: string): Promise<string> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (profile === undefined) {
    return 'your expert';
  }
  const user = await usersRepository.findById(profile.userId);
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'your expert';
}

/** Low-runway warning (self, in-app). One-shot per session. */
export async function publishLowBalance(
  session: CreditSession,
  balanceMinor: number
): Promise<void> {
  // BAL-412 (D6) — the CORRECTED runway formula: `resolveBillingFloorMinutes()` reads the
  // SAME env-overridable floor the settlement layer snapshots, and `connectedMinutes` is what
  // the balance has already been drawn down by (drawn, not elapsed — see `runway.ts`).
  await notificationEvents.publish('session.low_balance', {
    correlationId: `${session.id}:low_balance`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    minutesRemaining: minutesOfRunway({
      balanceMinor,
      ratePerMinuteMinor: session.clientRateMinorPerMinute,
      floorMinutes: resolveBillingFloorMinutes(),
      minutesAlreadyDrawn: session.connectedMinutes,
    }),
    balanceMinor,
    ratePerMinuteMinor: session.clientRateMinorPerMinute,
  });
}

/** Entered card-backed grace (self in-app + SMS; admin ping) + GRACE_ENTERED analytics. */
export async function publishGraceEntered(
  session: CreditSession,
  balanceMinor: number,
  now: Date
): Promise<void> {
  const ceilingRoom = ceilingRoomMinor(session, balanceMinor);
  await notificationEvents.publish('session.grace_entered', {
    correlationId: `${session.id}:grace_entered`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    graceRemainingMinutes: graceRemainingMinutes(session, now),
    ceilingRoomMinor: ceilingRoom,
  });
  trackServer(SESSION_SERVER_EVENTS.GRACE_ENTERED, {
    session_id: session.id,
    company_id: session.companyId,
    wallet_id: session.walletId,
    ceiling_room_minor: ceilingRoom,
    distinct_id: session.companyId,
  });
}

/** Approaching the wrap (self, in-app + SMS). One-shot per session. */
export async function publishNearWrap(session: CreditSession, now: Date): Promise<void> {
  await notificationEvents.publish('session.near_wrap', {
    correlationId: `${session.id}:near_wrap`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    graceRemainingMinutes: graceRemainingMinutes(session, now),
  });
}

/** The wrap was caused by the overdraft ceiling — GRACE_CEILING_HIT analytics (no notice). */
export function trackCeilingHit(session: CreditSession, balanceMinor: number): void {
  trackServer(SESSION_SERVER_EVENTS.GRACE_CEILING_HIT, {
    session_id: session.id,
    company_id: session.companyId,
    wallet_id: session.walletId,
    overdraft_minor: overdraftMagnitude(balanceMinor),
    distinct_id: session.companyId,
  });
}

/**
 * Settled (in-credit at end OR the overdraft charge succeeded) — billing-admin receipt.
 *
 * ⚠ `settlementShape` is BAL-412's OPTIONAL third argument (D7) — present only when the caller
 * settled from presence. It feeds ONLY the analytics `settlement_outcome` key, a SEPARATE key
 * from `outcome` above (the PAYMENT outcome, unchanged) — the two must never be confused.
 */
export async function publishSessionSettled(
  session: SettleableSession,
  now: Date,
  settlementShape?: CreditSettlementShape
): Promise<void> {
  const overdraft = session.overdraftSettledMinor ?? 0;
  const expertName = await resolveExpertName(session.expertProfileId);
  await notificationEvents.publish('session.settled', {
    correlationId: `${session.id}:settled`,
    sessionId: session.id,
    companyId: session.companyId,
    walletId: session.walletId,
    overdraftSettledMinor: overdraft,
    expertName,
    settledOn: formatSettledOn(now),
  });
  trackServer(SESSION_SERVER_EVENTS.SESSION_SETTLED, {
    session_id: session.id,
    company_id: session.companyId,
    outcome: 'success',
    overdraft_settled_minor: overdraft,
    distinct_id: session.companyId,
    ...(settlementShape === undefined ? {} : { settlement_outcome: settlementShape }),
  });
}

/**
 * A settlement could not complete (hard decline / SCA / async fail) — dunning notice +
 * SESSION_SETTLED{outcome} + RECEIVABLE_OPENED analytics. The receivable row itself is opened
 * by the caller (in its own txn); this only publishes + tracks (post-commit).
 */
export async function publishSettlementFailure(input: {
  /** Only id/companyId/walletId are needed (a full `SettleableSession` is structurally fine). */
  session: { id: string; companyId: string; walletId: string };
  reason: 'declined' | 'requires_action';
  amountMinor: number;
  /** Stamps the re-notifiable dunning `correlationId`. */
  attemptEpochMs: number;
}): Promise<void> {
  const { session, reason, amountMinor, attemptEpochMs } = input;
  await notificationEvents.publish('session.settlement_failed', {
    correlationId: `${session.id}:settlement_failed:${attemptEpochMs}`,
    sessionId: session.id,
    companyId: session.companyId,
    walletId: session.walletId,
    amountMinor,
    reason,
  });
  trackServer(SESSION_SERVER_EVENTS.SESSION_SETTLED, {
    session_id: session.id,
    company_id: session.companyId,
    outcome: reason === 'requires_action' ? 'requires_action' : 'fail',
    overdraft_settled_minor: amountMinor,
    distinct_id: session.companyId,
  });
  trackServer(SESSION_SERVER_EVENTS.RECEIVABLE_OPENED, {
    session_id: session.id,
    company_id: session.companyId,
    amount_minor: amountMinor,
    reason: reason === 'requires_action' ? 'settlement_requires_action' : 'settlement_declined',
    distinct_id: session.companyId,
  });
}

/**
 * BAL-412 (F16) — the presence-settlement CONTEXT the two ordinary receipts carry, derived ONCE
 * from the already-settled session row.
 *
 * ⚠⚠ IT EXISTS BECAUSE A `no_show_client` RECEIPT IS OTHERWISE INDISTINGUISHABLE FROM AN
 * ORDINARY ONE. Without these fields the client who never joined receives "Your 15-minute
 * session with {expert} came to A$X" — a claim about a call that did not happen — and the expert
 * receives an unremarkable earnings notice with no indication of why. `missed_call` got its own
 * bespoke apologetic event (`session.missed_call`); `no_show_client` is settled through the
 * ORDINARY events, so the context has to travel on them. The templates add ONE factual sentence
 * off `settlementShape` (see `templates/index.ts` / `in-app-templates.ts`).
 *
 * All three are OPTIONAL on the payloads and OMITTED (never `null`) for `live_capture` /
 * `external` and every row written before migration 0071 — so the shipped receipt is unchanged.
 *
 * FEE-SAFE ON BOTH SIDES: a shape LABEL and two DURATIONS, never a second figure. That is what
 * lets one helper serve both the client-lens and expert-lens payload (the alternative — two
 * copies of the same three-field spread — would also trip the new-code duplication gate).
 */
function presenceContext(session: CreditSession): {
  settlementShape?: CreditSettlementShape;
  actualMinutes?: number;
  billingFloorMinutes?: number;
} {
  if (session.settlementShape === null) {
    return {};
  }
  return {
    settlementShape: session.settlementShape,
    ...(session.actualMinutes === null ? {} : { actualMinutes: session.actualMinutes }),
    ...(session.billingFloorMinutes === null
      ? {}
      : { billingFloorMinutes: session.billingFloorMinutes }),
  };
}

/**
 * BAL-399 — the acting member's PERSONAL consultation receipt (recipient 'self', email + in-app).
 * Published once from `finalizeBilling`. Carries the all-in charge (connectedMinutes × client rate)
 * — NO expert rate/accrual/margin (fee concealment). Distinct from the billing-admin
 * `session.settled` fan-out (Owner Decision O1).
 *
 * BAL-412 (F16): also carries the presence-settlement context, so a `no_show_client` receipt can
 * say WHY it is a receipt for a call the client never joined. See {@link presenceContext}.
 */
export async function publishPaymentCharged(session: CreditSession, now: Date): Promise<void> {
  const expertName = await resolveExpertName(session.expertProfileId);
  await notificationEvents.publish('payment.charged', {
    correlationId: `${session.id}:payment_charged`,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    sessionId: session.id,
    amountAudMinor: session.connectedMinutes * session.clientRateMinorPerMinute,
    durationMinutes: session.connectedMinutes,
    expertName,
    chargedOn: formatSettledOn(now),
    ...presenceContext(session),
  });
}

/**
 * BAL-399 — the delivering expert's own-earnings notice (recipient 'expert', email + in-app).
 * Published once from `finalizeBilling`. Carries the expert's OWN earnings (= expertAccruedMinor)
 * — NO client charge/markup/margin (fee concealment).
 *
 * BAL-412 (F16): also carries the presence-settlement context — the AC's "no-show settled →
 * expert → in-app (accrual confirmation)". See {@link presenceContext}.
 */
export async function publishPayoutRecorded(session: CreditSession, now: Date): Promise<void> {
  await notificationEvents.publish('payout.recorded', {
    correlationId: `${session.id}:payout_recorded`,
    expertProfileId: session.expertProfileId,
    sessionId: session.id,
    amountAudMinor: session.expertAccruedMinor,
    durationMinutes: session.connectedMinutes,
    recordedOn: formatSettledOn(now),
    ...presenceContext(session),
  });
}

/**
 * BAL-412 (ADR-1044 §7, D8) — the expert never joined. TWO recipients on ONE publish: the
 * acting member (recipient 'self', APOLOGETIC) and the delivering expert (recipient 'expert',
 * FACTUAL) — see `SessionMissedCallPayload`'s docblock. Called from `finalizeBilling`, gated on
 * `settlementShape === 'missed_call'`.
 *
 * ⚠ `session.meetingId === null` should be unreachable for a presence-settled session (D11 —
 * `settleFromPresence` always names the meeting it settled from), but this is a best-effort
 * notification path: guard defensively and skip rather than publish a payload missing its
 * `scheduledOn` anchor.
 *
 * ⚠ `_now` IS UNUSED, deliberately kept in the signature for call-site parity with the other
 * `publish*` functions `finalizeBilling` calls uniformly — `scheduledOn` anchors on the
 * MEETING's `scheduledStart` (the call's actual scheduled time), never "now" (when settlement
 * happened, which can be well after the meeting).
 */
export async function publishSessionMissedCall(session: CreditSession, _now: Date): Promise<void> {
  if (session.meetingId === null) {
    log.warn(
      { sessionId: session.id },
      'publishSessionMissedCall — session has no meetingId (unreachable for a presence-settled session) — skipping'
    );
    return;
  }
  const meeting = await meetingsRepository.findById(session.meetingId);
  if (meeting === undefined) {
    log.warn(
      { sessionId: session.id, meetingId: session.meetingId },
      'publishSessionMissedCall — meeting not found — skipping'
    );
    return;
  }
  const expertName = await resolveExpertName(session.expertProfileId);
  await notificationEvents.publish('session.missed_call', {
    correlationId: `${session.id}:missed_call`,
    sessionId: session.id,
    meetingId: session.meetingId,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    expertProfileId: session.expertProfileId,
    expertName,
    scheduledOn: formatSettledOn(meeting.scheduledStart),
  });
}

/**
 * BAL-535 (ADR-1040 Amendment 6 §F) — a covering CASH credit cleared the company's open
 * receivables, releasing its soft account hold. Publish + analytics defined ONCE here (mirroring
 * `publishSettlementFailure`'s `RECEIVABLE_OPENED` shape) so the payload/analytics shapes for
 * the money-in half of that pairing cannot drift from the money-out half.
 *
 * ⚠ ONE NOTICE PER CLEAR OPERATION, NOT PER ROW (fix round N4). A wallet can hold several open
 * receivables — `credit-receivables.integration.test.ts` proves it — and the previous shape
 * returned one thunk per cleared row, so three rows sent three identical "your account is clear"
 * emails, each quoting the same balance. `correlationId` is therefore keyed on the LEDGER ENTRY
 * that covered the debt (`receivable_cleared:{ledgerEntryId}`), which is one per clear operation
 * and is itself idempotency-keyed, so a webhook replay collapses onto the same BullMQ jobId.
 *
 * ⚠ `balanceAfterMinor` IS THE DISPLAY FIGURE, and it is the caller's job to pass the TRUE final
 * one (M3): on a `manual_purchase` the promo grant lands after the clear's predicate ran, and
 * this email reaches the same MANAGE_BILLING holder as the top-up receipt seconds later. The
 * predicate's own (pre-promo, promo-discounted) figures live on the `audit_events` row instead —
 * different questions, so never one field.
 *
 * Called as a `PostCommitEffect` thunk from the Stripe webhook (`dispatch.ts`), whose post-commit
 * loop has NO surrounding try/catch of its own (unlike `applyStripeEffect`'s txn) — so, mirroring
 * `publishTopupReceipt`'s posture in that same file, this SELF-CATCHES and never re-throws: the
 * money (the clear) is already committed, and re-throwing would make Stripe retry the WHOLE
 * webhook for a notification hiccup.
 *
 * ⚠ THE ANALYTICS FIRE BEFORE — AND OUTSIDE — THE PUBLISH TRY (fix round L1), exactly as
 * `publishTopupReceipt`'s `emitManualPurchaseCredited` does deliberately. Inside it, a queue
 * outage lost the METRIC as well as the email, and its pair `RECEIVABLE_OPENED` sits on a
 * throwing path — so §J's "how many holds clear without ops touching them" would have counted
 * opens reliably and clears short. `trackServer` is a no-op without an API key and `capture`
 * only enqueues, so this cannot itself be what fails.
 */
export async function publishReceivableCleared(input: {
  /** The credit ledger entry that covered the debt — the operation's identity. */
  ledgerEntryId: string;
  companyId: string;
  walletId: string;
  /** How many open receivables this one operation cleared (`>= 1`). */
  receivableCount: number;
  /** Sum of the cleared receivables' recorded amounts (AUD minor) — the consultations' figure. */
  clearedMinor: number;
  /** The TRUE final wallet balance the client will see (AUD minor). */
  balanceAfterMinor: number;
  clearedBy: CashCreditReason;
}): Promise<void> {
  const {
    ledgerEntryId,
    companyId,
    walletId,
    receivableCount,
    clearedMinor,
    balanceAfterMinor,
    clearedBy,
  } = input;
  // ⚠ ITS OWN try, not the publish's. Outside the publish so a queue outage cannot lose the
  // metric (L1); contained so an analytics hiccup cannot escape into the post-commit loop, which
  // has no try/catch of its own and would answer 500 and make Stripe retry a COMMITTED webhook.
  // Exactly `emitManualPurchaseCredited`'s posture in `dispatch.ts`.
  try {
    trackServer(SESSION_SERVER_EVENTS.RECEIVABLE_CLEARED, {
      company_id: companyId,
      wallet_id: walletId,
      receivable_count: receivableCount,
      cleared_minor: clearedMinor,
      balance_after_minor: balanceAfterMinor,
      cleared_by: clearedBy,
      distinct_id: companyId,
    });
  } catch (err: unknown) {
    log.warn(
      {
        op: 'publishReceivableCleared',
        ledgerEntryId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to emit receivable_cleared (hold released; analytics best-effort)'
    );
  }
  try {
    await notificationEvents.publish('credit.receivable.cleared', {
      correlationId: `receivable_cleared:${ledgerEntryId}`,
      companyId,
      walletId,
      receivableCount,
      clearedMinor,
      balanceAfterMinor,
      clearedBy,
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishReceivableCleared',
        ledgerEntryId,
        companyId,
        walletId,
        receivableCount,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish credit.receivable.cleared (hold released; notification best-effort)'
    );
  }
}

/** Member nudge asking billing admins to top up (in-app fan-out). Re-notifiable per click. */
export async function publishTopupNudge(
  session: { id: string; companyId: string },
  requestedByUserId: string,
  requestedByName: string,
  nowMs: number
): Promise<void> {
  await notificationEvents.publish('session.topup_nudge', {
    correlationId: `${session.id}:topup_nudge:${nowMs}`,
    sessionId: session.id,
    companyId: session.companyId,
    requestedByUserId,
    requestedByName,
  });
}
