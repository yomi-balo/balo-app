'use server';
import 'server-only';

import { z } from 'zod';
import { projectEngagementsRepository } from '@balo/db';
// ⚠ `@balo/analytics/events` — the PURE constants subpath, never `/client` (which pulls
// `posthog-js` into a `server-only` module's graph).
import { CONVERSATION_CALL_SURFACES } from '@balo/analytics/events';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { assertRelationshipBookable } from '@/lib/project-request/assert-relationship-bookable';
import { assertUnderUpcomingCallCap } from '@/lib/project-request/assert-under-upcoming-call-cap';
// ⚠ THE WEB'S ONE DEFINITION OF REQUEST-STATUS ORDER — the same helper `deriveThreadActions`
// uses to compute `pastAcceptance` for the CTA. Reused, never re-derived, so the server-side
// denial and the CTA that hides itself can never disagree about where the decision line is.
import {
  requestStatusRank,
  type UpcomingCallContextType,
} from '@/lib/project-request/conversation-view-types';
import { deriveBookingIdempotencyKey } from '../booking-idempotency';
import { bookingSlotSchema, MS_PER_MINUTE } from '../booking-slot-schema';
import { resolveBookingExpertDisplay } from '../load-booking-context';
import { postBookMeeting, postInviteGuests } from '../booking-api-client';
import type { BookIntroCallInput, BookIntroCallResult } from './book-intro-call-types';

/**
 * BAL-283 / BAL-616 — `bookIntroCallAction`, the CLIENT lens's "Book a call" flow. It books EVERY
 * conversation call, intro or project; the name is kept to avoid churn.
 *
 * ⚠⚠ NO MONEY, ANYWHERE (Ruling 2). No `openSession`, no credit hold, no billing floor — this
 * action never imports a credit module. The 15-minute FLOOR on `SLOT_DURATION_LADDER` is a
 * WINDOW bound shared with the ladder itself, not the banned billing floor (plan §2.5); it
 * stays, exactly like `book-consultation.ts`'s own `validateBookingWindow` reliance.
 *
 * ⚠ THE SUBJECT IS RESOLVED ON THE SERVER, NEVER TAKEN FROM THE CLIENT (BAL-616). Before
 * kickoff it is the relationship (`request_interaction`, `contextId` =
 * `request_expert_relationships.id`); once the request is `kickoff_approved` the won thread
 * books on the engagement (`project_call`, `contextId` = `engagements.id`, read from the
 * request's own `project_engagements` row). `resolveCallTarget` derives which; the input carries
 * no engagement id. A DECLINED relationship denies in `apps/api` independently of this action's
 * own `assertRelationshipBookable` belt-and-braces check.
 *
 * ── WHICH GUARD IS AUTHORITATIVE, AND WHICH IS COURTESY ─────────────────────────────────────
 *
 * ⚠ THE TENANCY AND LIFECYCLE GATES ARE `apps/api`'s. `authorizeMeetingBooking` resolves the
 * owning company on the MEMBERSHIP axis (`PARTICIPATE`), denies a declined relationship, admits
 * only the WON relationship once the request is decided, and answers every denial an outsider
 * can reach with one indistinguishable `404 context_not_found`. The pre-flight checks below
 * exist so a LEGITIMATE user gets worded copy instead of a bare not-found, at no extra read.
 * Deleting them does NOT reopen a hole; deleting the api-side arms does.
 *
 * ⚠ THE UPCOMING-CALL CAP (`assertUnderUpcomingCallCap`, 3 per thread) IS ENFORCED IN BOTH APPS.
 * This is the pre-check, for the friendly copy; `apps/api` refuses the 4th with
 * `409 call_cap_reached`, which maps to the same failure code. Both are check-then-act, so two
 * racing bookings can both pass at 2 — a product limit, not a safety property.
 *
 * ⚠ NO SYMMETRIC "client lens" ASSERTION, DELIBERATELY, and this is not an oversight (round-1
 * LOW). `shareAvailabilityAction` gates on the ENGAGEMENT axis because its act has no other
 * authoritative gate — nothing downstream re-checks it. Booking's authoritative gate is
 * `apps/api`'s MEMBERSHIP-axis check on the owning COMPANY, which an expert-side actor cannot
 * pass (they hold no `company_members` row), so a second gate here would be redundant. A
 * `ctx.lens === 'client'` comparison would additionally be the exact ADR-1029 violation the
 * round-1 review removed from the sibling action.
 */

