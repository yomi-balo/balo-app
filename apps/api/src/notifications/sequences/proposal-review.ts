import {
  clientPartyRecipientsRepository,
  proposalsRepository,
  type ProposalReviewCandidateRow,
} from '@balo/db';
import { proposalAwaitsClientReview } from '@balo/shared/project-requests';
import type { ReminderPayload, ReminderSequence, SequenceEntity } from './types.js';

function earliestSubmittedAt(rows: readonly ProposalReviewCandidateRow[]): Date | null {
  let earliest: Date | null = null;
  for (const row of rows) {
    if (row.submittedAt !== null && (earliest === null || row.submittedAt < earliest)) {
      earliest = row.submittedAt;
    }
  }
  return earliest;
}

/**
 * Pure. Groups candidate rows by request and keeps the requests that still have a proposal
 * awaiting the client's review, by the shared rule. `awaitingCount` is the number of awaiting
 * relationships, the same count the "Review N proposals" card shows. The anchor is the oldest
 * awaiting proposal's submit time; a request whose awaiting rows have none has no entity.
 */
export function proposalReviewEntities(
  rows: readonly ProposalReviewCandidateRow[]
): SequenceEntity[] {
  const byRequest = new Map<string, ProposalReviewCandidateRow[]>();
  for (const row of rows) {
    if (!proposalAwaitsClientReview(row.relationshipStatus, row.proposalStatus)) {
      continue;
    }
    const group = byRequest.get(row.projectRequestId);
    if (group === undefined) {
      byRequest.set(row.projectRequestId, [row]);
    } else {
      group.push(row);
    }
  }

  const entities: SequenceEntity[] = [];
  for (const [projectRequestId, awaiting] of byRequest) {
    const [first] = awaiting;
    const anchor = earliestSubmittedAt(awaiting);
    if (first === undefined || anchor === null) {
      continue;
    }
    entities.push({
      entityId: projectRequestId,
      anchor,
      companyId: first.companyId,
      candidateUserIds: [first.createdByUserId],
      fresh: { awaitingCount: awaiting.length, title: first.title },
    });
  }
  return entities;
}

function freshTitle(entity: SequenceEntity): string {
  return typeof entity.fresh.title === 'string' ? entity.fresh.title : '';
}

function freshAwaitingCount(entity: SequenceEntity): number {
  return typeof entity.fresh.awaitingCount === 'number' ? entity.fresh.awaitingCount : 0;
}

/**
 * The proposal-review follow-up: the client's request creator is reminded while a proposal
 * still awaits their review. The recipient is the person `project.proposal_submitted` notifies,
 * and only while they still hold `participate` on the company.
 */
export const proposalReviewSequence: ReminderSequence = {
  id: 'proposal_review',
  event: 'project.proposal_review_reminder',
  channel: 'email',
  audience: 'client',
  cadence: 'hourly',
  exemptFromDailyLimit: false,

  async find() {
    return proposalReviewEntities(await proposalsRepository.listReviewCandidates());
  },

  async evaluate(entityId) {
    const rows = await proposalsRepository.listReviewCandidates({ projectRequestId: entityId });
    const [entity] = proposalReviewEntities(rows);
    return entity ?? null;
  },

  async resolveRecipients(entity) {
    const participates = await Promise.all(
      entity.candidateUserIds.map((userId) =>
        clientPartyRecipientsRepository.bookerStillParticipatesInCompany(entity.companyId, userId)
      )
    );
    return entity.candidateUserIds.filter((_, index) => participates[index] === true);
  },

  buildPayload(entity, stepKey, recipientUserId, correlationId): ReminderPayload {
    return {
      correlationId,
      sequenceId: 'proposal_review',
      step: stepKey,
      entityId: entity.entityId,
      anchorIso: entity.anchor.toISOString(),
      recipientUserId,
      projectRequestId: entity.entityId,
      title: freshTitle(entity),
      awaitingCount: freshAwaitingCount(entity),
    };
  },
};
