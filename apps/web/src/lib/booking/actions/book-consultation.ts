'use server';
import 'server-only';

import { z } from 'zod';
import {
  auditEventsRepository,
  caseEngagementsRepository,
  companiesRepository,
  meetingsRepository,
  partyMembershipsRepository,
  referenceDataRepository,
  isUniqueViolation,
} from '@balo/db';
import {
  bookingReplayWindowMatches,
  classifyBookingReplay,
  type BookingReplayClassification,
  type BookingReplayProbe,
} from '@balo/shared/meetings';
import { CAPABILITIES } from '@/lib/authz';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { deriveBookingIdempotencyKey } from '../booking-idempotency';
import { bookingSlotSchema, MS_PER_MINUTE } from '../booking-slot-schema';
import { sanitizeCaseDescription } from '../sanitize-case-description';
import { authorizeCaseAttach } from '../authorize-case-attach';
import {
  enforceBookingFunding,
  type BookingFundingRefusal,
  type EnforceBookingFundingInput,
} from '../booking-funding-gate';
import { resolveBookingExpertDisplay } from '../load-booking-context';
import {
  isBookingFundingRefusalCode,
  postBookMeeting,
  postInviteGuests,
  type BookingApiResult,
  type BookMeetingResponse,
  type BookingFundingRefusalCode,
} from '../booking-api-client';
import { isExpiredCredentialFailure, viewerApiCredentialIsLive } from '@/lib/api/balo-api-client';
import type {
  BookConsultationInput,
  BookConsultationResult,
  BookingFailureCode,
  BookingStage,
} from './types';

/**
 * BAL-400 — `bookConsultationAction`, the two-hop booking orchestration (Decisions 1/3/4/5/6/7).
 *
 * ⚠⚠ THE MONEY IS READ-ONLY (D1, NARROWED BY BAL-478 AND BAL-474). This action still never
 * calls `openSession`, never places a hold, and renders no rate (D4c). What it carries is ONE
 * READ-ONLY, ADVISORY PRE-CONDITION: before the first write, `enforceBookingFunding` runs the
 * ONE booking verdict (`assessCaseBookingFunding`) over the ONE funding snapshot — an open
 * receivable refuses (D6.1), an active mandate or enough available credit funds, and a company
 * without a mandate has its planned consultations set aside first (D6.5). After ADR-1040
 * Amendment 7 admission no longer enforces funding: the presence seam's open is
 * overdraft-tolerant. So this gate is advisory (unlocked reads, check-time), `POST /meetings`
 * re-checks the same verdict as defence in depth, and a shortfall that slips past both is
 * billed session-scoped into a receivable, which then brakes the next booking. The only money
 * figure a client sees from this flow is the top-up amount on the balance panels.
 *
 * TWO NON-ATOMIC HOPS: a `@balo/db` write (open or attach a case) THEN a Bearer hop to
 * `POST /meetings`. A hop-2 failure leaves a real, zero-consultation case — an ACCEPTABLE
 * resting state (D4b; ADR-1045). We never soft-delete the engagement and never publish
 * `booking.confirmed` on that path. "Try again" resubmits with the SAME `bookingNonce`, so
 * the SAME idempotency key re-enters against the case that already exists (case-grain
 * replay below) rather than minting a second one.
 */

const MAX_PRODUCTS = 39;
const MAX_GUESTS = 8;

/**
 * S4 — a DoS guard, not the UX limit, exactly as the shipped project-request precedent states
 * (`lib/project-request/actions/schemas.ts`, same 20 000). Every other field in this schema was
 * already bounded; this one was not, and `sanitizeCaseDescription` runs a full `sanitize-html`
 * parse synchronously on the Next server before anything else looks at the value.
 */
const MAX_DESCRIPTION_HTML = 20_000;

/**
 * S6 — the per-user hourly cap on HOP 1, mirroring `apps/api`'s `BOOKING_USER_RATE_LIMIT`
 * (30/hour) so the two hops are bounded alike. Counted over `engagement.created` audit rows,
 * because `apps/web` has no Redis. See `auditEventsRepository.countByActorAndActionSince` for
 * why a counter (not a reservation) is the right trade here.
 *
 * ⚠ N2 (reverify round 3) — SCOPED TO CASES ONLY. `engagement.created` is emitted by every
 * engagement-creation path (case bookings AND project kickoffs — `_shared/delivery-audit.ts`),
 * so counting the bare action would let a burst of approved project kickoffs consume a client's
 * CASE-booking budget with no case involved. `enforceCaseCreateRateLimit` passes
 * `engagementType: 'case'`, which filters on `metadata.engagement_type` — this budget covers
 * ONLY hop-1 case creation, never project work.
 */
const CASE_CREATE_MAX_PER_WINDOW = 30;
const CASE_CREATE_WINDOW_MS = 3_600_000;

const caseChoiceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      title: z.string().trim().min(1).max(160),
      descriptionHtml: z.string().max(MAX_DESCRIPTION_HTML),
      productIds: z.array(z.string().uuid()).max(MAX_PRODUCTS),
      companyId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('existing'),
      engagementId: z.string().uuid(),
    })
    .strict(),
]);

