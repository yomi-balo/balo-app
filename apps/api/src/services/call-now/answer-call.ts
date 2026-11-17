/**
 * BAL-650 (ADR-1040 Amendment 8 §B, ADR-1058) — THE CLIENT'S COMMIT TO AN EXPERT-STARTED CALL NOW.
 *
 * When the expert rings, nothing has been checked against the client's funding: the check runs
 * "on Join when the expert calls", and "is not an admission gate — no consultation exists before
 * that moment". This service IS that moment. It is the only way a client-side party gets past the
 * hold `joinMeetingAsMember` places on an expert-started `new_meeting` ring (`call_answer_required`).
 *
 * ── SEQUENCE ───────────────────────────────────────────────────────────────────────────────
 *   1. `findByIdForParty` — the user is the ring's CALLEE (the person who booked the case; a
 *      colleague is never rung, ADR-1058) and the ring is an expert-started `new_meeting` ring,
 *      otherwise `ring_not_found`. The identity check is in the query, so ring ids are no oracle
 *   2. `authorizeCallNow` — membership on the case's company (the client side), otherwise
 *      `ring_not_found`. It runs BEFORE any ring state is answered or written, so a callee who has
 *      left the company learns nothing about the ring and ends nothing
 *   3. not `ringing` → `ring_not_ringing`; a ring past `expires_at` is ended `unanswered` first
 *   4. `checkCaseBookingFunding` over `[now, now + 15 min)` at the expert's current rate, with the
 *      ring's own meeting EXCLUDED from the reserved total (it is `scheduled` and ends in the
 *      future, so it would otherwise reserve against its own check). A refusal leaves the ring
 *      ringing and writes nothing, so the client can top up and answer again, or decline
 *   5. `joinMeetingAsMember` with `answeringRingId` — the admission itself, in this same request
 *
 * ⚠⚠ NO FUNDING READ LIVES IN THE JOIN. `join-meeting.ts` imports nothing about funding, so an
 * admission is never a gate (BAL-466 D2). The commit and the admission are one request, so there is
 * nothing to persist between them, and no migration: the hold is at the Daily token. After the ring
 * connects, every join is as it was.
 *
 * ⚠ THE FIGURE NEVER LEAVES THE CLIENT SIDE. Only the callee, authorized as a client-side member,
 * reaches the check, so the top-up figure goes only to the party it prices.
 */
import { meetingRingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  CALL_NOW_SCHEDULED_MINUTES,
  isRingLive,
  ringAwaitsClientCommit,
  type CallRingStatus,
} from '@balo/shared/meetings';
import type { MeetingTokenMinter } from '../daily/meeting-tokens.js';
import {
  checkCaseBookingFunding,
  type CaseBookingFundingCode,
} from '../meetings/case-booking-funding.js';
import {
  joinMeetingAsMember,
  type JoinFailure,
  type JoinMeetingResult,
} from '../meetings/join-meeting.js';
import { authorizeCallNow } from './authorize-call-now.js';
import { endRing } from './end-ring.js';

const log = createLogger('call-now-answer');

const MS_PER_MINUTE = 60_000;

export type AnswerCallNowResult =
  | { ok: true; join: Extract<JoinMeetingResult, { ok: true }> }
  | { ok: false; code: 'ring_not_found' }
  | { ok: false; code: 'ring_not_ringing'; status: CallRingStatus }
  | { ok: false; code: CaseBookingFundingCode; suggestedTopUpMinor: number | null }
  | { ok: false; code: 'join_failed'; failure: JoinFailure };

export interface AnswerCallNowInput {
  readonly ringId: string;
  readonly userId: string;
  readonly now?: Date;
  /** Injection point for tests; the route passes nothing. */
  readonly minter?: MeetingTokenMinter;
}

export async function answerCallNow(input: AnswerCallNowInput): Promise<AnswerCallNowResult> {
  const { ringId, userId } = input;
  const now = input.now ?? new Date();

  const ring = await meetingRingsRepository.findByIdForParty(ringId, userId);
  // The ring's SHAPE (who started it, where it sits) is asked of the same predicate the join's hold
  // uses, with the status held at `ringing`: a ring that has already ended still has this shape and
  // answers `ring_not_ringing` below, not a miss.
  if (
    ring === undefined ||
    ring.calleeUserId !== userId ||
    !ringAwaitsClientCommit({ ...ring, status: 'ringing' })
  ) {
    return { ok: false, code: 'ring_not_found' };
  }

  const authorized = await authorizeCallNow({ engagementId: ring.engagementId, userId });
  if (!authorized.ok || authorized.side !== 'client') {
    log.warn({ ringId, userId, engagementId: ring.engagementId }, 'Call now answer denied');
    return { ok: false, code: 'ring_not_found' };
  }
  const { caseRow } = authorized;

  if (ring.status !== 'ringing') {
    return { ok: false, code: 'ring_not_ringing', status: ring.status };
  }
  if (!isRingLive(ring, now)) {
    const outcome = await endRing({ ringId, to: 'unanswered', actorUserId: null, now });
    return { ok: false, code: 'ring_not_ringing', status: outcome.status ?? 'unanswered' };
  }

  const funding = await checkCaseBookingFunding({
    companyId: caseRow.companyId,
    expertProfileId: caseRow.expertProfileId,
    scheduledStart: now,
    scheduledEnd: new Date(now.getTime() + CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE),
    now,
    excludeMeetingId: ring.meetingId,
  });
  if (!funding.ok) {
    log.info(
      { ringId, userId, engagementId: ring.engagementId, code: funding.code },
      'Call now answer refused — funding'
    );
    return { ok: false, code: funding.code, suggestedTopUpMinor: funding.suggestedTopUpMinor };
  }

  const join = await joinMeetingAsMember({
    meetingId: ring.meetingId,
    userId,
    answeringRingId: ring.id,
    minter: input.minter,
  });
  if (!join.ok) {
    log.warn(
      { ringId, userId, meetingId: ring.meetingId, code: join.code },
      'Call now answer passed funding but the join was refused'
    );
    return { ok: false, code: 'join_failed', failure: join };
  }

  log.info(
    { ringId, userId, meetingId: ring.meetingId, engagementId: ring.engagementId },
    'Call now answered — the client committed and was admitted'
  );
  return { ok: true, join };
}
