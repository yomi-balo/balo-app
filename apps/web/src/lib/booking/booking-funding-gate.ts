import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { bookingFundingRepository, companiesRepository } from '@balo/db';
import {
  assessCaseBookingFunding,
  estimatedMinutesForWindow,
  type CaseBookingFundingVerdict,
} from '@balo/shared/credit';
import type { BookingFundingBlockKind } from '@balo/shared/notifications';
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
 * The Case booking pre-conditions: BAL-478's funding check (an active payment mandate OR available
 * credit >= the estimate), BAL-474's D6.1 brake (an open receivable — the soft account hold —
 * refuses a new Case booking) and BAL-474's D6.5 soft reservation (a company without a mandate
 * cannot book past its credit once its planned consultations are set aside).
 *
 * ⚠⚠ ADVISORY, NEVER AUTHORITATIVE. After ADR-1040 Amendment 7, admission no longer enforces
 * funding: the presence seam's open is overdraft-tolerant. This gate is the only funding
 * pre-condition a client meets, and it is ADVISORY (unlocked reads, check-time). `POST /meetings`
 * re-checks the same verdict as defence in depth, and a shortfall that slips past both is billed
 * session-scoped into a receivable, which then brakes the next booking. A disagreement under a
 * race is correct.
 *
 * ⚠⚠ ONE READ, ONE VERDICT. `bookingFundingRepository.readSnapshot` is the one consistent read
 * of the company's funding and `assessCaseBookingFunding` (`@balo/shared/credit`) is the one
 * verdict over it — the SAME two calls the API guard makes, so the two checks cannot disagree
 * about what a booking needs. The rate, the estimate, the netted balance and the reservation
 * are all computed there; this file prices nothing and reads no balance itself. Both run inside
 * the ONE `try/catch` in {@link resolveFundingVerdict} that decides `ok` vs a refusal vs
 * `unavailable`. The estimate is `estimatedMinutesForWindow` over the slot window: the same
 * figure the API and admission compute.
 *
 * ⚠⚠ CALL IT BEFORE THE FIRST WRITE. Same rule as `viewerApiCredentialIsLive()`
 * (`book-consultation.ts`): a refusal must leave no case, no engagement, no meeting.
 *
 * ⚠ THE SNAPSHOT READS THE WALLET AND ITS HOLD FIRST. A live mandate then short-circuits before
 * the rate, balance and reservation reads. Pinned where that ordering lives, in
 * `packages/db/src/repositories/booking-funding.test.ts` ("reads the hold BEFORE the mandate…":
 * one hold read; no rate, balance or reservation read). This gate's own test mocks `readSnapshot`
 * whole and cannot see it.
 *
 * ⚠ A COVERED HOLD IS HEALED, NEVER SHOWN. A hold whose debt the balance already covers is
 * cleared by the API guard's locked correction, which owns the coverage decision. This gate
 * never clears anything: `onCoveredHold: 'defer'` lets the booking through to the API, which
 * heals the hold and re-runs the verdict; `'refuse'` (used only after the API answered
 * `account_on_hold`) means the heal failed, and the refusal carries no figure — never A$0.00.
 *
 * ⚠ THE FAN-OUT IS PUBLISHED HERE, NOT BY THE CALLER. The member arm's copy promises the billing
 * admins were told; that promise is kept only if the publish sits at the point the refusal is
 * determined. A caller cannot forget it. The correlationId carries the block kind, so one kind's
 * notice is never swallowed by another's in the same hour.
 *
 * ⚠ A READ ERROR IS NOT A REFUSAL. `'unavailable'` fails the booking closed on the generic
 * `booking_failed` path and publishes NOTHING — we must never tell a company's billing admins
 * they are unfunded (or on hold) because a query blipped.
 *
 * ⚠⚠ THE VERDICT AND ITS SIDE EFFECTS ARE TWO SEPARATE FAILURE DOMAINS.
 * {@link resolveFundingVerdict} owns the ONLY `try/catch` around the read and the verdict. Once
 * a refusal is determined, the capability read, the company-name read and the publish run
 * OUTSIDE that catch — a blip in `hasCapability` or in the publish must never re-classify an
 * already-decided refusal as `'unavailable'`, which would also silently skip the billing-admin
 * fan-out the member-arm copy promises.
 */

/** One dispatch per (company, booker, block kind) per hour — the `credit.topup.requested` window. */
const FUNDING_NOTICE_WINDOW_MS = 60 * 60 * 1000;

