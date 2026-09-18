/**
 * BAL-442 — THE SELF-SERVICE LOBBY RE-ENTRY LINK. A lobby guest closed the tab that held their
 * only credential and cannot re-knock (`meeting_guest_meeting_email_live_idx` refuses a second
 * row for the same address). This is the one safe recovery: a fresh link emailed to the
 * address ALREADY ON THE ROW, never returned to the browser that asked.
 *
 * ⚠⚠ NON-ENUMERATION IS THE WHOLE FEATURE. The caller must never be able to tell "a row
 * matched and we sent something" apart from "nothing matched and we sent nothing" — not by
 * response body, not by status code, and not by timing. This function returns `void` PRECISELY
 * so that property is structural (see below) rather than a convention the route has to
 * maintain by hand; `matched` exists inside this function only, for the PostHog event and the
 * structured log, and must never cross back out.
 *
 * ⚠ MIRRORS `claimLobbyPlace`'s STEP ORDER (`join-meeting.ts`) so the two anonymous paths stay
 * legible side by side: meeting → primary context → liveness → the guest-specific read → mint
 * → write → publish → track.
 *
 * ⚠⚠ NOT `assertMeetingJoinable`. That refuses an `ended` meeting, and `findLiveByTokenHash`
 * deliberately RESOLVES one so a guest keeps their handle on the recap (BAL-388). Refusing
 * recovery for an ended meeting would be a NARROWER rule than the credential it restores, so
 * this checks only `deleted_at IS NULL` (via `findById`) and `status !== 'cancelled'` — exactly
 * `findLiveByTokenHash`'s two meeting-side predicates.
 *
 * ⚠ NO SEAT CAP AND NO QUEUE CAP. This is not an additive mutation: no row is created and no
 * seat or queue slot is taken (`resendGuestJoinLink`'s "NO SEAT-CAP CHECK" note verbatim).
 *
 * ── WRITE BEFORE PUBLISH, AND THE ORDER IS ASSERTED BY A TEST ────────────────────────────────
 * The same `review-nudge-sweep.test.ts` `invocationCallOrder` precedent `guest-participation.ts`
 * cites: publishing before the rotation is committed would email a credential the database
 * never accepted.
 *
 * ── ⚠ THE ONE REAL COST, STATED RATHER THAN HIDDEN ───────────────────────────────────────────
 * A stranger who GUESSES a colleague's address can force a rotation of that colleague's live
 * pending credential, so the colleague's open tab stops working. The replacement goes only to
 * the colleague's own inbox, so nobody gains access; the cost is a one-off interruption plus an
 * email, bounded by the caller's recipient-keyed rate-limit window. The same trade
 * `rotateToken` documents for the host arm.
 */
