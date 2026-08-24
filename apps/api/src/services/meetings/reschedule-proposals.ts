/**
 * BAL-411 — THE RESCHEDULE-PROPOSAL SERVICE: propose / withdraw / accept / decline. Owns the
 * arm/cancel of the BAL-420 "unanswered" promise and, on accept, the call into the shipped
 * BAL-409 `rescheduleMeeting` seam.
 *
 * ⚠ NO AUTHORIZATION HERE. Both axes (`authorizeMeetingRescheduleProposal` for propose/
 * withdraw, `authorizeMeetingReschedule` for accept/decline — reused unchanged) are the
 * ROUTE's job, exactly as `meeting-availability.ts`'s own docblock states for its four
 * functions. This module receives already-authorized, already-validated input.
 *
 * ⚠ NO ROUTE-LEVEL VALIDATION EITHER (Zod, rate limits, `validateBookingWindow`,
 * `resolveRescheduleRefusal`, `isWindowAvailableForExpert`). Those stay in the routes so this
 * module is a clean, unit-testable seam over the repository + the BAL-420 promise +
 * `rescheduleMeeting`.
 *
 * ⚠ EVERY WRITE PATH OPENS ITS OWN `db.transaction` (the `end-session.ts` precedent) so the
 * repository CAS and the promise arm/cancel commit together or not at all — the outbox
 * property `scheduleNotification`'s docblock demands.
 */
import { db, rescheduleProposalsRepository } from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import { cancelScheduledNotification } from '../../notifications/scheduling/schedule.js';
import {
  rescheduleProposalUnansweredKey,
  scheduleRescheduleProposalReminder,
} from '../../notifications/scheduling/reschedule-proposal.js';
import { rescheduleMeeting } from './meeting-availability.js';

// ── propose ──────────────────────────────────────────────────────────────────────────────

export interface ProposeRescheduleOptionInput {
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
}

export interface ProposeRescheduleServiceInput {
  readonly meetingId: string;
  readonly engagementId: string;
  /** The CLIENT company — for the BAL-420 reminder payload's recipient-rebuild seed. */
  readonly companyId: string;
  readonly expertPartyLabel: string;
  readonly caseTitle: string;
  readonly proposedByUserId: string;
  /** The meeting's `scheduled_start` as read in THIS request — the staleness anchor, and
   *  (§D3) the deadline: today's writer sets `expires_at` equal to it. */
  readonly originalScheduledStart: Date;
  readonly options: readonly ProposeRescheduleOptionInput[];
  readonly now: Date;
}

/**
 * Create the proposal + its options, and (unless the reminder window has already begun) arm
 * the BAL-420 "unanswered" promise — in ONE transaction. `RescheduleProposalAlreadyPendingError`
 * (thrown by the repository) propagates to the caller uncaught; the ROUTE maps it to 409
 * `proposal_already_pending`.
 */
export async function proposeReschedule(
  input: ProposeRescheduleServiceInput,
  log: FastifyBaseLogger
): Promise<{
  readonly proposal: Awaited<ReturnType<typeof rescheduleProposalsRepository.propose>>['proposal'];
  readonly options: Awaited<ReturnType<typeof rescheduleProposalsRepository.propose>>['options'];
}> {
  // The deadline IS the original start — see the DB CHECK
  // `reschedule_proposal_expires_within_window` (`<=`) and §D3's "today's writer sets them
  // equal".
  const expiresAt = input.originalScheduledStart;

  const created = await db.transaction(async (tx) => {
    const result = await rescheduleProposalsRepository.propose(
      {
        meetingId: input.meetingId,
        proposedByUserId: input.proposedByUserId,
        originalScheduledStart: input.originalScheduledStart,
        expiresAt,
        options: input.options,
      },
      input.now,
      tx
    );

    await scheduleRescheduleProposalReminder(
      {
        proposalId: result.proposal.id,
        meetingId: input.meetingId,
        engagementId: input.engagementId,
        companyId: input.companyId,
        expertPartyLabel: input.expertPartyLabel,
        caseTitle: input.caseTitle,
        originalScheduledStart: input.originalScheduledStart,
        optionCount: result.options.length,
        now: input.now,
      },
      tx
    );

    return result;
  });

  log.info(
    {
      proposalId: created.proposal.id,
      meetingId: input.meetingId,
      optionCount: created.options.length,
    },
    'Reschedule proposal proposed'
  );
  return created;
}