const MAX_GUESTS = 8;

/**
 * ⚠⚠ THE SLOT WINDOW MUST *AGREE* WITH `durationMinutes` (round-1 security MEDIUM) — enforced
 * by `bookingSlotSchema`, extracted to `../booking-slot-schema` in BAL-478 fix round 3 so this
 * SECURITY CHECK cannot diverge from `book-consultation.ts`'s identical one. See that module's
 * docblock for the full rationale. Before it existed here, `durationMinutes` was validated
 * against the duration ladder and then NEVER SENT and NEVER CROSS-CHECKED — only the raw window
 * crossed the wire, and the api's only bound is `validateBookingWindow`, which permits
 * `MAX_MEETING_MINUTES = 480`. So `{durationMinutes: 15, slot: {09:00 → 17:00}}` passed
 * everything and consumed the expert's WHOLE published day as ONE free confirmed consultation —
 * costing a single unit of the 10/hr rate limit instead of 32 — while the confirmation email
 * cheerfully said "480 min".
 *
 * ⚠ THIS IS NOT THE BANNED BILLING FLOOR AND IT DOES NOT WEAKEN `validateBookingWindow`. The
 * api-side window bounds (`MIN_MEETING_MINUTES = 15` / `MAX_MEETING_MINUTES = 480`) stay
 * exactly as they are; this only refuses a client that contradicts ITSELF.
 */
const bookIntroCallSchema = z
  .object({
    requestId: z.string().uuid(),
    relationshipId: z.string().uuid(),
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
    // ⚠ DERIVED, NOT RETYPED (round-1 W10) — the same tuple `ConversationCallSurface` is built
    // from, so the wire enum and the analytics property can never disagree.
    surface: z.enum(CONVERSATION_CALL_SURFACES),
  })
  .strict();

/** S2 precedent — the duration OF THE MEETING, derived from the server's own window. */
function windowMinutes(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / MS_PER_MINUTE));
}

type Denial = Extract<BookIntroCallResult, { ok: false }>;
type ConversationAccessOk = Extract<
  Awaited<ReturnType<typeof resolveConversationAccess>>,
  { ok: true }
>;
type BookMeetingFailure = Extract<Awaited<ReturnType<typeof postBookMeeting>>, { ok: false }>;

/** Where the call is booked: the context pair `apps/api` takes, and the engagement the cap reads. */
interface CallTarget {
  contextType: UpcomingCallContextType;
  contextId: string;
  engagementId: string | null;
}

/**
 * Which context this booking lands on, or a worded denial.
 *
 * ⚠ THE REQUEST-LIFECYCLE GATE, WEB HALF. The AUTHORITATIVE gate is `apps/api`'s booking
 * authorization, which denies the same states independently (a bare `404 context_not_found`).
 * This exists so a LEGITIMATE user who hit a stale CTA gets the worded "This request has moved
 * on" copy before spending a network hop. It costs no extra read for the relationship cases:
 * `resolveConversationAccess` already returned the request row.
 *
 *   · `closed` request → deny (BAL-540);
 *   · the won relationship at `kickoff_approved` → `project_call` on the request's engagement
 *     (none live, or not `active` → deny);
 *   · the won relationship at `accepted` → `request_interaction` on the relationship;
 *   · any other relationship once the request is decided (a losing thread) → deny;
 *   · otherwise (the request is still open) → `request_interaction`.
 */