import { meetingContextsRepository, meetingGuestsRepository, meetingsRepository } from '@balo/db';
import { GUEST_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import { GUEST_TOKEN_TTL_AFTER_END_MS, selectPrimaryMeetingContext } from '@balo/shared/meetings';
import { notificationEvents } from '../../notifications/index.js';
import { mintGuestInviteToken } from '../../lib/guest-token.js';
import { formatExpiryDate, publishBestEffort, resolveMeetingTitle } from './guest-participation.js';

const log = createLogger('request-lobby-reentry-link');

/**
 * ⚠⚠ THE MISS ARM'S PostHog `distinct_id`. A CONSTANT, NOT AN IP-DERIVED HANDLE — an
 * IP-derived one would mint a PostHog PERSON PROFILE PER IP, which has no precedent in this
 * repo (`hashedClientIp` is used only for rate-limiter keys) and would turn an anonymous scan
 * into a durable third-party identity.
 *
 * ⚠ It lives HERE rather than in `@balo/analytics` so that the analytics package's
 * registration stays to ONE file (`packages/analytics/src/events/guest.ts`) — a new exported
 * constant in that package would need the `server/index.ts` re-export too.
 */
export const GUEST_REENTRY_ANONYMOUS_DISTINCT_ID = 'system:guest-reentry';

export interface RequestLobbyReentryLinkInput {
  meetingId: string;
  /**
   * ⚠ ALREADY CANONICAL (`canonicalGuestEmail`) — the ROUTE canonicalises, so this string and
   * the recipient rate-limit key are provably the same value.
   */
  email: string;
}

/**
 * Emit the miss-arm analytics event and structured log. Every failure path converges here.
 *
 * ⚠ ANALYTICS SINK: no `meeting_id`, no `party` — see `GUEST_REENTRY_REQUESTED`'s own docblock
 * in `@balo/analytics`. ⚠ LOG SINK: `meetingId` IS included, deliberately, by a different
 * audience — `SENSITIVE_PATH_PREFIXES`' own `/join/m/` note ("different sink, different
 * audience, unchanged"). ⚠ NEVER the email, never the token, never the hash.
 */
function miss(meetingId: string, reason: string): void {
  trackServer(GUEST_SERVER_EVENTS.GUEST_REENTRY_REQUESTED, {
    matched: false,
    distinct_id: GUEST_REENTRY_ANONYMOUS_DISTINCT_ID,
  });
  log.info({ meetingId, matched: false, reason }, 'Lobby re-entry requested — nothing sent');
}

/**
 * ⚠⚠ RETURNS `void`, AND THAT IS A SECURITY PROPERTY, NOT AN OVERSIGHT. A discriminated result
 * (`{ matched: boolean }`, an error code, a row id) is a value a future edit can branch on —
 * and the ONE thing this whole feature must never let the caller learn is whether a row
 * exists. With no verdict crossing this boundary, a non-neutral response is unrepresentable in
 * the route rather than merely absent from it.
 *
 * ⚠⚠ `matched` MEANS "A FRESH LINK WAS EMAILED", NOT "A PENDING ROW EXISTED" — which is why a
 * lost race on the rotation (step 6) counts as `matched: false`. That is the only definition
 * stable under the race and the only one the funnel question ("how often does recovery
 * actually rescue somebody?") wants.
 */
export async function requestLobbyReentryLink(input: RequestLobbyReentryLinkInput): Promise<void> {
  const { meetingId, email } = input;

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    miss(meetingId, 'no_meeting');
    return;
  }

  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok) {
    miss(meetingId, `context_${primary.reason}`);
    return;
  }

  // ⚠⚠ NOT `assertMeetingJoinable` — see the module docblock. The two meeting-side predicates
  // here are exactly `findLiveByTokenHash`'s: `deleted_at IS NULL` (already enforced by
  // `findById`) and `status !== 'cancelled'`.
  if (meeting.status === 'cancelled') {
    miss(meetingId, 'meeting_cancelled');
    return;
  }

  const guest = await meetingGuestsRepository.findLivePendingLobbyByEmail(meetingId, email);
  if (guest === undefined) {
    miss(meetingId, 'no_live_pending_row');
    return;
  }

  // ⚠ MINT, THEN WRITE, THEN PUBLISH — and the order is asserted by a test.
  const { rawToken, tokenHash } = mintGuestInviteToken();
  // ⚠ Derived from the MEETING, never from the mint instant — the rule
  // `meeting_guests.expires_at` has no SQL default in order to enforce.
  const expiresAt = new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS);

  const rotated = await meetingGuestsRepository.rotatePendingLobbyToken({
    meetingId,
    guestId: guest.id,
    tokenHash,
    expiresAt,
  });
  if (rotated === undefined) {
    // Lost a race with a concurrent revoke/deny/admit between the read and the write. Nothing
    // was published — the `WHERE` is the gate, not the read.
    miss(meetingId, 'rotation_lost_race');
    return;
  }

  // Resolved BEFORE the publish thunk, not inside it: `publishBestEffort` takes a synchronous
  // factory, and a title lookup is a cosmetic read that must not sit inside the swallow.
  const meetingTitle = await resolveMeetingTitle(primary.context);

  await publishBestEffort(
    () =>
      notificationEvents.publish('meeting.guest_reentry_link_sent', {
        // ⚠⚠ NEVER THE GUEST ROW ID. A repeat recovery on the SAME row would collide with the
        // previous recovery's retained BullMQ job and be silently dedup-swallowed — the exact
        // failure this affordance exists to fix.
        correlationId: tokenHash.slice(0, 16),
        // ⚠ READ BACK OFF THE ROTATED ROW, never `input.email` — equal by construction of the
        // match, but structural rather than incidental.
        recipientEmail: rotated.email,
        joinToken: rawToken,
        meetingId,
        ...(rotated.name === null ? {} : { guestName: rotated.name }),
        meetingTitle,
        scheduledStartIso: meeting.scheduledStart.toISOString(),
        scheduledEndIso: meeting.scheduledEnd.toISOString(),
        expiresOn: formatExpiryDate(rotated.expiresAt),
      }),
    { event: 'meeting.guest_reentry_link_sent', correlationId: tokenHash.slice(0, 16) },
    'Failed to publish lobby re-entry link — the rotation itself is committed'
  );

  trackServer(GUEST_SERVER_EVENTS.GUEST_REENTRY_REQUESTED, {
    matched: true,
    distinct_id: rotated.id,
  });

  // ⚠ A CREDENTIAL WAS ISSUED — the line that makes a "they never got it" support case
  // answerable. ⚠ NO ADDRESS, NO TOKEN, NO HASH.
  log.info(
    { meetingId, guestId: rotated.id, matched: true },
    'Lobby re-entry link sent — the previous credential is now dead'
  );
}
