import { db } from '../../client';
import { rescheduleProposals, rescheduleProposalOptions } from '../../schema';
import type {
  NewRescheduleProposal,
  RescheduleProposal,
  RescheduleProposalOption,
} from '../../schema';
import { meetingFactory } from './meeting.factory';
import { userFactory } from './user.factory';

const HOUR_MS = 3_600_000;

/** One seeded option. `position` defaults to the array index. */
export interface RescheduleProposalFactoryOption {
  scheduledStart: Date;
  scheduledEnd: Date;
  position?: number;
  acceptedAt?: Date | null;
  deletedAt?: Date | null;
}

interface RescheduleProposalFactoryOverrides {
  /** Attach to an existing meeting instead of seeding a fresh one. */
  meetingId?: string;
  /** Reuse an existing proposer instead of seeding a fresh user. */
  proposedByUserId?: string;
  /**
   * The meeting's `scheduled_start` at propose time. Defaults to the seeded meeting's own
   * `scheduled_start`; pass it explicitly when attaching to a caller-supplied `meetingId`,
   * or the staleness anchor will not match that meeting.
   */
  originalScheduledStart?: Date;
  /** Defaults to ONE option two hours after the original start. Pass `[]` for none. */
  options?: RescheduleProposalFactoryOption[];
  /** Row-level overrides (status, expiresAt, resolvedAt, resolvedByUserId, deletedAt, …). */
  values?: Partial<NewRescheduleProposal>;
}

export interface RescheduleProposalFactoryResult {
  proposal: RescheduleProposal;
  options: RescheduleProposalOption[];
  meetingId: string;
  proposedByUserId: string;
}

/**
 * Seeds one `reschedule_proposals` row (default `status='pending'`, anchored on a fresh
 * meeting, `expires_at = original_scheduled_start`) plus its option rows.
 *
 * Inserts DIRECTLY via `db`, never through `rescheduleProposalsRepository.propose()`, so a
 * test can seed ANY state the repository will not produce by design — a LAPSED pending row,
 * a terminal one, a soft-deleted one, an option with `accepted_at` already stamped. Same
 * rationale as `meeting.factory` / `scheduled-notification.factory`: the repository's write
 * path is the thing UNDER test, so it must not also be the only route to a fixture.
 *
 * ⚠ CONVENIENCE WITH ONE RULE ATTACHED: when `values.status` is a terminal label and no
 * `resolvedAt` is given, one is stamped, because `reschedule_proposal_resolution_paired`
 * refuses the insert otherwise. Pass `resolvedAt` explicitly to probe that CHECK.
 */
export async function rescheduleProposalFactory(
  overrides: RescheduleProposalFactoryOverrides = {}
): Promise<RescheduleProposalFactoryResult> {
  let meetingId = overrides.meetingId;
  let seededMeetingStart: Date | undefined;
  if (meetingId === undefined) {
    const seeded = await meetingFactory({ contexts: [] });
    meetingId = seeded.meeting.id;
    seededMeetingStart = seeded.meeting.scheduledStart;
  }
  const proposedByUserId = overrides.proposedByUserId ?? (await userFactory()).id;

  // ⚠ Defaults to the SEEDED meeting's own `scheduled_start`, to the millisecond — a
  // proposal that is stale against its own meeting is a fixture nobody meant to write.
  const originalScheduledStart =
    overrides.originalScheduledStart ?? seededMeetingStart ?? new Date(Date.now() + HOUR_MS);

  const status = overrides.values?.status ?? 'pending';
  const resolvedAt =
    overrides.values?.resolvedAt !== undefined
      ? overrides.values.resolvedAt
      : status === 'pending'
        ? null
        : new Date();

  const [proposal] = await db
    .insert(rescheduleProposals)
    .values({
      meetingId,
      proposedByUserId,
      originalScheduledStart,
      expiresAt: originalScheduledStart,
      ...overrides.values,
      status,
      resolvedAt,
    })
    .returning();
  if (proposal === undefined) {
    throw new Error('reschedule proposal insert failed');
  }

  const optionInputs = overrides.options ?? [
    {
      scheduledStart: new Date(originalScheduledStart.getTime() + 2 * HOUR_MS),
      scheduledEnd: new Date(originalScheduledStart.getTime() + 3 * HOUR_MS),
    },
  ];

  const options =
    optionInputs.length === 0
      ? []
      : await db
          .insert(rescheduleProposalOptions)
          .values(
            optionInputs.map((option, index) => ({
              proposalId: proposal.id,
              position: option.position ?? index,
              scheduledStart: option.scheduledStart,
              scheduledEnd: option.scheduledEnd,
              acceptedAt: option.acceptedAt ?? null,
              deletedAt: option.deletedAt ?? null,
            }))
          )
          .returning();

  return { proposal, options, meetingId, proposedByUserId };
}
