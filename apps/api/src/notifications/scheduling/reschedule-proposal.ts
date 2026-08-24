/**
 * BAL-411 (§D1 / "Scheduled reminder") — the ONE BAL-420 promise this ticket owns: "the client
 * still hasn't answered a pending reschedule proposal, and the original start is under 24h
 * away." Modelled line-for-line on `meeting-absence.ts`.
 *
 * ── CANCELLATION IS AN OPTIMISATION. THE RECHECK IS THE AUTHORITY. ────────────────────────
 * `cancelScheduledNotification` runs in every answer transaction (accept / decline / withdraw),
 * but a claimed row is deliberately uncancellable and zero-cancelled is normal
 * (`schedule.ts`). `rescheduleProposalUnansweredRecheck` independently re-reads the proposal
 * and the meeting at FIRE time and skips a non-pending / expired / stale / not-reschedulable
 * proposal, so a promise that outran its cancel still nags nobody.
 *
 * ⚠ `correlationId` IS A FRESH uuid PER SCHEDULE CALL, NEVER STABLE — the
 * `meeting-absence.ts` precedent, and for the same reason: schedule dedup is scoped to the
 * PENDING window only, so a schedule call landing inside a claim window creates a genuine
 * SECOND promise, and a stable correlationId would make that second publish a silent BullMQ
 * no-op (`publisher.publish` derives the jobId from it). The recheck SPREADS `row.payload`, so
 * the id survives a rebuild.
 */
import { randomUUID } from 'node:crypto';
import {
  meetingsRepository,
  partyMembershipsRepository,
  rescheduleProposalsRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { resolveRescheduleRefusal } from '@balo/shared/meetings';
import { scheduleNotification, type ScheduleExecutor } from './schedule.js';
import type { ScheduledRecheck } from './rechecks.js';

const log = createLogger('reschedule-proposal-scheduling');

/** The registry key. ⚠ Must match `SCHEDULED_RECHECKS` in `rechecks.ts`. */
export const RESCHEDULE_PROPOSAL_UNANSWERED_RECHECK = 'reschedule_proposal_unanswered';

/** Dedup + cancel handle — one live promise per proposal. */
export function rescheduleProposalUnansweredKey(proposalId: string): string {
  return `reschedule_proposal_unanswered:${proposalId}`;
}

/** How far ahead of the original start the reminder fires — the ticket's "<~24h" AC. */
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

function readNonEmptyString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * THE FIRE-TIME GUARD. Runs after the claim, on live state, and returns a payload rather than a
 * boolean — see `rechecks.ts`'s own docblock for why. Every skip reason is a distinct fact; a
 * skip is a NORMAL outcome (`log.info`, never `last_error`).
 */
export const rescheduleProposalUnansweredRecheck: ScheduledRecheck = async (row) => {
  const proposalId = readNonEmptyString(row.payload, 'proposalId');
  const meetingId = readNonEmptyString(row.payload, 'meetingId');
  const companyId = readNonEmptyString(row.payload, 'companyId');
  if (proposalId === null || meetingId === null || companyId === null) {
    return { publish: false, reason: 'malformed_payload' };
  }

  // ⚠ `findPendingForAnswer` DOES NOT FILTER `status` — deliberately (see its docblock). This
  // recheck is exactly the call site that needs to distinguish `proposal_missing` from
  // `proposal_answered` from `proposal_expired`, which a status-filtered read would collapse.
  const found = await rescheduleProposalsRepository.findPendingForAnswer({ proposalId, meetingId });
  if (found === undefined) {
    return { publish: false, reason: 'proposal_missing' };
  }
  const { proposal } = found;
  if (proposal.status !== 'pending') {
    return { publish: false, reason: 'proposal_answered' };
  }

  const now = new Date();
  if (proposal.expiresAt.getTime() <= now.getTime()) {
    return { publish: false, reason: 'proposal_expired' };
  }

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return { publish: false, reason: 'proposal_missing' };
  }
  if (resolveRescheduleRefusal(meeting.status, meeting.scheduledStart, now) !== null) {
    return { publish: false, reason: 'meeting_not_reschedulable' };
  }
  if (meeting.scheduledStart.getTime() !== proposal.originalScheduledStart.getTime()) {
    return { publish: false, reason: 'proposal_stale' };
  }

  // ⚠ REBUILT FROM LIVE MEMBERSHIP, NEVER INHERITED (`meeting-absence.ts`'s own rule). The
  // widest set reachable without an untested new repository method is the company's
  // MANAGE_MEMBERS holders — the same `meeting.client_absent` residual, recorded there and
  // inherited here rather than re-litigated.
  const recipientUserIds = await partyMembershipsRepository.listAdminUserIds('company', companyId);
  if (recipientUserIds.length === 0) {
    log.warn(
      { proposalId, meetingId, companyId },
      'Reschedule proposal reminder has no live recipient on the client company — skipping rather than recording a delivery that reached nobody'
    );
    return { publish: false, reason: 'no_recipients' };
  }

  log.info(
    { proposalId, meetingId, recipientCount: recipientUserIds.length },
    'Reschedule proposal still unanswered — publishing the reminder'
  );
  return { publish: true, payload: { ...row.payload, recipientUserIds } };
};

export interface ScheduleRescheduleProposalReminderInput {
  readonly proposalId: string;
  readonly meetingId: string;
  readonly engagementId: string;
  /** The CLIENT company — seeded on the payload so the recheck can rebuild recipients without
   *  re-answering "who owns this meeting". */
  readonly companyId: string;
  readonly expertPartyLabel: string;
  readonly caseTitle: string;
  readonly originalScheduledStart: Date;
  readonly optionCount: number;
  readonly now: Date;
}

/**
 * ARM the reminder for `originalScheduledStart − 24h`, unless that instant has already passed
 * — a proposal made INSIDE the 24h window would otherwise fire seconds after the proposal
 * itself. The client is already being told right now (and by SMS if `<2h` out), so the promise
 * is simply not armed, and the propose path logs why.
 *
 * ⚠ TAKES THE CALLER'S `exec` (a transaction) — armed inside the SAME transaction as the
 * proposal write, so the promise and the row it is about commit together or not at all.
 */
export async function scheduleRescheduleProposalReminder(
  input: ScheduleRescheduleProposalReminderInput,
  exec: ScheduleExecutor
): Promise<void> {
  const fireAt = new Date(input.originalScheduledStart.getTime() - REMINDER_LEAD_MS);
  if (fireAt.getTime() <= input.now.getTime()) {
    log.info(
      { proposalId: input.proposalId, meetingId: input.meetingId },
      'Reschedule proposal reminder not armed — already inside the reminder window'
    );
    return;
  }

  const { outcome } = await scheduleNotification(
    'reschedule_proposal.unanswered',
    {
      correlationId: randomUUID(),
      proposalId: input.proposalId,
      meetingId: input.meetingId,
      engagementId: input.engagementId,
      companyId: input.companyId,
      // Seeded empty, REBUILT by the recheck at fire time — see the guard above.
      recipientUserIds: [],
      expertPartyLabel: input.expertPartyLabel,
      caseTitle: input.caseTitle,
      originalScheduledStartIso: input.originalScheduledStart.toISOString(),
      optionCount: input.optionCount,
    },
    {
      key: rescheduleProposalUnansweredKey(input.proposalId),
      at: fireAt,
      mode: 'first_wins',
      recheck: RESCHEDULE_PROPOSAL_UNANSWERED_RECHECK,
    },
    exec
  );
  log.info(
    { proposalId: input.proposalId, meetingId: input.meetingId, outcome },
    'Reschedule proposal reminder armed'
  );
}
