import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { creditHoldsRepository, creditWalletsRepository, expertsRepository } from '@balo/db';
import { deriveSessionEstimate, isWalletMandateActive } from '@balo/shared/credit';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  trackServerAndFlush,
  BOOKING_SERVER_EVENTS,
  type BookingFundingBlockReason,
} from '@/lib/analytics/server';
import { resolveBookingExpertDisplay } from './load-booking-context';

/**
 * BAL-478 — the booking pre-condition: a Case may only be booked when the paying company can
 * actually settle it — an active payment mandate OR available credit >= the estimate.
 *
 * ⚠⚠ ADVISORY, NEVER AUTHORITATIVE. Two unlocked reads. The authoritative gate is
 * `creditSessionsRepository.open` step 5 under `acquireWalletLock`. This exists so the failure is
 * caught days before anyone's calendar is committed — not to replace it. A disagreement under a
 * race is correct (R3).
 *
 * ⚠⚠ CALL IT BEFORE THE FIRST WRITE. Same rule as `viewerApiCredentialIsLive()`
 * (`book-consultation.ts:712`): a refusal must leave no case, no engagement, no meeting.
 *
 * ⚠ THE TWO ARMS ARE THE SHIPPED IN-TXN ARMS, NOT A RESTATEMENT — same predicate
 * (`isWalletMandateActive`, R4), same estimate helper (`deriveSessionEstimate`, R2), same `>=`
 * comparison. Never inline a second copy of either.
 *
 * ⚠ MANDATE FIRST, DELIBERATELY. A live mandate short-circuits with ONE query; only a
 * mandate-less wallet pays for the rate + balance reads. Pinned by the test in
 * `booking-funding-gate.test.ts`.
 *
 * ⚠ THE FAN-OUT IS PUBLISHED HERE, NOT BY THE CALLER. R6's member-arm copy promises the
 * billing admins were told; that promise is kept only if the publish sits at the point the
 * zero-arm is determined. A caller cannot forget it.
 *
 * ⚠ A READ ERROR IS NOT A REFUSAL. `'unavailable'` fails the booking closed on the generic
 * `booking_failed` path and publishes NOTHING — we must never tell a company's billing admins
 * they are unfunded because a query blipped.
 *
 * ⚠⚠ THE ZERO-ARM DETERMINATION AND ITS SIDE EFFECTS ARE TWO SEPARATE FAILURE DOMAINS
 * (fix round: REV-3 / SEC-1). `resolveFundingReads` below owns the ONLY `try/catch` around the
 * three unlocked reads that decide `ok` vs `unfunded` vs `unavailable`. Once a zero-arm is
 * determined, `refuseUnfunded` runs OUTSIDE that catch — a blip in `hasCapability` or in the
 * publish must never re-classify an already-decided refusal as `'unavailable'`, which would
 * also silently skip the billing-admin fan-out the member-arm copy promises.
 */

/** One dispatch per (company, booker) per hour — the `credit.topup.requested` window, verbatim. */
const FUNDING_NOTICE_WINDOW_MS = 60 * 60 * 1000;

export type BookingFundingResult =
  | { readonly ok: true }
  /** Determined zero-arm. The billing-admin fan-out HAS been published by the time this returns. */
  | { readonly ok: false; readonly reason: 'unfunded'; readonly canManageBilling: boolean }
  /** A read failed — we do NOT know the company is unfunded. Fail closed, notify nobody. */
  | { readonly ok: false; readonly reason: 'unavailable' };

interface EnforceBookingFundingInput {
  readonly actorUserId: string;
  readonly actorDisplayName: string;
  readonly companyId: string;
  readonly expertProfileId: string;
  readonly estimatedMinutes: number;
}

/** What the three unlocked reads decided, before any side effect has run. */
type FundingReadOutcome =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'zero_arm';
      readonly reason: BookingFundingBlockReason;
      /** Present only on the balance arm — `no_wallet` never got far enough to compute either. */
      readonly estimateMinor?: number;
      readonly availableMinor?: number;
    }
  | { readonly kind: 'unavailable' };

/**
 * The three unlocked reads (wallet, mandate, rate, balance) — nothing else. Kept isolated from
 * `refuseUnfunded`'s capability read and publish (see the module docblock, REV-3 / SEC-1).
 */
