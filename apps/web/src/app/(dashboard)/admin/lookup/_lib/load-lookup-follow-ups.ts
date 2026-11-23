import 'server-only';

import {
  conversationsRepository,
  expertsRepository,
  proposalsRepository,
  reminderWaitsRepository,
  REQUEST_RELATIONSHIP_IDS_LIMIT,
  requestExpertRelationshipsRepository,
  usersRepository,
} from '@balo/db';
import { deliveryReviewWait } from '@balo/shared/engagements';
import { isLookupUuid } from '@balo/shared/lookup';
import { invitationReminderWait, proposalReviewWait } from '@balo/shared/project-requests';
import {
  REMINDER_SEQUENCE_IDS,
  parseReminderSequenceKey,
  reminderSequenceKeyPrefix,
  reminderSequenceSpanMs,
  type ReminderSequenceId,
} from '@balo/shared/notifications';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  FOLLOW_UPS_EARLIER_DAYS,
  buildLookupFollowUps,
  liveWaitKey,
  type LiveWait,
} from './build-lookup-follow-ups';
import type { LookupFollowUpType, LookupFollowUpsResult } from './follow-ups-view';

/**
 * BAL-666 — the authorization seam between the Follow-ups Server Action and the read-only
 * `reminderWaitsRepository`, modelled on `load-lookup-timeline.ts`: it resolves
 * `VIEW_PLATFORM_ADMIN` itself and returns a typed `forbidden` result with ZERO repository
 * calls when the check fails.
 *
 * ⚠ READ-ONLY. The repositories reached here expose reads only: this loader schedules, claims,
 * cancels and fails nothing, and `admin-lookup-never-writes.test.ts` pins that by name.
 *
 * Order: resolve the subject, read the rows, then ask the live source whether each wait is still
 * waiting (and load the person) together. Which wait is "current" is decided by the live answer,
 * never by the stored rows alone.
 */

export const LOOKUP_FOLLOW_UPS_ROW_LIMIT = 500;
const MS_PER_DAY = 86_400_000;

/** The entities of one sequence that an entity lens reads waits for. */
interface SequenceScope {
  readonly sequenceId: ReminderSequenceId;
  readonly entityIds: readonly string[];
}

type Subject =
  | { readonly lens: 'person'; readonly userId: string }
  | {
      readonly lens: 'entity';
      readonly scopes: readonly SequenceScope[];
      /** The title of the request an engagement came from, when it has a live one. */
      readonly originTitle: string | null;
    };

type LiveLoader = (entityIds: readonly string[]) => Promise<ReadonlyMap<string, LiveWait>>;