/**
 * ⚠⚠ THE SLOT WINDOW MUST *AGREE* WITH `durationMinutes` (fix round: B1, external review of
 * PR #333) — enforced by `bookingSlotSchema`, extracted to `../booking-slot-schema` in fix
 * round 3 so this SECURITY CHECK cannot diverge from `book-intro-call.ts`'s identical one. See
 * that module's docblock for the full rationale. Before it existed here, `durationMinutes` was
 * checked against the duration ladder and then consumed by TWO DIFFERENT DOWNSTREAM STEPS that
 * never cross-checked it against the window: `enforceBookingFunding` sized the estimate from
 * `durationMinutes`, while the meeting is booked — and admission later re-estimates — from
 * `slot.startIso`/`slot.endIso`. A crafted submit declaring `durationMinutes: 15` against a
 * 3-hour window passed the balance arm on a fraction of the funds, then booked the full window
 * — precisely the unbilled consultation this ticket exists to prevent. The gate now derives its
 * estimate from the slot WINDOW (`estimatedMinutesForWindow`, the same figure the API and
 * admission compute), and this schema still refuses a declared duration that disagrees with it.
 */
const bookConsultationSchema = z
  .object({
    expertProfileId: z.string().uuid(),
    slot: bookingSlotSchema,
    bookingNonce: z.string().uuid(),
    guests: z
      .array(
        z
          .object({
            email: z.string().trim().toLowerCase().email(),
            name: z.string().trim().min(1).max(120).optional(),
          })
          .strict()
      )
      .max(MAX_GUESTS),
    caseChoice: caseChoiceSchema,
  })
  .strict();

type ValidatedInput = z.infer<typeof bookConsultationSchema>;
type NewCaseChoice = Extract<ValidatedInput['caseChoice'], { kind: 'new' }>;

/**
 * ⚠⚠ THE SERVER-RESOLVED CASE IDENTITY — the ONLY identity anything downstream of
 * {@link resolveCase} may use (S1/M5).
 *
 * `expertProfileId` is read off the `engagements` ROW, never off the request. The client's
 * claimed `expertProfileId` is an INPUT to the gate and nothing more: it is what
 * `authorizeCaseAttach` compares the row against, and once that comparison has passed there is
 * no reason for any later line to look at it again. Reading it again is precisely how a
 * `booking.confirmed` payload came to name an expert who was not party to the booking — a
 * Balo-branded email, with a live `meetingId`, delivered to an arbitrary marketplace expert.
 */
interface ResolvedCase {
  readonly engagementId: string;
  readonly companyId: string;
  readonly expertProfileId: string;
  readonly title: string;
  readonly isNewCase: boolean;
}

type CaseResolution =
  | { readonly ok: true; readonly resolved: ResolvedCase }
  | { readonly ok: false; readonly result: BookConsultationResult & { ok: false } };

/** A `stage`/`code` rejection, in the shape `resolveCase` hands back. */
function caseFailure(
  stage: BookingStage,
  code: BookingFailureCode
): { readonly ok: false; readonly result: BookConsultationResult & { ok: false } } {
  return { ok: false, result: { ok: false, stage, code } };
}

type FundingRefusalSite =
  | { readonly stage: 'funding' }
  | { readonly stage: 'meeting'; readonly engagementId: string; readonly caseTitle: string };

/**
 * A determined funding refusal, as a `BookConsultationResult`. `stage: 'funding'` is the web
 * gate's own refusal (before any write); `stage: 'meeting'` is a refusal the API's pre-write
 * guard answered at the meeting hop — the case row already exists, so `engagementId` /
 * `caseTitle` ride along and the panel can say the case is saved.
 *
 * The CODE encodes the actor's capability (`*_top_up_required` ⇒ MANAGE_BILLING, so they can act;
 * `*_admins_notified` ⇒ they cannot, and the gate's fan-out already told the billing admins).
 */
function fundingRefusalFailure(
  refusal: BookingFundingRefusal,
  site: FundingRefusalSite
): BookConsultationResult & { ok: false } {
  const where =
    site.stage === 'funding'
      ? { stage: 'funding' as const }
      : { stage: 'meeting' as const, engagementId: site.engagementId, caseTitle: site.caseTitle };
  if (refusal.reason === 'unfunded') {
    return {
      ok: false,
      ...where,
      code: refusal.canManageBilling ? 'funding_setup_required' : 'funding_admins_notified',
    };
  }
  if (refusal.reason === 'on_hold') {
    return {
      ok: false,
      ...where,
      code: refusal.canManageBilling ? 'hold_top_up_required' : 'hold_admins_notified',
      balance: {
        variant: 'hold',
        topUpNeededMinor: refusal.topUpNeededMinor,
        reservedBookingCount: null,
        company: refusal.billingCompany,
      },
    };
  }
  return {
    ok: false,
    ...where,
    code: refusal.canManageBilling ? 'reserved_top_up_required' : 'reserved_admins_notified',
    balance: {
      variant: 'reserved',
      topUpNeededMinor: refusal.topUpNeededMinor,
      reservedBookingCount: refusal.reservedBookingCount,
      company: refusal.billingCompany,
    },
  };
}

/** Resolve which company bills this booking (Decision 5's fail-closed IDOR guard). */
async function resolveBillingCompanyId(
  userId: string,
  requestedCompanyId: string | undefined
): Promise<
  | { ok: true; companyId: string }
  | {
      ok: false;
      code: 'no_eligible_company' | 'company_selection_required' | 'company_not_eligible';
    }
