/**
 * BAL-134 / ADR-1049 (§5.4) — THE HUMAN END. Path 5 of the five-path termination taxonomy, and
 * the only one a person initiates.
 *
 * ── THE SEQUENCE, AND WHY EVERY STEP SITS WHERE IT DOES ─────────────────────────────────
 *
 *  1. `authorizeMeetingParticipation` — TENANCY. ⚠ THIS GATE, AND NOT `resolveHostContext`, is
 *     what discharges it: `meeting_contexts.context_id` has no FK and no RLS, and
 *     `resolveHostContext` is an IDENTITY ORACLE that must never be reached on an unvetted
 *     `meetingId`. Everything below runs only after a side is proven.
 *  2. `resolveEndAuthority` — the D6 + D7 composition. Read that module's header before
 *     touching the token choice.
 *  3. NO AUTHORITY → **`404 meeting_not_found`**. ⚠ There is no `403` anywhere on `/meetings/*`
 *     and this surface must not become the exception; the denial SHAPE goes to `log.warn`.
 * 3b. NOT YET LIVE (`now < scheduled_start`) → **`409 meeting_not_started`**. Ending a meeting
 *     that never opened is a CANCELLATION and has its own route; see the gate's own comment for
 *     why the repository's CAS cannot be relied on to stop it.
 *  4. `meetingsRepository.endMeeting` — ONE transaction: close every open interval clamped to
 *     `endedAt`, then a compare-and-set stamping `status`/`ended_at`/`ended_by`/`outcome`
 *     TOGETHER, then the audit row. All three or none.
 *  5. `undefined` (already terminal) → **idempotent `200`** (D10). No teardown, no audit row,
 *     no analytics, no second effect of any kind.
 *  6. RECORDING FINALIZATION — a documented NO-OP seam. See {@link RECORDING_FINALIZATION_SEAM}.
 *  7. TEARDOWN — `deleteRoom`, BEST-EFFORT and NON-FATAL.
 *  8. `meeting_ended` analytics.
 *
 * ── ⚠ THE ENDER NEVER SETS THE OUTCOME (D5) ─────────────────────────────────────────────
 *
 * `outcome: null`, always, on this path. ADR-1049 is explicit — the end endpoint STOPS THE
 * ROOM; BAL-412 resolves the outcome from `meeting_presence`. `meeting_outcome_requires_ended`
 * is one-directional, so `ended` with a NULL outcome is legal and is exactly what this writes.
 * The three SYSTEM paths that are *defined by* their outcome carry one; this one must not.
 */
import { meetingPresenceRepository, meetingsRepository, type Meeting } from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  computeMeetingClocks,
  summarisePresence,
  type MeetingEndedBy,
} from '@balo/shared/meetings';
import { dailyRoomTeardown, type RoomTeardown } from '../daily/rooms.js';
import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';
import { logEndAuthorityDenied, resolveEndAuthority } from './authorize-end-meeting.js';

const log = createLogger('meeting-end');

/**
 * ⚠⚠ THE RECORDING-FINALIZATION SEAM — A DELIBERATE, DOCUMENTED NO-OP.
 *
 * The AC says "the End endpoint finalizes the recording before teardown". **It is satisfied
 * VACUOUSLY, and here is exactly why, verified in this checkout rather than assumed:**
 * `rooms.ts`'s create body sends only `{ name, privacy }`; `meeting-tokens.ts` sends five
 * properties and NONE of them is `start_cloud_recording`; there is no
 * `POST /rooms/:name/recordings/stop` anywhere in the repo; and the one recording-shaped
 * column, `transcripts.recordingRef`, is annotated "no producer". **NOTHING ENABLES RECORDING,
 * SO THERE IS NOTHING TO FINALIZE AND NOTHING TO ORPHAN.**
 *
 * ⚠ DO NOT BUILD A RECORDING REST API TO SATISFY A HYPOTHETICAL. What this constant preserves
 * is the ORDERING CONSTRAINT — stop the recording HERE, after the meeting is terminal in
 * Postgres and BEFORE the room is deleted — so that when recording becomes real the requirement
 * already has a home and a position in the sequence.
 */
export const RECORDING_FINALIZATION_SEAM =
  'BAL-134: if cloud recording is ever enabled, stop it HERE — after the terminal transition, before teardown.';

/**
 * Every wire literal this service produces.
 *
 * ⚠ `meeting_not_found` IS STILL THE ONLY *DENIAL* LITERAL — there is no `403` on `/meetings/*`
 * and this surface is not the exception. `meeting_not_started` is a different KIND of answer: it
 * is only reachable AFTER tenancy and end authority have both been proven, so it confirms
 * nothing to anybody who was not already entitled to know the meeting exists.
 */
export type EndMeetingErrorCode = 'meeting_not_found' | 'meeting_not_started';