async function resolveFundingReads(input: EnforceBookingFundingInput): Promise<FundingReadOutcome> {
  try {
    const wallet = await creditWalletsRepository.findByCompanyId(input.companyId);
    if (wallet === undefined) {
      // R5 — an unprovisioned wallet is the zero-arm case, not an error. Never provision one
      // from this read-only pre-check.
      return { kind: 'zero_arm', reason: 'no_wallet' };
    }

    if (isWalletMandateActive(wallet)) {
      // Mandate arm alone suffices — no further reads (rate, balance).
      return { kind: 'ok' };
    }

    const expert = await expertsRepository.findRateCentsById(input.expertProfileId);
    if (expert === undefined) {
      // SEC-3 — an UNKNOWN, client-supplied `expertProfileId` is NOT the same condition as a
      // known expert who simply has no rate set (§4.3 below): it has no owner, and there is no
      // reason to let an unfunded company hold a slot against an id that names nothing. Fail
      // closed rather than folding it into the rate-less pass.
      log.warn('Booking funding pre-check found no matching expert profile — failing CLOSED', {
        userId: input.actorUserId,
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
      });
      return { kind: 'unavailable' };
    }
    if (expert.rateCents === null) {
      // §4.3 — a rate-less expert is NOT a funding refusal. The balance arm is unevaluable, so
      // the gate passes rather than blaming the client for the expert's misconfiguration. That
      // condition already has an owner (the expert checklist + BAL-466's `expert_rate_missing`
      // alarm at admission).
      log.warn('Booking funding pre-check skipped — expert has no rate', {
        userId: input.actorUserId,
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
      });
      return { kind: 'ok' };
    }

    // ⚠ REV-7 — `baloFeeBps` is deliberately OMITTED here, matching `open()`'s own
    // `input.baloFeeBps ?? DEFAULT_BALO_FEE_BPS`: no caller of EITHER function passes a
    // per-company override today, so the two agree by construction. If a future per-company fee
    // override ships, this gate must thread the SAME value `open()` will see at admission, or
    // the advisory estimate silently diverges from the authoritative one it exists to predict.
    const { estimateMinor } = deriveSessionEstimate({
      expertHourlyMinor: expert.rateCents,
      estimatedMinutes: input.estimatedMinutes,
    });
    const availableMinor = await creditHoldsRepository.getAvailableBalance(wallet.id);

    if (availableMinor >= estimateMinor) {
      return { kind: 'ok' };
    }

    return {
      kind: 'zero_arm',
      reason: 'no_mandate_insufficient_balance',
      estimateMinor,
      availableMinor,
    };
  } catch (error) {
    log.error('Booking funding pre-check read failed — failing CLOSED', {
      userId: input.actorUserId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'unavailable' };
  }
}

/**
 * Resolve the actor's capability for the panel's CTA branch. A failed read is treated as
 * NON-holder (`funding_admins_notified`) — the same fail-closed posture `hasCapability` itself
 * takes on a missing membership; routing a failed read to the self-serve CTA could send someone
 * to a page that then also fails for them (orchestrator ruling, REV-3).
 */
async function resolveCanManageBilling(input: EnforceBookingFundingInput): Promise<boolean> {
  try {
    return await hasCapability({ id: input.actorUserId }, CAPABILITIES.MANAGE_BILLING, {
      companyId: input.companyId,
    });
  } catch (error) {
    log.error('Booking funding capability read failed — treating the actor as a non-holder', {
      userId: input.actorUserId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
}

/**
 * The zero-arm side effects — fan-out + analytics. A publish failure is logged (Axiom + Sentry)
 * and swallowed: the refusal is still returned, and the fan-out is best-effort behind BullMQ's
 * own retries (orchestrator ruling, REV-3 — not a second promise-keeping mechanism).
 */
async function publishFundingBlocked(
  input: EnforceBookingFundingInput,
  reason: BookingFundingBlockReason,
  canManageBilling: boolean
): Promise<void> {
  try {
    const hourBucket = Math.floor(Date.now() / FUNDING_NOTICE_WINDOW_MS);
    const expertDisplay = await resolveBookingExpertDisplay(input.expertProfileId);

    publishNotificationEvent('booking.funding_blocked', {
      correlationId: `booking-funding:${input.companyId}:${input.actorUserId}:${hourBucket}`,
      companyId: input.companyId,
      requestedByName: input.actorDisplayName,
      expertPartyLabel: expertDisplay.partyLabel,
    });

    trackServerAndFlush(BOOKING_SERVER_EVENTS.FUNDING_BLOCKED, {
      expert_id: input.expertProfileId,
      reason,
      can_manage_billing: canManageBilling,
      duration_minutes: input.estimatedMinutes,
      distinct_id: input.actorUserId,
    });
  } catch (error) {
    log.error('Booking funding blocked fan-out failed to publish', {
      userId: input.actorUserId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    Sentry.captureException(error, {
      tags: { feature: 'booking', step: 'funding_blocked_publish' },
      extra: { companyId: input.companyId, expertProfileId: input.expertProfileId },
    });
  }
}

/**
 * The zero-arm outcome: resolve the actor's capability, fan out, and return the refusal.
 * DELIBERATELY called outside `resolveFundingReads`'s try/catch (REV-3 / SEC-1) — see the
 * module docblock.
 */
async function refuseUnfunded(
  input: EnforceBookingFundingInput,
  reason: BookingFundingBlockReason,
  estimateMinor?: number,
  availableMinor?: number
): Promise<BookingFundingResult> {
  const canManageBilling = await resolveCanManageBilling(input);

  // REV-2 — `estimateMinor`/`availableMinor` are the ONLY place the shortfall exists: the
  // panel, the email, the in-app notice and PostHog all deliberately carry no money figure.
  log.warn('Booking refused before any write — funding pre-condition unmet', {
    userId: input.actorUserId,
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    reason,
    canManageBilling,
    estimateMinor,
    availableMinor,
  });

  await publishFundingBlocked(input, reason, canManageBilling);

  return { ok: false, reason: 'unfunded', canManageBilling };
}

export async function enforceBookingFunding(
  input: EnforceBookingFundingInput
): Promise<BookingFundingResult> {
  const reads = await resolveFundingReads(input);

  if (reads.kind === 'ok') {
    return { ok: true };
  }
  if (reads.kind === 'unavailable') {
    return { ok: false, reason: 'unavailable' };
  }
  return refuseUnfunded(input, reads.reason, reads.estimateMinor, reads.availableMinor);
}