async function liveProposalReviewWaits(
  entityIds: readonly string[]
): Promise<ReadonlyMap<string, LiveWait>> {
  const candidates = await proposalsRepository.listReviewCandidates({
    projectRequestIds: entityIds,
  });
  const byRequest = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = byRequest.get(candidate.projectRequestId);
    if (group === undefined) {
      byRequest.set(candidate.projectRequestId, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  const map = new Map<string, LiveWait>();
  for (const [entityId, group] of byRequest) {
    const wait = proposalReviewWait(group);
    const [first] = group;
    if (wait !== null && first !== undefined) {
      map.set(entityId, {
        anchorIso: wait.anchor.toISOString(),
        awaitingCount: wait.awaitingCount,
        title: first.title,
      });
    }
  }
  return map;
}

async function liveDeliveryReviewWaits(
  entityIds: readonly string[]
): Promise<ReadonlyMap<string, LiveWait>> {
  const states = await reminderWaitsRepository.listDeliveryReviewStates(entityIds);
  const map = new Map<string, LiveWait>();
  for (const state of states) {
    const wait = deliveryReviewWait(state);
    if (wait !== null) {
      map.set(state.engagementId, {
        anchorIso: wait.anchor.toISOString(),
        awaitingCount: null,
        title: null,
      });
    }
  }
  return map;
}

async function liveInvitationWaits(
  entityIds: readonly string[]
): Promise<ReadonlyMap<string, LiveWait>> {
  const [candidates, expertWrote] = await Promise.all([
    requestExpertRelationshipsRepository.listInvitationReminderCandidates({
      relationshipIds: entityIds,
    }),
    conversationsRepository.relationshipsWithExpertMessage(entityIds),
  ]);
  const map = new Map<string, LiveWait>();
  for (const candidate of candidates) {
    const wait = invitationReminderWait(candidate, expertWrote.has(candidate.relationshipId));
    if (wait !== null) {
      map.set(candidate.relationshipId, {
        anchorIso: wait.anchor.toISOString(),
        awaitingCount: null,
        title: candidate.title,
      });
    }
  }
  return map;
}

/** One live-wait source per sequence: whether each entity is still waiting, and since when. */
const WAIT_LIVENESS: Readonly<Record<ReminderSequenceId, LiveLoader>> = {
  proposal_review: liveProposalReviewWaits,
  delivery_review: liveDeliveryReviewWaits,
  invitation: liveInvitationWaits,
};

/** Asks each sequence's own source about its own entities; a sequence with none makes no call. */
async function loadLiveWaits(
  idsBySequence: ReadonlyMap<ReminderSequenceId, readonly string[]>
): Promise<ReadonlyMap<string, LiveWait>> {
  const perSequence = await Promise.all(
    REMINDER_SEQUENCE_IDS.map(async (sequenceId) => {
      // Every liveness read takes uuids only: a key naming anything else never reaches a query.
      const ids = (idsBySequence.get(sequenceId) ?? []).filter(isLookupUuid);
      return {
        sequenceId,
        waits:
          ids.length === 0 ? new Map<string, LiveWait>() : await WAIT_LIVENESS[sequenceId](ids),
      };
    })
  );
  const merged = new Map<string, LiveWait>();
  for (const { sequenceId, waits } of perSequence) {
    for (const [entityId, live] of waits) {
      merged.set(liveWaitKey(sequenceId, entityId), live);
    }
  }
  return merged;
}

async function resolveSubject(input: {
  type: LookupFollowUpType;
  id: string;
}): Promise<Subject | 'not_found'> {
  if (input.type === 'user') return { lens: 'person', userId: input.id };
  if (input.type === 'project_request') {
    const relationshipIds = await reminderWaitsRepository.listRequestRelationshipIds(input.id);
    if (relationshipIds.length === REQUEST_RELATIONSHIP_IDS_LIMIT) {
      log.warn('Admin lookup follow-ups hit the relationship limit', {
        entityType: input.type,
        entityId: input.id,
        limit: REQUEST_RELATIONSHIP_IDS_LIMIT,
      });
    }
    return {
      lens: 'entity',
      scopes: [
        { sequenceId: 'proposal_review', entityIds: [input.id] },
        { sequenceId: 'invitation', entityIds: relationshipIds },
      ],
      originTitle: null,
    };
  }
  if (input.type === 'expert') {
    const profile = await expertsRepository.findUserIdByProfileId(input.id);
    return profile === undefined ? 'not_found' : { lens: 'person', userId: profile.user.id };
  }
  const engagement = await reminderWaitsRepository.findEngagementRequestId(input.id);
  if (engagement === undefined) return 'not_found';
  const scopes: SequenceScope[] = [{ sequenceId: 'delivery_review', entityIds: [input.id] }];
  if (engagement.projectRequestId !== null) {
    scopes.push({ sequenceId: 'proposal_review', entityIds: [engagement.projectRequestId] });
  }
  return { lens: 'entity', scopes, originTitle: engagement.requestTitle };
}

/** The entity ids each sequence's rows name, from the parsed dedupe keys. */
function entityIdsBySequence(
  rows: readonly { readonly dedupeKey: string }[]
): Map<ReminderSequenceId, string[]> {
  const grouped = new Map<ReminderSequenceId, Set<string>>();
  for (const row of rows) {
    const parts = parseReminderSequenceKey(row.dedupeKey);
    if (parts === null) continue;
    const ids = grouped.get(parts.sequenceId) ?? new Set<string>();
    ids.add(parts.entityId);
    grouped.set(parts.sequenceId, ids);
  }
  return new Map([...grouped].map(([sequenceId, ids]) => [sequenceId, [...ids]]));
}

export async function loadLookupFollowUps(
  user: SessionUser,
  input: { type: LookupFollowUpType; id: string },
  now: Date = new Date()
): Promise<LookupFollowUpsResult> {
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    log.warn('Admin lookup follow-ups load reached without VIEW_PLATFORM_ADMIN', {
      userId: user.id,
    });
    return { ok: false, reason: 'forbidden' };
  }

  const subject = await resolveSubject(input);
  if (subject === 'not_found') return { ok: false, reason: 'not_found' };

  const createdSince = new Date(
    now.getTime() - FOLLOW_UPS_EARLIER_DAYS * MS_PER_DAY - reminderSequenceSpanMs()
  );
  const rows =
    subject.lens === 'person'
      ? await reminderWaitsRepository.listRows({
          keyPrefixes: REMINDER_SEQUENCE_IDS.map(reminderSequenceKeyPrefix),
          recipientUserId: subject.userId,
          createdSince,
          limit: LOOKUP_FOLLOW_UPS_ROW_LIMIT,
        })
      : await reminderWaitsRepository.listRows({
          keyPrefixes: subject.scopes.flatMap((scope) =>
            scope.entityIds.map(
              (entityId) => `${reminderSequenceKeyPrefix(scope.sequenceId)}${entityId}:`
            )
          ),
          createdSince,
          limit: LOOKUP_FOLLOW_UPS_ROW_LIMIT,
        });

  if (rows.length >= LOOKUP_FOLLOW_UPS_ROW_LIMIT) {
    log.warn('Admin lookup follow-ups hit the row limit', {
      userId: user.id,
      entityType: input.type,
      entityId: input.id,
      limit: LOOKUP_FOLLOW_UPS_ROW_LIMIT,
    });
  }

  const idsBySequence =
    subject.lens === 'entity'
      ? new Map(subject.scopes.map((scope) => [scope.sequenceId, scope.entityIds]))
      : entityIdsBySequence(rows);

  const [live, person] = await Promise.all([
    loadLiveWaits(idsBySequence),
    subject.lens === 'person' ? usersRepository.findById(subject.userId) : Promise.resolve(null),
  ]);

  if (subject.lens === 'person' && person === undefined) {
    return { ok: false, reason: 'not_found' };
  }

  return {
    ok: true,
    view: buildLookupFollowUps({
      lens: subject.lens,
      rows,
      live,
      subject:
        person === null || person === undefined
          ? null
          : { firstName: person.firstName, timezone: person.timezone },
      origin:
        subject.lens === 'entity' && subject.originTitle !== null
          ? { requestTitle: subject.originTitle }
          : null,
      now,
    }),
  };
}
