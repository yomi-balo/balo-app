import {
  conversationsRepository,
  requestExpertRelationshipsRepository,
  type InvitationReminderCandidateRow,
} from '@balo/db';
import { expertInvitationMove } from '@balo/shared/project-requests';
import type { EventPayloadMap } from '../events.js';
import type { ReminderSequence, SequenceEntity } from './types.js';

/**
 * How far back `find` looks for invitations. The last step falls by day 3, plus up to three days
 * of weekday-morning slip and the 24h grace of `planDueSteps`, about seven days; this leaves a
 * wide margin so an outage never strands a step.
 */
export const INVITATION_FIND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Pure. Keeps the invited experts whose Your move card would still show, by the shared rule,
 * and maps each to its entity: the relationship, anchored on `invited_at`, whose only candidate
 * is the invited expert's own user.
 */
export function invitationEntities(
  rows: readonly InvitationReminderCandidateRow[],
  expertWrote: ReadonlySet<string>
): SequenceEntity[] {
  const entities: SequenceEntity[] = [];
  for (const row of rows) {
    const move = expertInvitationMove({
      requestStatus: row.requestStatus,
      relationshipStatus: row.relationshipStatus,
      onDirectLeg: row.onDirectLeg,
      availabilityShared: row.availabilitySharedAt !== null,
      sentMessage: expertWrote.has(row.relationshipId),
    });
    if (move === null) {
      continue;
    }
    entities.push({
      entityId: row.relationshipId,
      anchor: row.invitedAt,
      companyId: row.companyId,
      candidateUserIds: [row.expertUserId],
      fresh: {
        title: row.title,
        projectRequestId: row.projectRequestId,
        companyName: row.companyName,
      },
    });
  }
  return entities;
}

async function entitiesFor(
  rows: readonly InvitationReminderCandidateRow[]
): Promise<SequenceEntity[]> {
  const expertWrote = await conversationsRepository.relationshipsWithExpertMessage(
    rows.map((row) => row.relationshipId)
  );
  return invitationEntities(rows, expertWrote);
}

function freshString(entity: SequenceEntity, field: string): string {
  const value = entity.fresh[field];
  return typeof value === 'string' ? value : '';
}

/**
 * The invitation follow-up: an invited expert is reminded while the Your move card for the
 * invitation, or the direct-request choice, would still show. The recipient is the expert
 * profile's own user, never an agency owner or admin.
 */
export const invitationSequence: ReminderSequence<'project.invitation_reminder'> = {
  id: 'invitation',
  event: 'project.invitation_reminder',
  entityIdField: 'relationshipId',
  channel: 'email',
  audience: 'expert',
  cadence: 'hourly',
  exemptFromDailyLimit: false,

  async find(now) {
    const rows = await requestExpertRelationshipsRepository.listInvitationReminderCandidates({
      invitedSince: new Date(now.getTime() - INVITATION_FIND_WINDOW_MS),
    });
    return entitiesFor(rows);
  },

  async evaluate(entityId) {
    const rows = await requestExpertRelationshipsRepository.listInvitationReminderCandidates({
      relationshipId: entityId,
    });
    const [entity] = await entitiesFor(rows);
    return entity ?? null;
  },

  resolveRecipients(entity) {
    return Promise.resolve(entity.candidateUserIds);
  },

  buildPayload(
    entity,
    stepKey,
    recipientUserId,
    correlationId
  ): EventPayloadMap['project.invitation_reminder'] {
    return {
      correlationId,
      sequenceId: 'invitation',
      step: stepKey,
      entityId: entity.entityId,
      anchorIso: entity.anchor.toISOString(),
      recipientUserId,
      relationshipId: entity.entityId,
      projectRequestId: freshString(entity, 'projectRequestId'),
      title: freshString(entity, 'title'),
      companyName: freshString(entity, 'companyName'),
    };
  },
};
