'use server';
import 'server-only';

import { z } from 'zod';
import { SLOT_DURATION_LADDER } from '@balo/shared/availability';
// ⚠ `@balo/analytics/events` — the PURE constants subpath, never `/client` (which pulls
// `posthog-js` into a `server-only` module's graph).
import { CONVERSATION_CALL_SURFACES } from '@balo/analytics/events';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { memberJoinPath } from '@/lib/meetings/member-join-path';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { assertRelationshipBookable } from '@/lib/project-request/assert-relationship-bookable';
import { assertNoLiveIntroCall } from '@/lib/project-request/assert-no-live-intro-call';
// ⚠ THE WEB'S ONE DEFINITION OF REQUEST-STATUS ORDER — the same helper `deriveThreadActions`
// uses to compute `pastAcceptance` for the CTA. Reused, never re-derived, so the server-side
// denial and the CTA that hides itself can never disagree about where the decision line is.
import { requestStatusRank } from '@/lib/project-request/conversation-view-types';
import { deriveBookingIdempotencyKey } from '../booking-idempotency';
import { resolveBookingExpertDisplay } from '../load-booking-context';
import { postBookMeeting, postInviteGuests } from '../booking-api-client';
import type { BookIntroCallInput, BookIntroCallResult } from './book-intro-call-types';

/**
 * BAL-283 — `bookIntroCallAction`, the CLIENT lens's "Book a call" flow (plan §12.5).
 *
 * ⚠⚠ NO MONEY, ANYWHERE (Ruling 2). No `openSession`, no credit hold, no billing floor — this
 * action never imports a credit module. The 15-minute FLOOR on `SLOT_DURATION_LADDER` is a
 * WINDOW bound shared with the ladder itself, not the banned billing floor (plan §2.5); it
 * stays, exactly like `book-consultation.ts`'s own `validateBookingWindow` reliance.
 *
 * ⚠ THE RELATIONSHIP IS THE BOOKING SUBJECT (D3/D4). `contextId` is
 * `request_expert_relationships.id`, never an `engagement.id` — `apps/api`'s `loadSubject`
 * `request_interaction` arm resolves it through `resolveContextOwner`'s two-hop, and a DECLINED
 * relationship denies there independently of this action's own `assertRelationshipBookable`
 * belt-and-braces check.
 *
 * ── WHICH GUARD IS AUTHORITATIVE, AND WHICH IS COURTESY ─────────────────────────────────────
 *
 * ⚠ THE TENANCY AND LIFECYCLE GATES ARE `apps/api`'s. `authorizeMeetingBooking` resolves the
 * owning company on the MEMBERSHIP axis (`PARTICIPATE`), denies a declined relationship, and
 * denies a decided request — all independently of anything here, and all answering one
 * indistinguishable `404 context_not_found`. The two pre-flight checks below (`request.status`,
 * `assertRelationshipBookable`) exist ONLY so a LEGITIMATE user gets worded copy instead of a
 * bare not-found, at no extra read. Deleting either does NOT reopen a hole; deleting the
 * api-side arms does.
 *
 * ⚠ THE ONE-CALL-PER-THREAD GUARD (`assertNoLiveIntroCall`) IS DIFFERENT — it is the ONLY
 * enforcement of a rule the UI already claims, and `apps/api` has no equivalent. See that
 * module's docblock.
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
const slotDurations = SLOT_DURATION_LADDER as readonly number[];
const MS_PER_MINUTE = 60_000;

/**
 * ⚠⚠ THE SLOT WINDOW MUST *AGREE* WITH `durationMinutes` (round-1 security MEDIUM). Before
 * this, `durationMinutes` was validated against `SLOT_DURATION_LADDER` and then NEVER SENT and
 * NEVER CROSS-CHECKED — only the raw window crossed the wire, and the api's only bound is
 * `validateBookingWindow`, which permits `MAX_MEETING_MINUTES = 480`. So
 * `{durationMinutes: 15, slot: {09:00 → 17:00}}` passed everything and consumed the expert's
 * WHOLE published day as ONE free confirmed consultation — costing a single unit of the 10/hr
 * rate limit instead of 32 — while the confirmation email cheerfully said "480 min".
 *
 * ⚠ THIS IS NOT THE BANNED BILLING FLOOR AND IT DOES NOT WEAKEN `validateBookingWindow`. The
 * api-side window bounds (`MIN_MEETING_MINUTES = 15` / `MAX_MEETING_MINUTES = 480`) stay
 * exactly as they are; this only refuses a client that contradicts ITSELF.
 *
 * ⚠ `.datetime()`, NOT `.min(1)` — an unparseable instant would make the subtraction `NaN`,
 * and `NaN === anything` is false, so the refinement would technically hold; typing both
 * instants makes the failure a named `invalid_request` at the boundary instead.
 */