// ── withdraw / decline (identical shape, different actor) ──────────────────────────────────

export interface AnswerRescheduleServiceInput {
  readonly proposalId: string;
  readonly meetingId: string;
  readonly actorUserId: string;
  readonly now: Date;
}

/**
 * Fix round 1 item 9 — the TX BODY shared by `withdrawRescheduleProposal` and
 * `declineRescheduleProposal`: CAS the repository answer, cancel the BAL-420 promise on a hit,
 * log on success. `repositoryAnswer` is `rescheduleProposalsRepository.withdraw` or `.decline` —
 * the two repository methods this module's own docblock (§header) already calls "identical
 * shape, different actor"; only which CAS runs and the past-tense verb in the log line differ.
 */
async function answerRescheduleProposal(
  repositoryAnswer: typeof rescheduleProposalsRepository.withdraw,
  input: AnswerRescheduleServiceInput,
  log: FastifyBaseLogger,
  pastTenseVerb: 'withdrawn' | 'declined'
): ReturnType<typeof rescheduleProposalsRepository.withdraw> {
  const result = await db.transaction(async (tx) => {
    const proposal = await repositoryAnswer(
      { proposalId: input.proposalId, meetingId: input.meetingId, actorUserId: input.actorUserId },
      input.now,
      tx
    );
    if (proposal === undefined) {
      return undefined;
    }
    // Zero cancelled is normal — the promise may already have fired, or a claimed row is
    // deliberately uncancellable (the fire-time recheck is the authority either way).
    await cancelScheduledNotification(rescheduleProposalUnansweredKey(input.proposalId), tx);
    return proposal;
  });

  if (result !== undefined) {
    log.info(
      { proposalId: input.proposalId, meetingId: input.meetingId },
      `Reschedule proposal ${pastTenseVerb}`
    );
  }
  return result;
}

/**
 * THE EXPERT PULLS THEIR OWN ASK BACK. `undefined` ⇒ the caller answers 409
 * `proposal_not_answerable` — most often because the client already accepted.
 */
export async function withdrawRescheduleProposal(
  input: AnswerRescheduleServiceInput,
  log: FastifyBaseLogger
): ReturnType<typeof rescheduleProposalsRepository.withdraw> {
  return answerRescheduleProposal(rescheduleProposalsRepository.withdraw, input, log, 'withdrawn');
}

/**
 * THE CLIENT KEEPS THEIR ORIGINAL TIME. `undefined` ⇒ 409 `proposal_not_answerable`.
 */
export async function declineRescheduleProposal(
  input: AnswerRescheduleServiceInput,
  log: FastifyBaseLogger
): ReturnType<typeof rescheduleProposalsRepository.decline> {
  return answerRescheduleProposal(rescheduleProposalsRepository.decline, input, log, 'declined');
}

// ── accept ───────────────────────────────────────────────────────────────────────────────

export interface AcceptRescheduleServiceInput extends AnswerRescheduleServiceInput {
  readonly optionId: string;
  /** Re-pinned from the meeting's OWN duration at accept time (§D7 step 7) — the CALLER's
   *  obligation; this module trusts what it is handed. */
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
}

export interface AcceptRescheduleServiceResult {
  readonly proposalId: string;
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly previousScheduledStart: Date;
  readonly previousScheduledEnd: Date;
  /** The `meeting.rescheduled` audit row id — the caller's `booking.rescheduled` dedup key. */
  readonly rescheduleAuditId: string;
}