async function resolveCallTarget(
  access: ConversationAccessOk,
  ids: { requestId: string; relationshipId: string; userId: string }
): Promise<{ ok: true; target: CallTarget } | Denial> {
  const { requestId, relationshipId, userId } = ids;
  const requestStatus = access.request.status;
  const requestInteraction: CallTarget = {
    contextType: 'request_interaction',
    contextId: relationshipId,
    engagementId: null,
  };

  if (requestStatus === 'closed') {
    log.warn('Call booking denied — the project request is closed', {
      requestId,
      relationshipId,
      userId,
      requestStatus,
    });
    return { ok: false, code: 'not_permitted' };
  }

  const won = access.relationship.status === 'accepted';
  if (won && requestStatus === 'kickoff_approved') {
    const engagement = await projectEngagementsRepository.findByProjectRequestId(requestId);
    // The request stays `kickoff_approved` after the project completes or is cancelled, and
    // `apps/api` refuses a `project_call` on a non-`active` engagement — so say so here.
    if (engagement?.status !== 'active') {
      log.warn('Call booking denied — no active project engagement at kickoff_approved', {
        requestId,
        relationshipId,
        userId,
        engagementStatus: engagement?.status ?? null,
      });
      return { ok: false, code: 'not_permitted' };
    }
    const engagementId = engagement.id;
    return {
      ok: true,
      target: { contextType: 'project_call', contextId: engagementId, engagementId },
    };
  }
  if (won) {
    return { ok: true, target: requestInteraction };
  }

  if (requestStatusRank(requestStatus) >= requestStatusRank('accepted')) {
    log.warn('Call booking denied — the project request is already decided', {
      requestId,
      relationshipId,
      userId,
      requestStatus,
    });
    return { ok: false, code: 'not_permitted' };
  }
  return { ok: true, target: requestInteraction };
}

/**
 * The pre-flight gates, extracted so `bookIntroCallAction` reads as one straight line. See the
 * module docblock for which are authoritative (api-side) versus courtesy (worded copy only).
 */
async function checkCallPreflight(
  access: ConversationAccessOk,
  ids: { requestId: string; relationshipId: string; userId: string }
): Promise<{ ok: true; target: CallTarget } | Denial> {
  const { requestId, relationshipId, userId } = ids;

  const resolved = await resolveCallTarget(access, ids);
  if (!resolved.ok) {
    return resolved;
  }

  const bookable = await assertRelationshipBookable(relationshipId);
  if (!bookable) {
    log.warn('Call booking denied — relationship declined or withdrawn', {
      requestId,
      relationshipId,
      userId,
    });
    return { ok: false, code: 'not_permitted' };
  }

  // The cap pre-check (see the module docblock): the same shared rule the page's list and the
  // api's gate count with, so a call that has ended never blocks a new booking.
  const underCap = await assertUnderUpcomingCallCap(relationshipId, resolved.target.engagementId);
  if (!underCap) {
    log.warn('Call booking denied — upcoming call cap reached', {
      requestId,
      relationshipId,
      userId,
    });
    return { ok: false, code: 'call_cap_reached' };
  }

  return resolved;
}

/** Maps a failed `postBookMeeting` onto the action's own result codes, logging as it goes. */
function mapBookingFailure(
  booked: BookMeetingFailure,
  ctx: { requestId: string; relationshipId: string; userId: string }
): Denial {
  if (booked.code === 'window_not_available') {
    log.warn('Call booking failed — slot no longer available', ctx);
    return { ok: false, code: 'slot_unavailable' };
  }
  if (booked.code === 'call_cap_reached') {
    log.warn('Call booking denied by the api — upcoming call cap reached', ctx);
    return { ok: false, code: 'call_cap_reached' };
  }
  if (booked.code === 'context_not_found' || booked.code === 'expert_unavailable') {
    return { ok: false, code: 'not_permitted' };
  }
  if (booked.code === 'context_type_mismatch' || booked.code === 'invalid_request') {
    return { ok: false, code: 'invalid_request' };
  }
  if (booked.status === 429 || booked.status === 503) {
    return { ok: false, code: 'rate_limited' };
  }
  log.error('Call booking failed', { ...ctx, status: booked.status, code: booked.code });
  return { ok: false, code: 'booking_failed' };
}

/**
 * Invites guests at booking confirm, if any were submitted. A `409 guest_already_invited` is
 * treated as success (see `postInviteGuests`'s own docblock) — everything else is reported as a
 * non-fatal `guestInviteFailed`, never a booking failure.
 */