> {
  const eligible = await partyMembershipsRepository.listCapabilityEligibleCompanies(
    userId,
    CAPABILITIES.CONSUME_CREDITS
  );
  if (eligible.length === 0) {
    return { ok: false, code: 'no_eligible_company' };
  }
  if (eligible.length > 1) {
    if (requestedCompanyId === undefined) {
      return { ok: false, code: 'company_selection_required' };
    }
    const match = eligible.find((company) => company.id === requestedCompanyId);
    if (match === undefined) {
      return { ok: false, code: 'company_not_eligible' };
    }
    return { ok: true, companyId: match.id };
  }
  const [only] = eligible;
  if (only === undefined) {
    // Unreachable (length === 1 above), guarded rather than asserted for
    // `noUncheckedIndexedAccess`.
    return { ok: false, code: 'no_eligible_company' };
  }
  return { ok: true, companyId: only.id };
}

/**
 * S5 — reject `productIds` that are not in the live taxonomy, BEFORE the insert, exactly as
 * the shipped `submit-project-request.ts` does and for the reason it states: unknown ids are
 * rejected rather than silently dropped, which surfaces tampering and keeps the junction's
 * `restrict` FK from ever firing. `caseEngagementsRepository.create`'s own docblock already
 * assumes this ("the caller is validating against a taxonomy it just rendered") — without it a
 * tampered submit 23503s inside the transaction and rolls the WHOLE case back with an
 * unexplained failure.
 *
 * FAILS CLOSED on a taxonomy read error: a booking whose tags cannot be verified is refused,
 * not tagged on trust.
 */
async function validateProductIds(
  userId: string,
  productIds: readonly string[]
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: BookingFailureCode }> {
  if (productIds.length === 0) {
    return { ok: true };
  }
  try {
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const categories = await referenceDataRepository.getProductsByVertical(vertical.id);
    const allowed = new Set(categories.flatMap((c) => c.products.map((p) => p.id)));
    const unknown = productIds.filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      log.warn('Booking rejected — unknown product ids', { userId, unknownCount: unknown.length });
      return { ok: false, code: 'invalid_request' };
    }
    return { ok: true };
  } catch (error) {
    log.error('Product taxonomy read failed during booking', {
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'booking_failed' };
  }
}

/**
 * S6 — bound HOP 1. `POST /meetings` is rate limited per-user and per-(user, expert); this
 * Server Action was not, and it does its most expensive work (an engagements row, a
 * case_engagements row, up to 39 product rows, an audit row and a conversation thread) BEFORE
 * reaching the API — against any `expert_profiles.id` the caller names, with a ratified
 * resting state of "leave the orphan" (D4b).
 *
 * ⚠ ONLY THE CREATE PATH IS COUNTED. A replay or an attach writes no engagement, so neither
 * consumes budget and neither can be blocked by it — a user at their cap can still retry a
 * booking they have already started, which is exactly the path the idempotency key exists for.
 *
 * ⚠ N2 (reverify round 3) — ONLY CASE CREATES ARE COUNTED. `engagement.created` is emitted by
 * BOTH case bookings and project kickoffs (`_shared/delivery-audit.ts`'s `recordEngagementCreated`
 * — the action is deliberately type-agnostic; the product is distinguished by
 * `metadata.engagement_type`). Without the `engagementType: 'case'` filter below, a client who
 * approves many project kickoffs in an hour would be refused their next CASE booking for a budget
 * project work never touched. The filter scopes the count to hop-1 case creation only, so this
 * budget is never shared with project work.
 *
 * ⚠ FAILS CLOSED on a read error, matching `apps/api`'s limiter (which answers `503` rather
 * than "carry on unlimited"). A booking whose budget cannot be checked is refused.
 */
async function enforceCaseCreateRateLimit(
  userId: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: BookingFailureCode }> {
  try {
    const recent = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: userId,
      action: 'engagement.created',
      engagementType: 'case',
      since: new Date(Date.now() - CASE_CREATE_WINDOW_MS),
    });
    if (recent >= CASE_CREATE_MAX_PER_WINDOW) {
      log.warn('Booking rate-limited at the case hop', { userId, recent });
      return { ok: false, code: 'rate_limited' };
    }
    return { ok: true };
  } catch (error) {
    log.error('Booking rate-limit read failed — failing CLOSED', {
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'booking_failed' };
  }
}

/**
 * ⚠⚠ THE GATED CASE-GRAIN REPLAY (S1/M5). A `bookingIdempotencyKey` is `sha256(userId:nonce)`
 * and `nonce` is CLIENT-SUPPLIED, so a key proves only WHO MINTED IT — never that the case it
 * names is one this submit may book against. Before this gate existed, re-submitting a spent
 * nonce with a DIFFERENT claimed expert returned the case with no capability check, no company
 * check and no expert check, and the notification that followed was built from the client's
 * claim.
 *
 * The fix is not a bespoke check: it is `authorizeCaseAttach` — the SAME gate, in the SAME
 * order (authorize on the row's own company FIRST, then coherence), collapsing to the SAME
 * `case_not_available` literal. One extra by-id read on a path that only runs on a retry, in
 * exchange for the two arms being unable to drift apart.
 *
 * Used for the 23505 re-read too: a racing request wrote that row, so it is no more trusted
 * than any other row found by key.
 */