/**
 * THE TWO-PHASE COMMIT (§D7 step 9).
 *
 *   TX1 — CAS `pending → accepted` (+ the winning option's `accepted_at`) AND cancel the
 *   BAL-420 promise, together. `undefined` ⇒ the CAS lost the race (already answered, expired,
 *   or the named option does not belong to this proposal) ⇒ caller answers 409
 *   `proposal_not_answerable`.
 *
 *   THEN `rescheduleMeeting` — the unchanged BAL-409 service, OUTSIDE the DB transaction (its
 *   own rule: no vendor/Redis call inside one). On failure — realistically
 *   `MeetingNotReschedulableError`, the TOCTOU backstop — the answer is REVERTED to `pending`
 *   (best-effort; a lost reminder row is acceptable, the recheck is the authority) and the
 *   error RE-THROWN so the route maps it. NEVER the reverse ordering: a committed move with a
 *   still-`pending` proposal would invite a second accept.
 */
export async function acceptRescheduleProposal(
  input: AcceptRescheduleServiceInput,
  log: FastifyBaseLogger
): Promise<AcceptRescheduleServiceResult | undefined> {
  const answered = await db.transaction(async (tx) => {
    const accepted = await rescheduleProposalsRepository.accept(
      {
        proposalId: input.proposalId,
        meetingId: input.meetingId,
        optionId: input.optionId,
        actorUserId: input.actorUserId,
      },
      input.now,
      tx
    );
    if (accepted === undefined) {
      return undefined;
    }
    await cancelScheduledNotification(rescheduleProposalUnansweredKey(input.proposalId), tx);
    return accepted;
  });

  if (answered === undefined) {
    return undefined;
  }

  try {
    const result = await rescheduleMeeting(
      input.meetingId,
      { scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd },
      input.actorUserId,
      log
    );

    log.info(
      { proposalId: input.proposalId, meetingId: input.meetingId },
      'Reschedule proposal accepted'
    );

    return {
      proposalId: input.proposalId,
      meetingId: input.meetingId,
      scheduledStart: result.meeting.scheduledStart,
      scheduledEnd: result.meeting.scheduledEnd,
      previousScheduledStart: result.previous.scheduledStart,
      previousScheduledEnd: result.previous.scheduledEnd,
      rescheduleAuditId: result.rescheduleAuditId,
    };
  } catch (error) {
    // Fix round 1 item 6 — the revert gets its OWN try/catch. A rejecting `revertAccept` must
    // never replace the ORIGINAL error: the route's `instanceof MeetingNotReschedulableError`
    // branch has to see the real thing to answer 409 `meeting_not_reschedulable` instead of a
    // bare 500, and both failures need their own `log.error` (CLAUDE.md: log at every caught
    // boundary) rather than one line describing only whichever error happened to run last.
    let reverted: Awaited<ReturnType<typeof rescheduleProposalsRepository.revertAccept>>;
    try {
      reverted = await rescheduleProposalsRepository.revertAccept({
        proposalId: input.proposalId,
        // The anchor from BEFORE this accept's move, so the CAS is a no-op if
        // `rescheduleMeeting` actually committed (see the repository docblock).
        expectedOriginalScheduledStart: answered.proposal.originalScheduledStart,
      });
    } catch (revertError) {
      log.error(
        {
          proposalId: input.proposalId,
          meetingId: input.meetingId,
          error: revertError instanceof Error ? revertError.message : String(revertError),
          stack: revertError instanceof Error ? revertError.stack : undefined,
        },
        'Reschedule proposal revertAccept itself failed — proposal state is now inconsistent'
      );
      log.error(
        {
          proposalId: input.proposalId,
          meetingId: input.meetingId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Reschedule proposal accepted but the meeting move failed — revert ALSO failed'
      );
      // Re-throw the ORIGINAL error, never the revert's — see the comment above the try.
      throw error;
    }
    log.error(
      {
        proposalId: input.proposalId,
        meetingId: input.meetingId,
        reverted: reverted !== undefined,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Reschedule proposal accepted but the meeting move failed — reverted to pending'
    );
    // Re-thrown so the ROUTE's own error mapping (the `MeetingNotReschedulableError` → 409
    // `meeting_not_reschedulable` boundary, NO message echo) stays the single place that
    // decision is made — matching `reschedule.ts`'s own posture.
    throw error;
  }
}