async function inviteGuestsIfAny(
  meetingId: string,
  guests: BookIntroCallInput['guests']
): Promise<{ guestsInvited: number; guestInviteFailed: boolean }> {
  if (guests.length === 0) {
    return { guestsInvited: 0, guestInviteFailed: false };
  }
  const inviteResult = await postInviteGuests(meetingId, guests);
  if (inviteResult.ok) {
    return { guestsInvited: inviteResult.data.invitedCount, guestInviteFailed: false };
  }
  if (inviteResult.code === 'guest_already_invited') {
    return { guestsInvited: guests.length, guestInviteFailed: false };
  }
  log.warn('Guest invite failed after call booking', {
    meetingId,
    failedCount: guests.length,
  });
  return { guestsInvited: 0, guestInviteFailed: true };
}

export async function bookIntroCallAction(
  rawInput: BookIntroCallInput
): Promise<BookIntroCallResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { ok: false, code: 'not_permitted' };
  }

  const parsed = bookIntroCallSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Call booking failed validation', {
      userId: user.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return { ok: false, code: 'invalid_request' };
  }
  const input = parsed.data;
  const { requestId, relationshipId } = input;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      log.warn('Call booking denied — conversation access', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }

    const preflight = await checkCallPreflight(access, {
      requestId,
      relationshipId,
      userId: user.id,
    });
    if (!preflight.ok) {
      return preflight;
    }
    const { target } = preflight;

    const key = deriveBookingIdempotencyKey(user.id, input.bookingNonce);

    const booked = await postBookMeeting({
      contextType: target.contextType,
      contextId: target.contextId,
      scheduledStart: input.slot.startIso,
      scheduledEnd: input.slot.endIso,
      bookingIdempotencyKey: key,
    });

    if (!booked.ok) {
      return mapBookingFailure(booked, { requestId, relationshipId, userId: user.id });
    }

    const { meetingId, provisioned, scheduledStart, scheduledEnd } = booked.data;
    const durationMinutes = windowMinutes(scheduledStart, scheduledEnd);

    const { guestsInvited, guestInviteFailed } = await inviteGuestsIfAny(meetingId, input.guests);

    log.info('Call booked', {
      requestId,
      relationshipId,
      meetingId,
      contextType: target.contextType,
      durationMinutes,
      provisioned,
      guestCount: input.guests.length,
    });

    const expertProfileId = access.relationship.expertProfileId;
    const won = access.relationship.status === 'accepted';
    const expertDisplay = await resolveBookingExpertDisplay(expertProfileId);
    const joinPath = memberCallPath(meetingId);

    // Fire-and-forget — only reached on a real 201.
    publishNotificationEvent('conversation.intro_call_booked', {
      correlationId: meetingId,
      meetingId,
      requestId,
      requestTitle: access.request.title,
      relationshipId,
      recipientId: user.id,
      expertProfileId,
      /**
       * ⚠ BOTH HALVES OF THE CLIENT ATTRIBUTION (round-1 MAJOR UX). CLAUDE.md: RETROSPECTIVE
       * copy — who actually did something — names the PERSON with "@ company" on first
       * mention. Booking IS retrospective (it is reported after the fact), and this event's
       * mirror `conversation.availability_shared` already carries `expertPersonName` +
       * `expertPartyLabel`. Carrying only the company made the pair ASYMMETRIC: the client was
       * told exactly which named person acted, while the expert learned only *that* someone
       * from Northwind booked, never *who*.
       *
       * ⚠ ADR-1044 IS NOT ENGAGED. A NAME crosses the party boundary; an ADDRESS never does.
       * `user.email` is deliberately absent here and must stay absent.
       */
      clientPersonName: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'A client',
      clientCompanyName: access.request.company.name,
      expertPartyLabel: expertDisplay.partyLabel,
      scheduledStartIso: scheduledStart,
      durationMinutes,
      joinPath,
      provisioned,
      guestCount: input.guests.length,
      callKind: target.contextType === 'project_call' || won ? 'call' : 'intro',
    });

    return {
      ok: true,
      meetingId,
      joinPath,
      provisioned,
      scheduledStartIso: scheduledStart,
      scheduledEndIso: scheduledEnd,
      durationMinutes,
      guestsInvited,
      guestInviteFailed,
      contextType: target.contextType,
    };
  } catch (error) {
    log.error('Call booking failed unexpectedly', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'booking_failed' };
  }
}