async function resolveExistingCaseByKey(
  userId: string,
  key: string,
  claimedExpertProfileId: string
): Promise<
  | { readonly kind: 'none' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'resolved'; readonly resolved: ResolvedCase }
> {
  const existing = await caseEngagementsRepository.findByBookingIdempotencyKey(key);
  if (existing === undefined) {
    return { kind: 'none' };
  }
  const attach = await authorizeCaseAttach({
    actorUserId: userId,
    engagementId: existing.id,
    expertProfileId: claimedExpertProfileId,
  });
  if (!attach.ok) {
    return { kind: 'denied' };
  }
  return {
    kind: 'resolved',
    resolved: {
      engagementId: attach.engagementId,
      companyId: attach.companyId,
      // ⚠ THE ROW'S expert, not `claimedExpertProfileId`.
      expertProfileId: attach.expertProfileId,
      title: attach.title,
      // This key DID open a case — a replay of a create is still a create.
      isNewCase: true,
    },
  };
}

/**
 * The 'new' arm's create-path error handler: a concurrent double-submit racing the SAME
 * idempotency key surfaces as a unique violation, which we resolve by re-reading (through the
 * gate) rather than guessing. Extracted from `writeCase` purely to keep that function's own
 * cognitive complexity under the SonarCloud ceiling — behavior is unchanged.
 */