export interface EndMeetingInput {
  readonly meetingId: string;
  readonly userId: string;
  /** ⚠ THE INJECTION POINT — tests pass an object literal, so no network and no Daily account. */
  readonly teardown?: RoomTeardown;
  /** Injected so the terminal instant is deterministic in tests. Defaults to now. */
  readonly now?: Date;
}

export type EndMeetingResult =
  | {
      readonly ok: true;
      readonly status: 'ended';
      /**
       * ⚠ `true` MEANS "SOMEBODY ELSE GOT THERE FIRST AND NOTHING HAPPENED THIS TIME" — the D10
       * idempotent success. Two `canEndMeeting` holders can press End simultaneously, and a
       * `409` would surface a routine race as a user-facing error on the one control that must
       * always work.
       */
      readonly alreadyEnded: boolean;
      readonly endedBy: MeetingEndedBy | null;
    }
  | { readonly ok: false; readonly code: EndMeetingErrorCode };

/**
 * Tear the room down. ⚠ BEST-EFFORT AND NON-FATAL, BY DESIGN.
 *
 * The meeting is ALREADY terminal in Postgres and `MEETING_CLOSED_TO_JOIN` already refuses a
 * Balo-side rejoin, so a vendor failure costs nothing that matters: it logs at `error` — the
 * rate is the health signal — and the route still answers `200`. Failing the request instead
 * would mean an ended meeting reported as an error to the person who ended it.
 */
