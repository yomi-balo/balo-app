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
 * ⚠⚠ `assertMeetingJoinable` — THE SAME LIVENESS GATE `claimLobbyPlace` USES, AND A FAILURE IS
 * A **NEUTRAL MISS**, NEVER AN ERROR. The first cut deliberately SKIPPED it, on the written
 * rationale that refusing an `ended` meeting would be "a NARROWER rule than the credential it
 * restores" because `findLiveByTokenHash` tolerates an ended meeting for the recap (BAL-388).
 * ⚠⚠ **THAT RATIONALE IS FALSE FOR THE ONLY ROW SHAPE THIS FEATURE CAN MATCH**, and the
 * recovery it produced was DEAD ON ARRIVAL:
 *   · `joinMeetingAsGuest` runs `assertMeetingJoinable` **BEFORE** its admission switch, so a
 *     lobby token on an ended meeting is refused at the liveness gate. The email would promise
 *     "you'll still wait for the host to let you in" and the very first poll would answer
 *     "This link isn't active".
 *   · THE RECAP IS NOT A FALLBACK EITHER: `resolveGuestRecapAccess` (`apps/web`) lists
 *     **pending admission** among the denials that collapse to `null`. Every row this arm can
 *     match is `invite_channel='link'` + `admission='pending'`, so a pending lobby row can
 *     never load a recap.
 * It also closes the MOVED-EARLIER hazard: a stored `expires_at` can still be in the future
 * while the recomputed `scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS` is already past, so
 * without this gate a rotation would destroy a WORKING link and email a dead one.
 *
 * ⚠ NON-ENUMERATION IS UNTOUCHED BY IT. A liveness failure converges on the same `miss(...)`
 * as every other refusal — same `202`, same floor, same neutral copy, nothing sent — because a
 * miss is already indistinguishable from a match by construction.
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
import { assertMeetingJoinable } from './meeting-liveness.js';
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

  // ⚠⚠ THE SAME GATE `claimLobbyPlace` RUNS, AND A FAILURE IS A NEUTRAL MISS — see the module
  // docblock for why the hand-rolled `status !== 'cancelled'` pair this replaced was wrong.
  // Restoring a credential `joinMeetingAsGuest` would refuse at its own liveness gate is not a
  // recovery; it is a dead link plus a rotation that killed whatever the guest still had.
  const liveness = await assertMeetingJoinable(meeting, primary.context);
  if (!liveness.ok) {
    miss(meetingId, liveness.reason);
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
    // ⚠⚠ THE COMPARE-AND-SET TOKEN, HANDED BACK UNMODIFIED (fix round R-6) — opaque here, and
    // it is what makes two simultaneous recoveries produce ONE rotation and ONE email instead
    // of two, the second of which could arrive last holding an already-dead credential.
    expectedVersionToken: guest.versionToken,
  });
  if (rotated === undefined) {
    // Lost a race with a concurrent revoke/deny/admit — or with ANOTHER RECOVERY for the same
    // address, which the `updated_at` compare-and-set now settles in favour of exactly one
    // writer. Nothing was published: the `WHERE` is the gate, not the read. ⚠ A NEUTRAL MISS,
    // never an error — the loser must be indistinguishable from "no row at all".
    miss(meetingId, 'rotation_lost_race');
    return;
  }

  // Resolved BEFORE the publish thunk, not inside it: `publishBestEffort` takes a synchronous
  // factory, and a title lookup is a cosmetic read that must not sit inside the swallow.
  const meetingTitle = await resolveMeetingTitle(primary.context);

  // ⚠⚠ THE RETURN VALUE IS LOAD-BEARING (fix round R-5). `publishBestEffort` SWALLOWS a queue
  // failure by design, so before it answered a boolean this arm reported `matched: true` and
  // logged "link sent" for a link that was never queued — contradicting the event's own
  // documented meaning ("A FRESH LINK WAS EMAILED", below) and hiding the one outcome support
  // most needs to see: the old credential is dead and nothing replaced it.
  const published = await publishBestEffort(
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

  // ⚠⚠ REPORTING ONLY — `matched` STILL BRANCHES NOTHING THE CALLER CAN SEE. The function
  // returns `void` either way, the route answers the same `202` inside the same floor, and the
  // panel renders the same neutral sentence. R-5 changed WHAT IS REPORTED, never control flow.
  // ⚠ The MISS-arm `distinct_id` on an unqueued publish, deliberately: `matched: false` and a
  // guest-row `distinct_id` would be two different answers to the same question, and the funnel
  // ("how often does recovery actually rescue somebody?") counts this as a failure.
  trackServer(GUEST_SERVER_EVENTS.GUEST_REENTRY_REQUESTED, {
    matched: published,
    distinct_id: published ? rotated.id : GUEST_REENTRY_ANONYMOUS_DISTINCT_ID,
  });

  if (published) {
    // ⚠ A CREDENTIAL WAS ISSUED — the line that makes a "they never got it" support case
    // answerable. ⚠ NO ADDRESS, NO TOKEN, NO HASH.
    log.info(
      { meetingId, guestId: rotated.id, matched: true },
      'Lobby re-entry link sent — the previous credential is now dead'
    );
    return;
  }

  // ⚠⚠ THE WORST OUTCOME THIS FEATURE HAS, AND IT USED TO LOG AS A SUCCESS. The rotation IS
  // committed, so the guest's old link is dead — and the replacement was never queued.
  // `publishBestEffort` already logged the underlying error; this names the consequence.
  // ⚠ NO ADDRESS, NO TOKEN, NO HASH — `guestId` is the safe handle, as on the success arm.
  log.warn(
    { meetingId, guestId: rotated.id, matched: false },
    'Lobby re-entry link was NOT queued — the previous credential is dead and nothing replaced it'
  );
}
