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
import { expertsRepository, usersRepository, type CreditSession } from '@balo/db';
import { trackServer, SESSION_SERVER_EVENTS } from '@balo/analytics/server';
import type { SettleableSession } from '@balo/shared/credit';
import { notificationEvents } from '../../notifications/publisher.js';
import {
  ceilingRoomMinor,
  graceRemainingMinutes,
  overdraftMagnitude,
  runwayMinutes,
} from './settlement.js';

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
  await notificationEvents.publish('session.low_balance', {
    correlationId: `${session.id}:low_balance`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    minutesRemaining: runwayMinutes(balanceMinor, session.clientRateMinorPerMinute),
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

/** Settled (in-credit at end OR the overdraft charge succeeded) — billing-admin receipt. */
export async function publishSessionSettled(session: SettleableSession, now: Date): Promise<void> {
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