/** The company whose balance refused the booking — what the panel's Top-up action must target. */
export interface BillingCompany {
  readonly id: string;
  /** `null` when the name read failed — the panel falls back to "your team". */
  readonly name: string | null;
  /** True when this is the session's active workspace company (no switch needed to top up). */
  readonly isActive: boolean;
}

export type BookingFundingResult =
  | { readonly ok: true }
  /** Determined zero-arm. The billing-admin fan-out HAS been published by the time this returns. */
  | { readonly ok: false; readonly reason: 'unfunded'; readonly canManageBilling: boolean }
  /**
   * D6.1 — an open receivable refuses the booking. `topUpNeededMinor` is the figure that clears
   * it, always > 0; `null` ⇒ the failed-heal fallback (a covered hold the API could not clear).
   * Fan-out published.
   */
  | {
      readonly ok: false;
      readonly reason: 'on_hold';
      readonly canManageBilling: boolean;
      readonly billingCompany: BillingCompany;
      readonly topUpNeededMinor: number | null;
    }
  /**
   * D6.5 — planned consultations set part of the credit aside. `topUpNeededMinor` > 0 by
   * construction. Fan-out published.
   */
  | {
      readonly ok: false;
      readonly reason: 'reserved';
      readonly canManageBilling: boolean;
      readonly billingCompany: BillingCompany;
      readonly topUpNeededMinor: number;
      readonly reservedBookingCount: number;
    }
  /** A read failed — we do NOT know the company is unfunded. Fail closed, notify nobody. */
  | { readonly ok: false; readonly reason: 'unavailable' };

/** A determined refusal — everything a caller can turn into a panel. */
export type BookingFundingRefusal = Exclude<
  BookingFundingResult,
  { readonly ok: true } | { readonly ok: false; readonly reason: 'unavailable' }
>;

export interface EnforceBookingFundingInput {
  readonly actorUserId: string;
  readonly companyId: string;
  readonly expertProfileId: string;
  /** The booking window — the ONE input the estimate is derived from. */
  readonly slot: { readonly startIso: string; readonly endIso: string };
  /** The session's active workspace company, or `null` — decides whether Top-up must switch. */
  readonly activeCompanyId: string | null;
  /** See the module docblock: `'defer'` lets a covered hold through to the API's heal. */
  readonly onCoveredHold: 'defer' | 'refuse';
}

/** The read and the verdict over it, before any side effect has run. */
type FundingVerdictOutcome =
  | {
      readonly kind: 'verdict';
      readonly verdict: CaseBookingFundingVerdict;
      /** The instant the snapshot was read — the "as of" every figure is dated with. */
      readonly asOf: Date;
    }
  | { readonly kind: 'unavailable' };

/**
 * The one snapshot read and the one verdict — nothing else. Kept isolated from the refusal's
 * capability read and publish (see the module docblock).
 */
async function resolveFundingVerdict(
  input: EnforceBookingFundingInput
): Promise<FundingVerdictOutcome> {
  try {
    const asOf = new Date();
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: input.companyId,
      expertProfileId: input.expertProfileId,
      now: asOf,
    });
    const verdict = assessCaseBookingFunding(snapshot, {
      scheduledStart: new Date(input.slot.startIso),
      scheduledEnd: new Date(input.slot.endIso),
    });
    return { kind: 'verdict', verdict, asOf };
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
 * to a page that then also fails for them.
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
 * The company the balance panel's Top-up action targets. A failed name read degrades to a
 * `null` name (the panel says "your team") and never re-classifies the refusal.
 */