async function handleCaseCreateError(
  error: unknown,
  userId: string,
  key: string,
  claimedExpertProfileId: string
): Promise<CaseResolution> {
  if (isUniqueViolation(error)) {
    const reRead = await resolveExistingCaseByKey(userId, key, claimedExpertProfileId);
    if (reRead.kind === 'resolved') {
      return { ok: true, resolved: reRead.resolved };
    }
    if (reRead.kind === 'denied') {
      return caseFailure('case', 'case_not_available');
    }
    log.error('Idempotent case re-read failed after unique violation', {
      userId,
      expertProfileId: claimedExpertProfileId,
    });
    return caseFailure('case', 'booking_failed');
  }
  log.error('Case creation failed', {
    userId,
    expertProfileId: claimedExpertProfileId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return caseFailure('case', 'booking_failed');
}

/** What the booking WILL do once funding is proven. Nothing here has been written. */
type CasePlan =
  | { readonly kind: 'existing'; readonly resolved: ResolvedCase }
  | {
      readonly kind: 'create';
      readonly companyId: string;
      readonly expertProfileId: string;
      readonly title: string;
      readonly descriptionHtml: string; // already sanitized
      readonly productIds: readonly string[];
    };

type CasePlanResult =
  | { readonly ok: true; readonly plan: CasePlan }
  | { readonly ok: false; readonly result: BookConsultationResult & { ok: false } };

/**
 * The (company, expert) pair the funding gate evaluates. On the `existing` arm it is the ROW's
 * own expert (S1/M5), never the request's claim; on the `create` arm it is the id the row is
 * about to be written with. `authorizeCaseAttach`'s `expert_mismatch` denial makes the two
 * byte-equal on every reachable path — this function exists so the gate is never the place
 * that has to know that.
 */
function planFundingSubject(plan: CasePlan): { companyId: string; expertProfileId: string } {
  if (plan.kind === 'existing') {
    return { companyId: plan.resolved.companyId, expertProfileId: plan.resolved.expertProfileId };
  }
  return { companyId: plan.companyId, expertProfileId: plan.expertProfileId };
}

/** The 'new' arm's PRE-WRITE half: bound, resolve the company, sanitize, validate. NO WRITE. */
async function planNewCase(
  userId: string,
  claimedExpertProfileId: string,
  choice: NewCaseChoice
): Promise<CasePlanResult> {
  const limit = await enforceCaseCreateRateLimit(userId);
  if (!limit.ok) {
    return caseFailure('case', limit.code);
  }

  const companyResult = await resolveBillingCompanyId(userId, choice.companyId);
  if (!companyResult.ok) {
    return caseFailure('company', companyResult.code);
  }

  const sanitized = sanitizeCaseDescription(choice.descriptionHtml);
  if (!sanitized.ok) {
    return caseFailure('validation', 'invalid_request');
  }

  const products = await validateProductIds(userId, choice.productIds);
  if (!products.ok) {
    return caseFailure('validation', products.code);
  }

  return {
    ok: true,
    plan: {
      kind: 'create',
      companyId: companyResult.companyId,
      expertProfileId: claimedExpertProfileId,
      title: choice.title,
      descriptionHtml: sanitized.html,
      productIds: choice.productIds,
    },
  };
}

/** The 'new' arm's ONLY write. Unchanged body: `caseEngagementsRepository.create` + log + handler. */
async function writeCase(
  userId: string,
  key: string,
  plan: Extract<CasePlan, { kind: 'create' }>
): Promise<CaseResolution> {
  try {
    const created = await caseEngagementsRepository.create({
      companyId: plan.companyId,
      expertProfileId: plan.expertProfileId,
      title: plan.title,
      description: plan.descriptionHtml,
      actorUserId: userId,
      bookingIdempotencyKey: key,
      productIds: plan.productIds,
    });
    log.info('Case opened at booking', {
      engagementId: created.id,
      companyId: created.companyId,
      expertProfileId: created.expertProfileId,
    });
    return {
      ok: true,
      resolved: {
        engagementId: created.id,
        companyId: created.companyId,
        // ⚠ OFF THE ROW the transaction returned, not off the request.
        expertProfileId: created.expertProfileId,
        title: created.title,
        isNewCase: true,
      },
    };
  } catch (error) {
    return handleCaseCreateError(error, userId, key, plan.expertProfileId);
  }
}

/**
 * ⚠⚠ THE PRE-WRITE HALF OF CASE RESOLUTION. Every arm here resolves an identity and WRITES
 * NOTHING — that is what makes ONE funding gate (in `resolveCase` below) able to cover all
 * three arms with a single call site instead of three copies of the rule.
 */
async function planCase(
  userId: string,
  key: string,
  input: ValidatedInput
): Promise<CasePlanResult> {
  if (input.caseChoice.kind === 'existing') {
    const attach = await authorizeCaseAttach({
      actorUserId: userId,
      engagementId: input.caseChoice.engagementId,
      expertProfileId: input.expertProfileId,
    });
    if (!attach.ok) {
      return caseFailure('case', attach.code);
    }
    return {
      ok: true,
      plan: {
        kind: 'existing',
        resolved: {
          engagementId: attach.engagementId,
          companyId: attach.companyId,
          expertProfileId: attach.expertProfileId,
          title: attach.title,
          isNewCase: false,
        },
      },
    };
  }

  // Case-grain idempotent replay (Decision 1), GATED (S1/M5). Only the 'new' arm needs it —
  // the attach arm creates no row, so a retry re-enters at the meeting hop with the same
  // `engagementId`.
  const replay = await resolveExistingCaseByKey(userId, key, input.expertProfileId);
  if (replay.kind === 'denied') {
    return caseFailure('case', 'case_not_available');
  }
  if (replay.kind === 'resolved') {
    return { ok: true, plan: { kind: 'existing', resolved: replay.resolved } };
  }

  return planNewCase(userId, input.expertProfileId, input.caseChoice);
}

/**
 * ⚠⚠ THE WEB MIRROR OF THE API'S REPLAY PROBE (D7.7, D8.6). Classifies what `key` already names
 * with the SAME two reads and the SAME pure classifier (`classifyBookingReplay`,
 * `@balo/shared/meetings`) `POST /meetings` uses — window first (no second read when it
 * disagrees), then the meeting's contexts. There is ONE definition of "this key names this
 * booking"; a second, drifting copy is how a web gate would refuse a retry the API replays.
 *
 * ⚠ FAILS TOWARDS THE GATES. A read failure is `none` (logged `warn`): the funding gates then
 * run, the fail-closed direction. A lost-201 retry that hits a transient read blip is at worst
 * asked to retry, never waved through.
 */
async function classifyBookingKey(
  key: string,
  probe: BookingReplayProbe
): Promise<BookingReplayClassification> {
  try {
    const existing = await meetingsRepository.findByBookingIdempotencyKey(key);
    if (existing === undefined) {
      return 'none';
    }
    if (!bookingReplayWindowMatches(existing, probe)) {
      return 'conflict';
    }
    const withContexts = await meetingsRepository.findWithContexts(existing.id);
    return classifyBookingReplay(
      {
        scheduledStart: existing.scheduledStart,
        scheduledEnd: existing.scheduledEnd,
        contexts: withContexts?.contexts ?? [],
      },
      probe
    );
  } catch (error) {
    log.warn('Booking key classification read failed — running the funding gates', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'none';
  }
}

/**
 * ⚠⚠ A KEY THAT ALREADY NAMES A MEETING SKIPS EVERY WEB FUNDING GATE (D7.7). A `match` is a
 * lost-201 retry of a booking that already exists: it must never read a hold or a reservation,
 * and can never reserve against its own meeting (which is `scheduled` and sessionless, so it
 * WOULD be counted). A `conflict` skips them too, because the API answers
 * `409 idempotency_key_conflict` BEFORE its own funding guard — so a mismatched key gets the
 * conflict answer, never a funding panel or a billing-admin notice. Only the `existing` plan can
 * carry a used key: a new-case plan has no case row yet.
 */
async function bookingKeyAlreadyNamesAMeeting(
  userId: string,
  key: string,
  slot: ValidatedInput['slot'],
  resolved: ResolvedCase
): Promise<boolean> {
  const replay = await classifyBookingKey(key, {
    contextType: 'case',
    contextId: resolved.engagementId,
    scheduledStart: new Date(slot.startIso),
    scheduledEnd: new Date(slot.endIso),
  });
  if (replay === 'none') {
    return false;
  }
  log.info(
    'Booking key already names a meeting — web funding gates skipped; the API replays or refuses it',
    { userId, engagementId: resolved.engagementId, replay }
  );
  return true;
}

/**
 * ⚠⚠ THE FUNDING GATE'S ONE CALL SITE (BAL-478 / R1). Both company sources reach it:
 * `resolveBillingCompanyId` (the new-case arm, via `planNewCase`) and `authorizeCaseAttach`
 * (the existing + replay arms). It runs AFTER every cheap validation — so a rate-limited or
 * malformed submit is not reported as a funding problem, and a doomed submit never publishes a
 * notice to billing admins — and BEFORE `writeCase`, the module's ONLY write. A refusal below
 * therefore leaves no case row, no engagement, no meeting: the same invariant
 * `viewerApiCredentialIsLive()` states at `bookConsultationAction`'s own pre-flight.
 *
 * `onCoveredHold: 'defer'`: a hold the balance already covers is healed by the API's guard at the
 * meeting hop, never refused here (see `completeBooking` for the one `'refuse'` re-run).
 */
async function resolveCase(
  userId: string,
  activeCompanyId: string,
  key: string,
  input: ValidatedInput
): Promise<CaseResolution> {
  const planned = await planCase(userId, key, input);
  if (!planned.ok) return { ok: false, result: planned.result };

  if (
    planned.plan.kind === 'existing' &&
    (await bookingKeyAlreadyNamesAMeeting(userId, key, input.slot, planned.plan.resolved))
  ) {
    return { ok: true, resolved: planned.plan.resolved };
  }

  const subject = planFundingSubject(planned.plan);
  const funding = await enforceBookingFunding({
    actorUserId: userId,
    companyId: subject.companyId,
    expertProfileId: subject.expertProfileId,
    slot: { startIso: input.slot.startIso, endIso: input.slot.endIso },
    activeCompanyId,
    onCoveredHold: 'defer',
  });
  if (!funding.ok) {
    if (funding.reason === 'unavailable') return caseFailure('case', 'booking_failed');
    return { ok: false, result: fundingRefusalFailure(funding, { stage: 'funding' }) };
  }

  if (planned.plan.kind === 'existing') return { ok: true, resolved: planned.plan.resolved };
  return writeCase(userId, key, planned.plan);
}

/**
 * S2 — the duration OF THE MEETING, derived from the server's own window rather than from the
 * client's declared `durationMinutes`. Both `postBookMeeting` (which rejects an unparseable
 * instant) and `POST /meetings`' own window validation stand behind this, so the arithmetic
 * cannot go negative in practice; `Math.max` is a floor, not a fallback.
 */
function windowMinutes(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / MS_PER_MINUTE));
}

/** How many LIVE consultations this case had BEFORE this booking — 0 for a brand-new case. */
/**
 * How many consultations this case had BEFORE this booking — the "N consultations so far"
 * line in the expert's email. `0` for a new case.
 *
 * ⚠ CALLED **AFTER** THE MEETING HOP, AND SUBTRACTS ONE. `consultationCount` counts LIVE
 * MEETINGS through the `meeting_contexts` reverse edge, and by the time `POST /meetings` has
 * returned 201 the meeting written in this booking's own transaction is already included. So
 * the count here is always `prior + 1`, and the honest answer is one less.
 *
 * Reading it BEFORE the hop looks equivalent and is not: on a lost-201 retry the FIRST
 * attempt's meeting already exists, so a pre-hop read returns `prior + 1` and the email
 * over-counts by one. Subtracting after is correct on BOTH paths — a fresh booking and a
 * replay each have exactly one meeting of their own in the count. (The `correlationId` dedup
 * usually suppresses that second email anyway, which is what made this cosmetic rather than
 * visible; "usually" is not a guarantee, so the number is made right at the source.)
 *
 * Moving the read here also drops it entirely off the failure paths above, which never publish.
 */
async function resolvePriorConsultationCount(
  isNewCase: boolean,
  companyId: string,
  expertProfileId: string,
  engagementId: string
): Promise<number> {
  if (isNewCase) {
    return 0;
  }
  try {
    const { openCases } = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId,
    });
    const countIncludingThisBooking =
      openCases.find((c) => c.engagementId === engagementId)?.consultationCount ?? 0;
    // `Math.max` guards the theoretical case where the projection has not caught up; a
    // negative count would render as "-1 consultations so far".
    return Math.max(0, countIncludingThisBooking - 1);
  } catch (error) {
    log.warn('Prior consultation count unavailable; defaulting to 0', {
      engagementId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * ⚠⚠ THE API'S PRE-WRITE FUNDING GUARD ANSWERED AT THE MEETING HOP. `POST /meetings` refused
 * before writing anything — but the case row this booking created (or attached to) at hop 1
 * already exists. The web gate is re-run FRESH, so the panel is built from a current snapshot (a
 * receivable that opened between the gate and hop 2 reaches the panel with a real figure) and
 * the billing-admin fan-out is published by the one place that publishes it.
 *
 *  - The re-run agrees ⇒ the refusal's panel, at `stage: 'meeting'`, carrying the case title.
 *  - The re-run passes, or is `unavailable` ⇒ the refusal did not reproduce. A generic
 *    `booking_failed` (the "case saved" partial panel) is the truthful answer; nothing is
 *    published, and no figure is invented.
 *
 * `onCoveredHold`: `'refuse'` only after `account_on_hold`. If the web STILL sees a covered hold
 * then, the API's locked heal failed — the one state that renders the failed-heal fallback.
 */
async function refuseAtMeetingHop(params: {
  readonly funding: Omit<EnforceBookingFundingInput, 'onCoveredHold'>;
  readonly code: BookingFundingRefusalCode;
  readonly engagementId: string;
  readonly caseTitle: string;
}): Promise<BookConsultationResult & { ok: false }> {
  const { funding, code, engagementId, caseTitle } = params;
  const again = await enforceBookingFunding({
    ...funding,
    onCoveredHold: code === 'account_on_hold' ? 'refuse' : 'defer',
  });
  if (again.ok || again.reason === 'unavailable') {
    log.warn('Hop-2 funding refusal did not reproduce at the web gate — generic retry', {
      code,
      engagementId,
      companyId: funding.companyId,
    });
    return { ok: false, stage: 'meeting', code: 'booking_failed', engagementId, caseTitle };
  }
  return fundingRefusalFailure(again, { stage: 'meeting', engagementId, caseTitle });
}

/**
 * Every `POST /meetings` failure, classified. Kept out of `completeBooking` so that function
 * holds the happy path. Each arm resolves a `BookConsultationResult`; none throws.
 */
async function mapMeetingHopFailure(params: {
  readonly booked: Extract<BookingApiResult<BookMeetingResponse>, { ok: false }>;
  readonly userId: string;
  readonly key: string;
  readonly activeCompanyId: string;
  readonly resolved: ResolvedCase;
  readonly slot: ValidatedInput['slot'];
}): Promise<BookConsultationResult & { ok: false }> {
  const { booked, userId, key, activeCompanyId, resolved, slot } = params;
  const { engagementId, companyId, expertProfileId, title: caseTitle } = resolved;

  if (booked.code === 'window_not_available') {
    return { ok: false, stage: 'meeting', code: 'slot_unavailable', engagementId, caseTitle };
  }
  if (booked.code === 'idempotency_key_conflict') {
    return {
      ok: false,
      stage: 'meeting',
      code: 'idempotency_key_conflict',
      engagementId,
      caseTitle,
    };
  }
  // ⚠ A dead credential is not a booking failure. Rare, since the pre-flight gate catches it
  // first, but the partial-failure panel's "Try again" would re-send the same dead token
  // forever. Classified before the catch-all so the client can offer sign-in instead.
  if (isExpiredCredentialFailure(booked.status, booked.code)) {
    return { ok: false, stage: 'meeting', code: 'session_expired', engagementId, caseTitle };
  }
  // The API's own pre-write funding guard (defence in depth). `booking_funding_unavailable` (503)
  // is deliberately NOT handled here: the API could not read funding and failed closed, and the
  // catch-all below turns that into the generic `booking_failed` with nothing notified.
  if (isBookingFundingRefusalCode(booked.code)) {
    return refuseAtMeetingHop({
      funding: {
        actorUserId: userId,
        companyId,
        expertProfileId,
        slot: { startIso: slot.startIso, endIso: slot.endIso },
        activeCompanyId,
      },
      code: booked.code,
      engagementId,
      caseTitle,
    });
  }
  // Decision 3 — accept the orphan. The case is NOT deleted; "Try again" re-enters via the
  // case-grain replay above.
  log.error('Booking meeting hop failed after case create', {
    engagementId,
    bookingIdempotencyKey: key,
    expertProfileId,
    status: booked.status,
    code: booked.code,
  });
  return { ok: false, stage: 'meeting', code: 'booking_failed', engagementId, caseTitle };
}

/**
 * ⚠⚠ EVERYTHING AFTER THE CASE IS RESOLVED, IN A SCOPE THAT CANNOT SEE THE REQUEST'S CLAIMED
 * EXPERT (S1/M5). `resolved.expertProfileId` — read off the `engagements` row by
 * {@link resolveCase} — is the ONLY expert identity in scope here. That is the structural
 * half of the fix: the minimal patch (gate the replay) closes today's hole, but only removing
 * `input.expertProfileId` from this scope stops a future edit reintroducing it. The parameters
 * below are deliberately the non-expert parts of the request and nothing else.
 */
async function completeBooking(params: {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly key: string;
  readonly resolved: ResolvedCase;
  readonly slot: ValidatedInput['slot'];
  readonly guests: ValidatedInput['guests'];
}): Promise<BookConsultationResult> {
  const { userId, activeCompanyId, key, resolved, slot, guests } = params;
  const { engagementId, companyId, expertProfileId, title: caseTitle, isNewCase } = resolved;

  const booked = await postBookMeeting({
    // BAL-283 widened `BookMeetingInput.contextType` off the literal `'case'` — this action
    // books Cases only, so the literal stays explicit here even though the field now accepts
    // every bookable label. No behaviour change.
    contextType: 'case',
    contextId: engagementId,
    scheduledStart: slot.startIso,
    scheduledEnd: slot.endIso,
    bookingIdempotencyKey: key,
  });

  if (!booked.ok) {
    return mapMeetingHopFailure({ booked, userId, key, activeCompanyId, resolved, slot });
  }

  // ⚠⚠ THE WINDOW COMES BACK FROM THE SERVER (S2), and everything below reads it rather than
  // `slot`. On Decision 7's replay the two differ; `slot` is what the client asked for,
  // `scheduledStart`/`scheduledEnd` are what `meetings` actually says. The confirmation
  // emails, the booked state and the toast are all statements of record about the latter.
  const { meetingId, provisioned, scheduledStart, scheduledEnd } = booked.data;
  const durationMinutes = windowMinutes(scheduledStart, scheduledEnd);

  let guestsInvited = 0;
  let guestInviteFailed = false;
  if (guests.length > 0) {
    const inviteResult = await postInviteGuests(meetingId, guests);
    if (inviteResult.ok) {
      guestsInvited = inviteResult.data.invitedCount;
    } else if (inviteResult.code === 'guest_already_invited') {
      // Retry-safe: a prior attempt already invited this exact set.
      guestsInvited = guests.length;
    } else {
      guestInviteFailed = true;
      log.warn('Guest invite failed after booking', {
        meetingId,
        failedCount: guests.length,
      });
    }
  }

  // M3 — this read runs AFTER the meeting is committed. Unlike `resolveBookingExpertDisplay`
  // (already fail-soft), `findNameById` was not: a DB blip here used to throw past a REAL,
  // already-paid-for-nothing-but-booked meeting, losing the client's confirmation, the
  // `booking.confirmed` publish, and re-throwing at the same line on every "Try again" replay.
  // Degrade to `undefined` (the caller already falls back to "your company") instead.
  const [companyName, expertDisplay] = await Promise.all([
    companiesRepository.findNameById(companyId).catch((error: unknown) => {
      log.warn('Company name read failed after booking; degrading to a neutral label', {
        companyId,
        meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }),
    resolveBookingExpertDisplay(expertProfileId),
  ]);

  log.info('Consultation booked', {
    meetingId,
    engagementId,
    provisioned,
    durationMinutes,
    guestCount: guests.length,
  });

  // Fire-and-forget (BAL-279 durability lives inside `publishNotificationEvent`). Only reached
  // on a real 201 — nothing is notified until a meeting exists (Decision 3).
  publishNotificationEvent('booking.confirmed', {
    correlationId: meetingId,
    meetingId,
    engagementId,
    recipientId: userId,
    expertProfileId,
    clientCompanyName: companyName?.name ?? 'your company',
    expertPartyLabel: expertDisplay.partyLabel,
    caseTitle,
    isNewCase,
    priorConsultationCount: await resolvePriorConsultationCount(
      isNewCase,
      companyId,
      expertProfileId,
      engagementId
    ),
    scheduledStartIso: scheduledStart,
    durationMinutes,
    joinPath: memberCallPath(meetingId),
    provisioned,
    guestCount: guests.length,
  });

  return {
    ok: true,
    engagementId,
    meetingId,
    joinPath: memberCallPath(meetingId),
    provisioned,
    isNewCase,
    caseTitle,
    scheduledStartIso: scheduledStart,
    scheduledEndIso: scheduledEnd,
    durationMinutes,
    guestsInvited,
    guestInviteFailed,
  };
}

export async function bookConsultationAction(
  rawInput: BookConsultationInput
): Promise<BookConsultationResult> {
  const user = await requireOnboardedUser();

  // Decision 1: minted early enough to cover the WHOLE submit, not just the meeting hop.
  const key = deriveBookingIdempotencyKey(user.id, rawInput.bookingNonce);

  const parsed = bookConsultationSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Booking request failed validation', {
      userId: user.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return { ok: false, stage: 'validation', code: 'invalid_request' };
  }
  const input = parsed.data;

  /**
   * ⚠ BEFORE the credential pre-flight below, which an impersonated session ALWAYS fails — it
   * holds no `accessToken` by design. Ordering it second would report every impersonated
   * booking as an expired session and invite the staff member to sign in, ending the
   * impersonation. Booking commits the customer to a consultation their wallet settles, so the
   * answer is refusal either way; only the message differs.
   */
  if (isImpersonatedSession(user)) {
    log.warn('Booking refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      expertProfileId: input.expertProfileId,
    });
    return { ok: false, stage: 'validation', code: 'impersonation_refused' };
  }

  /**
   * ⚠ Gate BEFORE the first write. `requireOnboardedUser()` is satisfied by the 7-day cookie,
   * which outlives the WorkOS token, so an idle viewer reaches here authenticated but holding a
   * dead Bearer. Without this, `resolveCase` writes a real row and only the `apps/api` hop 401s,
   * leaving an orphaned case behind a panel about the slot.
   */
  if (!(await viewerApiCredentialIsLive())) {
    log.info('Booking refused before any write — viewer credential expired', { userId: user.id });
    return { ok: false, stage: 'validation', code: 'session_expired' };
  }

  // BAL-478 fix round 2 (B2) — the funding gate's fan-out names the booker by USER ID
  // (`requestedByUserId`), never a pre-rendered name computed here: the resolver is the only
  // place that can ALSO drop the booker from `data.billingUserIds` when they are themselves a
  // holder, so a display-name fallback duplicated here would be a second, incomplete copy of
  // that logic (the earlier version of this comment's "not a second copy" claim was wrong).
  const caseResult = await resolveCase(user.id, user.companyId, key, input);
  if (!caseResult.ok) {
    return caseResult.result;
  }

  // ⚠ `input.expertProfileId` MUST NOT BE PASSED PAST THIS LINE — `caseResult.resolved`
  // already carries the server-resolved one (S1/M5).
  return completeBooking({
    userId: user.id,
    activeCompanyId: user.companyId,
    key,
    resolved: caseResult.resolved,
    slot: input.slot,
    guests: input.guests,
  });
}
