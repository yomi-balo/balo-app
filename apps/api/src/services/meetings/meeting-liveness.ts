/**
 * BAL-132 — THE ONE LIVENESS RULE, in ONE place, used by BOTH join arms.
 *
 * ⚠⚠ THIS IS WHERE THE OBLIGATION `hasEngagementCapability` REFUSES TO DISCHARGE IS
 * DISCHARGED. `authorize-engagement-host.ts` states it in writing: it never reads
 * `engagements.status`, and "a caller that requires liveness (BAL-132 minting a Daily owner
 * token …) must check `engagements.status` itself". So the delivering expert of a CANCELLED
 * engagement still holds `host_meetings` — the capability seam is answering "who delivers
 * this?", which is a question about identity and stays true forever. **THIS MODULE IS THE
 * ONLY THING BETWEEN THAT AND AN OWNER TOKEN FOR A CANCELLED ENGAGEMENT.** It has a named
 * test.
 *
 * ⚠ IT IS DELIBERATELY SEPARATE FROM `authorizeMeetingParticipation`, and the ORDER matters
 * as much as the split. That gate runs FIRST and answers authorization; this runs AFTER and
 * answers state. Reversing them would let an actor with membership nowhere distinguish states
 * of a guessed `meetingId` by status code alone — an existence oracle over every meeting on
 * the platform. That ordering rule is copied verbatim from
 * `authorize-meeting-booking.ts` / `authorize-meeting-participation.ts`, and it is why the
 * four reasons below are LOG fields while the wire gets one post-authorization literal.
 *
 * ⚠ THE ANONYMOUS LOBBY ARM IS THE EXCEPTION THAT PROVES IT. `claimLobbyPlace` has no
 * authorization at all, so it maps EVERY failure here to `meeting_not_found` rather than to
 * the `meeting_not_open_for_join` a member gets. See `join-meeting.ts`.
 */
import { engagementsRepository, type Meeting } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { MEETING_CLOSED_TO_JOIN, type PrimaryMeetingContext } from '@balo/shared/meetings';

const log = createLogger('meeting-liveness');

/**
 * How long a minted Daily token outlives the meeting it was minted for: 24 hours past
 * `meetings.scheduled_end`.
 *
 * ⚠⚠ GENEROUS ON PURPOSE, AND THE REASONING IS THE OPPOSITE OF THE OBVIOUS ONE. A TIGHT
 * EXPIRY WOULD NOT THROW ANYONE OUT OF A LIVE CALL — `eject_at_token_exp` is `false` (Daily's
 * default, and `meeting-tokens.ts` keeps it there) — so the only thing a short window buys is
 * a LOCKED-OUT REJOIN after a network blip at minute 61 of a 60-minute call. That is a
 * user-visible failure with no compensating security gain: the token is bearer-only, scoped to
 * one private room, and the room is a pure function of one meeting.
 *
 * ⚠ DELIBERATELY MUCH SHORTER THAN `GUEST_TOKEN_TTL_AFTER_END_MS` (7 days). The two are
 * different credentials for different things: the guest ROW's token is the durable HANDLE
 * (it re-renders the invitation and, later, the recap), while this is the ENTRY key. A
 * handle that outlives the key is correct; the reverse would not be.
 */
export const MEETING_TOKEN_TTL_AFTER_END_MS = 24 * 60 * 60 * 1000;

/**
 * WHY a join was refused. ⚠ A LOG FIELD, NEVER A WIRE VALUE — all four collapse into one
 * literal at the service boundary. See the module docblock.
 */
export type LivenessDenialReason =
  | 'meeting_terminal'
  | 'engagement_not_active'
  | 'engagement_missing'
  | 'token_window_elapsed';

export type MeetingJoinableResult =
  | {
      readonly ok: true;
      /** ⚠ UNIX **SECONDS** — Daily's unit. See {@link expiresAtUnixFor}. */
      readonly expiresAtUnix: number;
      /** The same instant as a `Date`, for the response's ISO `expiresAt`. */
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: LivenessDenialReason };

/**
 * Does this context type anchor on an `engagements.id`, and therefore HAVE a lifecycle to
 * check?
 *
 * ⚠⚠ A **TOTAL `Record`**, NOT A HAND-LISTED `ReadonlySet`, AND THE DIFFERENCE IS THE ONLY
 * THING MAKING THIS MODULE FAIL-CLOSED OVER TIME. A set is a 4-of-6 subset with no
 * exhaustiveness witness: adding a seventh `meeting_context_type` label that DOES carry an
 * engagement would compile clean, fall silently into the "meeting status only" arm below, and
 * mint a Daily **OWNER** token for a cancelled engagement — the exact failure this whole file
 * exists to prevent, arriving with `pnpm typecheck` green. As a total `Record` keyed on
 * `PrimaryMeetingContext['contextType']`, that same label is a COMPILE ERROR here until
 * somebody states which arm it belongs in. `guest-participation.ts`'s
 * `MEETING_LABEL_FOR_CONTEXT` uses the same shape for the same reason.
 *
 * ⚠ `false` FOR `project_discovery` AND `request_interaction` IS CORRECT, NOT A GAP. Neither
 * has an `engagements` row at all — the engagement is not materialised until kickoff — so
 * there is nothing to read and a read would be a guaranteed `undefined` that denied every
 * intro call on the platform. Their equivalent gate is UPSTREAM and already shipped:
 * `relationshipDeniesHosting` inside `resolveHostContext` means a DECLINED expert never
 * resolves as a holder, so they join (if at all) with `isOwner: false`.
 *
 * ⚠ `admin` IS NOT REPRESENTABLE HERE, which is why it is absent from the `Record` without
 * that being a hole. `PrimaryMeetingContext.contextType` is `MeetingContextTypeWithHolder`,
 * and `selectPrimaryMeetingContext` scores `admin` 0 and DROPS it — so an admin-only meeting
 * resolves to no primary context and never reaches this function. Admin meetings are a
 * PLATFORM-axis question (`hasPlatformCapability`, ADR-1035) and are deliberately not joinable
 * through this route.
 *
 * ⚠ WHEN YOU ADD A LABEL: `true` means "there is an `engagements` row whose `status` must be
 * `active`". If you are unsure, `true` is the fail-closed answer — it denies rather than
 * mints.
 */