async function tearDownRoom(
  teardown: RoomTeardown,
  meeting: Meeting
): Promise<'deleted' | 'already_gone' | 'failed'> {
  const roomName = meeting.dailyRoomName;
  if (roomName === null) {
    // A `provisioned: false` meeting is a real `201` outcome of `POST /meetings`. Nothing to do.
    return 'already_gone';
  }
  try {
    return await teardown.deleteRoom(roomName);
  } catch (error) {
    log.error(
      {
        meetingId: meeting.id,
        roomName,
        status: 'ended',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Daily room teardown failed — the meeting is still ended and rejoin is still refused Balo-side'
    );
    return 'failed';
  }
}

/**
 * A human with end authority ends the meeting for everyone.
 *
 * ⚠ EVERY DENIAL — no such meeting, soft-deleted, not your party, no authority — collapses into
 * ONE `meeting_not_found`. That matches the whole `/meetings/*` family
 * (`sessionActorErrorStatus`'s "not_found → 404 (also hides existence)"), and it is what stops
 * this endpoint being an existence oracle for anyone holding a guessed uuid.
 */
export async function endMeeting(input: EndMeetingInput): Promise<EndMeetingResult> {
  const { meetingId, userId } = input;
  const teardown = input.teardown ?? dailyRoomTeardown;
  const now = input.now ?? new Date();

  // 1. TENANCY. See the module docblock — this gate, not `resolveHostContext`.
  const authorized = await authorizeMeetingParticipation({ meetingId, userId });
  if (!authorized.ok) {
    return { ok: false, code: 'meeting_not_found' };
  }
  // ⚠ THE GATE'S `meeting` ROW IS READ FOR EXACTLY ONE THING — the LIVENESS gate below.
  // Everything AFTER the transaction reads the row `endMeeting` RETURNS, which is the
  // post-transaction state (`status: 'ended'`, `ended_at` stamped): teardown and analytics must
  // both see the terminal row, not the pre-read one that still says `in_progress`.
  const { meeting, subject, side, companyId } = authorized;

  // 2. END AUTHORITY — D6 + D7, composed in exactly one place.
  const authority = await resolveEndAuthority({ userId, companyId, subject });
  if (!authority.canEndMeeting || authority.endedBy === null) {
    // 3. ⚠ 404, NOT 403. The shape goes to the log; the wire gets one literal.
    logEndAuthorityDenied(meetingId, userId, authority, side);
    return { ok: false, code: 'meeting_not_found' };
  }

  // 3b. ⚠⚠ LIVENESS. **ENDING A MEETING THAT NEVER OPENED IS A CANCELLATION, AND CANCELLATION
  //     HAS ITS OWN ROUTE.** Without this gate the repository's compare-and-set — an EXCLUSION
  //     (`status NOT IN ('ended','cancelled')`), so `scheduled` is endable — let ANY end-
  //     authority holder destroy a consultation DAYS IN THE FUTURE with one POST. And
  //     `CONSUME_CREDITS` is in `MEMBER_BUNDLE`, so that is any plain company member, not just
  //     an owner. The damage is IRREVERSIBLE and total: `status='ended'`, the Daily room
  //     deleted, rejoin refused, and `MEETING_TRANSITIONS.ended === []` so there is no way back.
  //     It also bypasses `meetingsRepository.cancel` entirely — no counterparty notification, no
  //     `cancelled` outcome, and the expert's slot stays blocked
  //     (`consultationStatusForMeeting` maps every non-`cancelled` label to `confirmed`).
  //
  //     ⚠ EVERY SWEEP RULE CARRIES A WALL-CLOCK PRECONDITION ANCHORED ON `scheduledStart` for
  //     exactly this reason; the human path had none. `now >= scheduledStart` is the MINIMUM
  //     honest one: it still admits the whole in-window life of the meeting, including the
  //     missed-call window where `scheduled` is a legitimate thing to end.
  if (now.getTime() < meeting.scheduledStart.getTime()) {
    log.warn(
      {
        meetingId,
        userId,
        status: meeting.status,
        scheduledStart: meeting.scheduledStart.toISOString(),
      },
      'Meeting end refused — the consultation has not started yet; ending it would be a cancellation'
    );
    return { ok: false, code: 'meeting_not_started' };
  }

  // 4. THE ONE TRANSACTION. ⚠ `outcome: null` — the ender never sets the outcome (D5).
  const ended = await meetingsRepository.endMeeting({
    id: meetingId,
    outcome: null,
    endedBy: authority.endedBy,
    endedAt: now,
    actorUserId: userId,
  });

  // 5. ALREADY TERMINAL → the idempotent success. ⚠ NOTHING ELSE RUNS: no teardown, no audit
  //    row, no analytics. The repository rolled its whole transaction back, so "returned
  //    undefined" and "changed nothing" are the same statement.
  if (ended === undefined) {
    log.info({ meetingId, userId }, 'Meeting end was a no-op — already terminal');
    return { ok: true, status: 'ended', alreadyEnded: true, endedBy: null };
  }

  // 6. RECORDING FINALIZATION — {@link RECORDING_FINALIZATION_SEAM}. Vacuous today, by
  //    verification rather than by assumption. The POSITION is the deliverable.

  // 7. TEARDOWN — best-effort, after the meeting is terminal, before we answer.
  const teardownOutcome = await tearDownRoom(teardown, ended.meeting);

  // 8. ANALYTICS, from the presence rows this transaction just closed.
  await emitMeetingEnded({
    meeting: ended.meeting,
    endedBy: authority.endedBy,
    actorUserId: userId,
    now,
  });

  log.info(
    {
      meetingId,
      userId,
      endedBy: authority.endedBy,
      closedIntervals: ended.closedIntervals,
      teardown: teardownOutcome,
    },
    'Meeting ended'
  );
  return { ok: true, status: 'ended', alreadyEnded: false, endedBy: authority.endedBy };
}

/**
 * Emit `meeting_ended` from the meeting's LIVE presence rows.
 *
 * ⚠ EXPORTED, because ALL FIVE terminal paths must emit the same event with the same shape and
 * the sweep is the other four. One definition, one place to get `distinct_id` right.
 *
 * ⚠ `distinct_id` IS THE ACTING USER ON A HUMAN END AND THE **MEETING ID** ON A SYSTEM PATH —
 * `trackServer` promotes it to PostHog's `distinctId`, and the cast means a missing property
 * silently becomes `undefined`, i.e. an event attributed to nobody. The system paths have no
 * acting human; the meeting id is the same non-user shape `guest_joined` already uses.
 *
 * ⚠ THE CLOCKS ARE READ AT `ended_at`, NOT AT THE WALL CLOCK. `endMeeting` closed every open
 * interval inside its transaction, so the two agree — but passing the instant explicitly means
 * a slow teardown between the commit and this call cannot inflate the reported duration.
 */
export async function emitMeetingEnded(input: {
  readonly meeting: Meeting;
  readonly endedBy: MeetingEndedBy;
  readonly actorUserId: string | null;
  readonly now: Date;
}): Promise<void> {
  const { meeting, endedBy, actorUserId, now } = input;
  const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
  const clocks = computeMeetingClocks(
    rows.map((row) => ({ party: row.party, joinedAt: row.joinedAt, leftAt: row.leftAt })),
    meeting.endedAt ?? now
  );

  trackServer(MEETING_SERVER_EVENTS.MEETING_ENDED, {
    meeting_id: meeting.id,
    // ⚠ MEASUREMENT, NOT MONEY. BAL-412 settles; this ticket only produces the numbers.
    billable_seconds: Math.round(clocks.billableMs / 1000),
    expert_present_seconds: Math.round(clocks.expertPresentMs / 1000),
    participant_count: rows.length,
    outcome: meeting.outcome,
    ended_by: endedBy,
    distinct_id: actorUserId ?? meeting.id,
  });
}

/**
 * The presence facts behind a meeting, for the sweep and for tests.
 *
 * ⚠ HERE RATHER THAN IN THE SWEEP because both the sweep and the end path need the same
 * reduction and two copies would be two answers to "what happened in this room". Pure summary
 * of live rows; reads no clock.
 */
export async function loadPresenceFacts(
  meetingId: string
): Promise<ReturnType<typeof summarisePresence>> {
  const rows = await meetingPresenceRepository.listByMeeting(meetingId);
  return summarisePresence(
    rows.map((row) => ({ party: row.party, joinedAt: row.joinedAt, leftAt: row.leftAt }))
  );
}
