import {
  clientPartyRecipientsRepository,
  proposalsRepository,
  type ProposalReviewCandidateRow,
} from '@balo/db';
import { REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT } from '@balo/shared/notifications';
import { proposalReviewWait } from '@balo/shared/project-requests';
import type { ReminderSequence, SequenceEntity } from './types.js';

/**
 * Pure. Groups candidate rows by request and keeps the requests that still await the client's
 * review, by the shared `proposalReviewWait` rule: `awaitingCount` is the number of awaiting
 * relationships, the same count the "Review N proposals" card shows, and the anchor is the oldest
 * awaiting proposal's submit time. A request with no such wait has no entity.
 */
export function proposalReviewEntities(
  rows: readonly ProposalReviewCandidateRow[]
): SequenceEntity[] {
  const byRequest = new Map<string, ProposalReviewCandidateRow[]>();
  for (const row of rows) {
    const group = byRequest.get(row.projectRequestId);
    if (group === undefined) {
      byRequest.set(row.projectRequestId, [row]);
    } else {
      group.push(row);
    }
  }

  const entities: SequenceEntity[] = [];
  for (const [projectRequestId, candidates] of byRequest) {
    const [first] = candidates;
    const wait = proposalReviewWait(candidates);
    if (first === undefined || wait === null) {
      continue;
    }
    entities.push({
      entityId: projectRequestId,
      anchor: wait.anchor,
      companyId: first.companyId,
      candidateUserIds: [first.createdByUserId],
      fresh: { awaitingCount: wait.awaitingCount, title: first.title },
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
export const proposalReviewSequence: ReminderSequence<'project.proposal_review_reminder'> = {
  id: 'proposal_review',
  event: 'project.proposal_review_reminder',
  channels: ['email'],
  audience: 'client',
  cadence: 'hourly',
  exemptFromDailyLimit: REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT.proposal_review,

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

  payloadMatchesEntity(payload, entityId) {
    return payload.projectRequestId === entityId;
  },

  buildPayload(entity, stepKey, recipientUserId, correlationId) {
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
