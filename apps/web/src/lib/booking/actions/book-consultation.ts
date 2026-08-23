'use server';
import 'server-only';

import { z } from 'zod';
import {
  auditEventsRepository,
  caseEngagementsRepository,
  companiesRepository,
  partyMembershipsRepository,
  referenceDataRepository,
  isUniqueViolation,
} from '@balo/db';
import { SLOT_DURATION_LADDER } from '@balo/shared/availability';
import { CAPABILITIES } from '@/lib/authz';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { deriveBookingIdempotencyKey } from '../booking-idempotency';
import { sanitizeCaseDescription } from '../sanitize-case-description';
import { authorizeCaseAttach } from '../authorize-case-attach';
import { resolveBookingExpertDisplay } from '../load-booking-context';
import { postBookMeeting, postInviteGuests } from '../booking-api-client';
import type {
  BookConsultationInput,
  BookConsultationResult,
  BookingFailureCode,
  BookingStage,
} from './types';

/**
 * BAL-400 — `bookConsultationAction`, the two-hop booking orchestration (Decisions 1/3/4/5/6/7).
 *
 * ⚠⚠ THE MONEY IS OUT OF SCOPE (D1). This action never calls `openSession` or
 * `creditHoldsRepository.place`. It resolves a BILLING COMPANY (D1a) because
 * `engagements.company_id` is NOT NULL and a case pins the wallet every later consultation
 * bills — but it moves no money, places no hold, and shows no balance.
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

const slotDurations = SLOT_DURATION_LADDER as readonly number[];

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

const bookConsultationSchema = z
  .object({
    expertProfileId: z.string().uuid(),
    slot: z
      .object({
        startIso: z.string().min(1),
        endIso: z.string().min(1),
        durationMinutes: z
          .number()
          .refine((value) => slotDurations.includes(value), { message: 'invalid duration' }),
      })
      .strict(),
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
function caseFailure(stage: BookingStage, code: BookingFailureCode): CaseResolution {
  return { ok: false, result: { ok: false, stage, code } };
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
 * gate) rather than guessing. Extracted from `createCase` purely to keep that function's own
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

/** The 'new' arm's create path: bound, validate, resolve the company, then write. */
async function createCase(
  userId: string,
  key: string,
  claimedExpertProfileId: string,
  choice: NewCaseChoice
): Promise<CaseResolution> {
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

  try {
    const created = await caseEngagementsRepository.create({
      companyId: companyResult.companyId,
      expertProfileId: claimedExpertProfileId,
      title: choice.title,
      description: sanitized.html,
      actorUserId: userId,
      bookingIdempotencyKey: key,
      productIds: choice.productIds,
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
    return handleCaseCreateError(error, userId, key, claimedExpertProfileId);
  }
}

/** Open-or-replay-or-attach the case. Returns the resolved case identity, never throws. */
async function resolveCase(
  userId: string,
  key: string,
  input: ValidatedInput
): Promise<CaseResolution> {
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
      resolved: {
        engagementId: attach.engagementId,
        companyId: attach.companyId,
        expertProfileId: attach.expertProfileId,
        title: attach.title,
        isNewCase: false,
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
    return { ok: true, resolved: replay.resolved };
  }

  return createCase(userId, key, input.expertProfileId, input.caseChoice);
}

const MS_PER_MINUTE = 60_000;

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
    return openCases.find((c) => c.engagementId === engagementId)?.consultationCount ?? 0;
  } catch (error) {
    log.warn('Prior consultation count unavailable; defaulting to 0', {
      engagementId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
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
  readonly key: string;
  readonly resolved: ResolvedCase;
  readonly slot: ValidatedInput['slot'];
  readonly guests: ValidatedInput['guests'];
}): Promise<BookConsultationResult> {
  const { userId, key, resolved, slot, guests } = params;
  const { engagementId, companyId, expertProfileId, title: caseTitle, isNewCase } = resolved;

  const priorConsultationCount = await resolvePriorConsultationCount(
    isNewCase,
    companyId,
    expertProfileId,
    engagementId
  );

  const booked = await postBookMeeting({
    contextType: 'case',
    contextId: engagementId,
    scheduledStart: slot.startIso,
    scheduledEnd: slot.endIso,
    bookingIdempotencyKey: key,
  });

  if (!booked.ok) {
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
    priorConsultationCount,
    scheduledStartIso: scheduledStart,
    durationMinutes,
    joinPath: `/join/m/${meetingId}`,
    provisioned,
    guestCount: guests.length,
  });

  return {
    ok: true,
    engagementId,
    meetingId,
    joinPath: `/join/m/${meetingId}`,
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

  const caseResult = await resolveCase(user.id, key, input);
  if (!caseResult.ok) {
    return caseResult.result;
  }

  // ⚠ `input.expertProfileId` MUST NOT BE PASSED PAST THIS LINE — `caseResult.resolved`
  // already carries the server-resolved one (S1/M5).
  return completeBooking({
    userId: user.id,
    key,
    resolved: caseResult.resolved,
    slot: input.slot,
    guests: input.guests,
  });
}