const bookIntroCallSchema = z
  .object({
    requestId: z.string().uuid(),
    relationshipId: z.string().uuid(),
    slot: z
      .object({
        startIso: z.string().datetime(),
        endIso: z.string().datetime(),
        durationMinutes: z
          .number()
          .refine((value) => slotDurations.includes(value), { message: 'invalid duration' }),
      })
      .strict()
      .superRefine((slot, ctx) => {
        const spanMs = Date.parse(slot.endIso) - Date.parse(slot.startIso);
        if (spanMs !== slot.durationMinutes * MS_PER_MINUTE) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['endIso'],
            message: 'slot window does not match durationMinutes',
          });
        }
      }),
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

/**
 * The three pre-flight gates (round-1 HIGH / security MEDIUM), extracted so
 * `bookIntroCallAction` reads as one straight line. See the module docblock for which of these
 * is authoritative (api-side) versus courtesy (worded copy only) — extracting them does not
 * change that posture, only where the `if`s live.
 */
async function checkIntroCallPreflight(
  access: ConversationAccessOk,
  requestId: string,
  relationshipId: string,
  userId: string
): Promise<Denial | null> {
  /**
   * ⚠ THE REQUEST-LIFECYCLE GATE, WEB HALF (round-1 HIGH). The AUTHORITATIVE gate is
   * `apps/api`'s `loadSubject` `request_interaction` arm, which denies the same states
   * independently and answers a bare `404 context_not_found` (its oracle posture: every
   * denial an outsider can reach is indistinguishable). This exists ONLY so a LEGITIMATE
   * user — someone whose thread stayed open past acceptance and who hit a stale CTA — gets
   * the worded "This request has moved on" copy instead of a bare not-found, and gets it
   * before spending a network hop.
   *
   * It costs NO extra read: `resolveConversationAccess` already returned the request row.
   * ⚠ Deleting this does NOT reopen the hole; deleting the api-side arm does.
   */
  if (requestStatusRank(access.request.status) >= requestStatusRank('accepted')) {
    log.warn('Intro call booking denied — the project request is already decided', {
      requestId,
      relationshipId,
      userId,
      requestStatus: access.request.status,
    });
    return { ok: false, code: 'not_permitted' };
  }

  const bookable = await assertRelationshipBookable(relationshipId);
  if (!bookable) {
    log.warn('Intro call booking denied — relationship declined or withdrawn', {
      requestId,
      relationshipId,
      userId,
    });
    return { ok: false, code: 'not_permitted' };
  }

  // ⚠ ONE INTRO CALL PER THREAD, ENFORCED (round-1 security MEDIUM). The UI has always
  // CLAIMED this — `deriveCallSlot` removes the CTA once a call exists and the nudge tells
  // both parties there is nothing left to book — while `bookingIdempotencyKey` is
  // `sha256(userId:nonce)` over a CLIENT-MINTED nonce, so a fresh nonce was a fresh booking
  // by construction. See `assertNoLiveIntroCall` for what this does and does not close.
  const noLiveCall = await assertNoLiveIntroCall(relationshipId);
  if (!noLiveCall) {
    log.warn('Intro call booking denied — this thread already has a live intro call', {
      requestId,
      relationshipId,
      userId,
    });
    return { ok: false, code: 'not_permitted' };
  }

  return null;
}

/** Maps a failed `postBookMeeting` onto the action's own result codes, logging as it goes. */
function mapBookingFailure(
  booked: BookMeetingFailure,
  ctx: { requestId: string; relationshipId: string; userId: string }
): Denial {
  if (booked.code === 'window_not_available') {
    log.warn('Intro call booking failed — slot no longer available', ctx);
    return { ok: false, code: 'slot_unavailable' };
  }
  if (booked.code === 'context_not_found') {
    return { ok: false, code: 'not_permitted' };
  }
  if (booked.code === 'context_type_mismatch' || booked.code === 'invalid_request') {
    return { ok: false, code: 'invalid_request' };
  }
  if (booked.status === 429 || booked.status === 503) {
    return { ok: false, code: 'rate_limited' };
  }
  log.error('Intro call booking failed', { ...ctx, status: booked.status, code: booked.code });
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
  log.warn('Guest invite failed after intro call booking', {
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
    log.warn('Intro call booking failed validation', {
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
      log.warn('Intro call booking denied — conversation access', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }

    const denial = await checkIntroCallPreflight(access, requestId, relationshipId, user.id);
    if (denial !== null) {
      return denial;
    }

    const key = deriveBookingIdempotencyKey(user.id, input.bookingNonce);

    const booked = await postBookMeeting({
      contextType: 'request_interaction',
      contextId: relationshipId,
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

    log.info('Intro call booked', {
      requestId,
      relationshipId,
      meetingId,
      durationMinutes,
      provisioned,
      guestCount: input.guests.length,
    });

    const expertProfileId = access.relationship.expertProfileId;
    const expertDisplay = await resolveBookingExpertDisplay(expertProfileId);
    const joinPath = memberJoinPath(meetingId);

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
    };
  } catch (error) {
    log.error('Intro call booking failed unexpectedly', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'booking_failed' };
  }
}