async function resolveBillingCompany(input: EnforceBookingFundingInput): Promise<BillingCompany> {
  const isActive = input.companyId === input.activeCompanyId;
  try {
    const company = await companiesRepository.findNameById(input.companyId);
    return { id: input.companyId, name: company?.name ?? null, isActive };
  } catch (error) {
    log.warn('Booking funding company name read failed — the panel falls back to a neutral label', {
      userId: input.actorUserId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { id: input.companyId, name: null, isActive };
  }
}

/** What the fan-out and the analytics event need to know about one refusal. */
interface FundingBlockNotice {
  readonly reason: BookingFundingBlockReason;
  readonly blockKind: BookingFundingBlockKind;
  readonly canManageBilling: boolean;
  /** `null` ⇒ no figure (the unfunded arm, or the failed-heal fallback). */
  readonly topUpNeededMinor: number | null;
  readonly reservedBookingCount: number | null;
  /** The instant the figure was read. */
  readonly asOfIso: string;
}

/**
 * The refusal side effects — fan-out + analytics. A publish failure is logged (Axiom + Sentry)
 * and swallowed: the refusal is still returned, and the fan-out is best-effort behind BullMQ's
 * own retries — not a second promise-keeping mechanism.
 *
 * ⚠⚠ THE PAYLOAD CARRIES `requestedByUserId`, NEVER A PRE-RENDERED NAME. The resolver hydrates
 * the display name AND checks whether the booker is themselves a fan-out recipient, dropping
 * them from `data.billingUserIds` when they are — a pre-rendered name here could not express
 * that filter, and a bare id is also the shape every other actor-naming event in this codebase
 * uses (`credit.saved_card.detached`, `billing.email_changed`).
 *
 * ⚠ A FIGURE ONLY WHEN THERE IS ONE. `topUpNeededMinor` and `asOfIso` travel together and are
 * ABSENT on the unfunded arm and on the failed-heal fallback — never `0`, so no notice ever
 * renders "A$0.00". The analytics event carries a COUNT at most, never money.
 */
async function publishFundingBlocked(
  input: EnforceBookingFundingInput,
  notice: FundingBlockNotice
): Promise<void> {
  try {
    const hourBucket = Math.floor(Date.now() / FUNDING_NOTICE_WINDOW_MS);
    const expertDisplay = await resolveBookingExpertDisplay(input.expertProfileId);

    publishNotificationEvent('booking.funding_blocked', {
      correlationId: `booking-funding:${input.companyId}:${input.actorUserId}:${notice.blockKind}:${hourBucket}`,
      companyId: input.companyId,
      requestedByUserId: input.actorUserId,
      expertPartyLabel: expertDisplay.partyLabel,
      blockKind: notice.blockKind,
      ...(notice.topUpNeededMinor === null
        ? {}
        : { topUpNeededMinor: notice.topUpNeededMinor, asOfIso: notice.asOfIso }),
      ...(notice.reservedBookingCount === null
        ? {}
        : { reservedBookingCount: notice.reservedBookingCount }),
    });

    trackServerAndFlush(BOOKING_SERVER_EVENTS.FUNDING_BLOCKED, {
      expert_id: input.expertProfileId,
      reason: notice.reason,
      can_manage_billing: notice.canManageBilling,
      duration_minutes: estimatedMinutesForWindow(
        new Date(input.slot.startIso),
        new Date(input.slot.endIso)
      ),
      ...(notice.reservedBookingCount === null
        ? {}
        : { reserved_booking_count: notice.reservedBookingCount }),
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
 * The unfunded outcome (BAL-478): resolve the actor's capability, fan out, and return the
 * refusal. DELIBERATELY called outside {@link resolveFundingVerdict}'s try/catch — see the
 * module docblock.
 */
async function refuseUnfunded(
  input: EnforceBookingFundingInput,
  reason: 'no_wallet' | 'no_mandate_insufficient_balance',
  asOf: Date,
  estimateMinor?: number,
  availableMinor?: number
): Promise<BookingFundingResult> {
  const canManageBilling = await resolveCanManageBilling(input);

  // `estimateMinor`/`availableMinor` are the ONLY place the shortfall exists: the panel, the
  // email, the in-app notice and PostHog all deliberately carry no money figure on this arm.
  log.warn('Booking refused before any write — funding pre-condition unmet', {
    userId: input.actorUserId,
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    reason,
    canManageBilling,
    estimateMinor,
    availableMinor,
  });

  await publishFundingBlocked(input, {
    reason,
    blockKind: 'unfunded',
    canManageBilling,
    topUpNeededMinor: null,
    reservedBookingCount: null,
    asOfIso: asOf.toISOString(),
  });

  return { ok: false, reason: 'unfunded', canManageBilling };
}

/** The two balance refusals: D6.1's hold and D6.5's reservation. */
type BalanceRefusal =
  | {
      readonly blockKind: 'account_on_hold';
      /** `null` ⇒ the failed-heal fallback. */
      readonly topUpNeededMinor: number | null;
      readonly asOf: Date;
    }
  | {
      readonly blockKind: 'reserved_by_upcoming';
      readonly topUpNeededMinor: number;
      readonly reservedBookingCount: number;
      readonly asOf: Date;
    };

/**
 * The balance outcome (D6.1 / D6.5): resolve the capability and the company, log the figures
 * (the only place they are logged), fan out, and return the refusal. Runs OUTSIDE the verdict's
 * try/catch, like {@link refuseUnfunded}.
 */
async function refuseOnBalance(
  input: EnforceBookingFundingInput,
  refusal: BalanceRefusal
): Promise<BookingFundingResult> {
  const canManageBilling = await resolveCanManageBilling(input);
  const billingCompany = await resolveBillingCompany(input);
  const reservedBookingCount =
    refusal.blockKind === 'reserved_by_upcoming' ? refusal.reservedBookingCount : null;

  log.warn('Booking refused before any write — balance pre-condition unmet', {
    userId: input.actorUserId,
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    blockKind: refusal.blockKind,
    canManageBilling,
    topUpNeededMinor: refusal.topUpNeededMinor,
    reservedBookingCount,
  });

  await publishFundingBlocked(input, {
    reason: refusal.blockKind,
    blockKind: refusal.blockKind,
    canManageBilling,
    topUpNeededMinor: refusal.topUpNeededMinor,
    reservedBookingCount,
    asOfIso: refusal.asOf.toISOString(),
  });

  if (refusal.blockKind === 'reserved_by_upcoming') {
    return {
      ok: false,
      reason: 'reserved',
      canManageBilling,
      billingCompany,
      topUpNeededMinor: refusal.topUpNeededMinor,
      reservedBookingCount: refusal.reservedBookingCount,
    };
  }
  return {
    ok: false,
    reason: 'on_hold',
    canManageBilling,
    billingCompany,
    topUpNeededMinor: refusal.topUpNeededMinor,
  };
}

/**
 * A hold whose debt the balance already covers. `'defer'` ⇒ the booking goes on to the API,
 * which heals the hold under the wallet lock and re-runs the verdict. `'refuse'` ⇒ the API
 * answered `account_on_hold` and this snapshot STILL sees a covered hold: the heal failed, so
 * the refusal is the no-figure fallback.
 */
async function settleCoveredHold(
  input: EnforceBookingFundingInput,
  asOf: Date
): Promise<BookingFundingResult> {
  if (input.onCoveredHold === 'defer') {
    log.info('A covered hold is still open — the booking API heals it before booking', {
      userId: input.actorUserId,
      companyId: input.companyId,
    });
    return { ok: true };
  }
  log.warn('A covered hold could not be cleared by the booking API — showing the fallback', {
    userId: input.actorUserId,
    companyId: input.companyId,
  });
  return refuseOnBalance(input, { blockKind: 'account_on_hold', topUpNeededMinor: null, asOf });
}

/** Map one verdict onto the gate's result, running the refusal's side effects. */
async function settleVerdict(
  input: EnforceBookingFundingInput,
  verdict: CaseBookingFundingVerdict,
  asOf: Date
): Promise<BookingFundingResult> {
  if (verdict.ok) {
    if (verdict.arm === 'rate_missing') {
      // A rate-less expert is NOT a funding refusal. The balance arm is unevaluable, so the gate
      // passes rather than blaming the client for the expert's misconfiguration. That condition
      // already has an owner (the expert checklist + admission's `expert_rate_missing` alarm).
      log.warn('Booking funding pre-check skipped — expert has no rate', {
        userId: input.actorUserId,
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
      });
    }
    return { ok: true };
  }
  if (verdict.reason === 'reserved_by_upcoming') {
    return refuseOnBalance(input, {
      blockKind: 'reserved_by_upcoming',
      topUpNeededMinor: verdict.topUpNeededMinor,
      reservedBookingCount: verdict.reservedBookingCount,
      asOf,
    });
  }
  if (verdict.reason === 'no_mandate_insufficient_balance') {
    return refuseUnfunded(
      input,
      'no_mandate_insufficient_balance',
      asOf,
      verdict.estimateMinor,
      verdict.availableMinor
    );
  }
  if (verdict.reason === 'account_on_hold') {
    return refuseOnBalance(input, {
      blockKind: 'account_on_hold',
      topUpNeededMinor: verdict.hold.amountToClearMinor,
      asOf,
    });
  }
  if (verdict.reason === 'covered_hold') {
    return settleCoveredHold(input, asOf);
  }
  if (verdict.reason === 'no_wallet') {
    return refuseUnfunded(input, 'no_wallet', asOf);
  }
  // An UNKNOWN, client-supplied `expertProfileId` is NOT the same condition as a known expert who
  // simply has no rate set: it has no owner, and there is no reason to let an unfunded company
  // hold a slot against an id that names nothing. Fail closed.
  log.warn('Booking funding pre-check found no matching expert profile — failing CLOSED', {
    userId: input.actorUserId,
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
  });
  return { ok: false, reason: 'unavailable' };
}

export async function enforceBookingFunding(
  input: EnforceBookingFundingInput
): Promise<BookingFundingResult> {
  const outcome = await resolveFundingVerdict(input);
  if (outcome.kind === 'unavailable') {
    return { ok: false, reason: 'unavailable' };
  }
  return settleVerdict(input, outcome.verdict, outcome.asOf);
}