const CONTEXT_HAS_ENGAGEMENT: Record<PrimaryMeetingContext['contextType'], boolean> = {
  case: true,
  project_kickoff: true,
  package_session: true,
  retainer_checkin: true,
  project_discovery: false,
  request_interaction: false,
};

/**
 * `meetings.scheduled_end` + 24h, as UNIX **SECONDS**.
 *
 * ⚠⚠ SECONDS, NOT MILLISECONDS, AND THE SLIP IS SILENT AND CATASTROPHIC. Daily reads `exp`
 * as seconds; handing it a milliseconds value is accepted without complaint and yields a
 * token expiring roughly fifty thousand years out — i.e. a permanent credential to a private
 * room, with nothing anywhere reporting a problem. `Math.floor` rather than a round so the
 * value can never land a second PAST the intended instant.
 */
export function expiresAtUnixFor(scheduledEnd: Date): number {
  return Math.floor((scheduledEnd.getTime() + MEETING_TOKEN_TTL_AFTER_END_MS) / 1000);
}

/**
 * May a token be minted for this meeting RIGHT NOW, and until when?
 *
 * ⚠ CALL THIS **AFTER** AUTHORIZATION, ALWAYS. See the module docblock's ordering rule.
 *
 * `now` is injected rather than read, so the boundary cases (exactly at, just before, just
 * after) are testable without faking the clock.
 */
export async function assertMeetingJoinable(
  meeting: Meeting,
  subject: PrimaryMeetingContext,
  now: Date = new Date()
): Promise<MeetingJoinableResult> {
  // 1. THE MEETING'S OWN STATE. Terminal set, never an allow-list.
  if (MEETING_CLOSED_TO_JOIN.has(meeting.status)) {
    return deny('meeting_terminal', {
      meetingId: meeting.id,
      contextType: subject.contextType,
      meetingStatus: meeting.status,
    });
  }

  // 2. THE ENGAGEMENT'S LIFECYCLE — the obligation `hasEngagementCapability` refuses.
  //    ⚠ SKIPPED ENTIRELY for the two request-grain types: there is no engagement row to
  //    read, and a read would be a guaranteed `undefined`. Asserted by a test that the
  //    repository is NOT called for those.
  if (CONTEXT_HAS_ENGAGEMENT[subject.contextType]) {
    const engagement = await engagementsRepository.findById(subject.contextId);
    if (engagement === undefined) {
      // Missing OR soft-deleted, indistinguishable by construction (`findById` filters).
      return deny('engagement_missing', {
        meetingId: meeting.id,
        contextType: subject.contextType,
        contextId: subject.contextId,
      });
    }
    if (engagement.status !== 'active') {
      // ⚠⚠ THE FAILURE THIS WHOLE MODULE EXISTS FOR. The delivering expert of a cancelled
      // engagement still holds `host_meetings` — the capability seam never reads status — so
      // without this branch they would be minted a Daily OWNER token for work that was
      // called off.
      return deny('engagement_not_active', {
        meetingId: meeting.id,
        contextType: subject.contextType,
        contextId: subject.contextId,
        engagementStatus: engagement.status,
      });
    }
  }

  // 3. THE TOKEN WINDOW. ⚠ REACHABLE TODAY: nothing transitions a meeting out of `scheduled`
  //    until BAL-134 ships, so a call whose end passed 25 hours ago is still `scheduled` and
  //    sails through step 1. Without this, Daily is handed an `exp` in the past and issues a
  //    DEAD token — a confusing failure two layers downstream of its cause.
  const expiresAtUnix = expiresAtUnixFor(meeting.scheduledEnd);
  const expiresAt = new Date(expiresAtUnix * 1000);
  if (expiresAt.getTime() <= now.getTime()) {
    return deny('token_window_elapsed', {
      meetingId: meeting.id,
      contextType: subject.contextType,
      scheduledEnd: meeting.scheduledEnd.toISOString(),
    });
  }

  return { ok: true, expiresAtUnix, expiresAt };
}

/** The single fail-closed exit. The SHAPE goes to the log; the wire gets one literal. */
function deny(
  reason: LivenessDenialReason,
  fields: Record<string, unknown>
): { readonly ok: false; readonly reason: LivenessDenialReason } {
  log.warn({ ...fields, reason }, 'Meeting not joinable');
  return { ok: false, reason };
}
