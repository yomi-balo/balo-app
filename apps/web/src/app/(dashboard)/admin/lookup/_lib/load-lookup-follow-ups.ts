import 'server-only';

import {
  expertsRepository,
  proposalsRepository,
  reminderWaitsRepository,
  usersRepository,
} from '@balo/db';
import { proposalReviewWait } from '@balo/shared/project-requests';
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

type Subject =
  | { readonly lens: 'person'; readonly userId: string }
  | { readonly lens: 'entity'; readonly requestId: string; readonly fromEngagement: boolean };

type LiveLoader = (entityIds: readonly string[]) => Promise<ReadonlyMap<string, LiveWait>>;

async function liveProposalReviewWaits(
  entityIds: readonly string[]
): Promise<ReadonlyMap<string, LiveWait>> {
  if (entityIds.length === 0) return new Map();
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

/** One live-wait source per sequence: whether each entity is still waiting, and since when. */
const WAIT_LIVENESS: Readonly<Record<ReminderSequenceId, LiveLoader>> = {
  proposal_review: liveProposalReviewWaits,
};

async function loadLiveWaits(entityIds: readonly string[]): Promise<ReadonlyMap<string, LiveWait>> {
  const perSequence = await Promise.all(
    REMINDER_SEQUENCE_IDS.map(async (sequenceId) => ({
      sequenceId,
      waits: await WAIT_LIVENESS[sequenceId](entityIds),
    }))
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
}): Promise<Subject | 'not_found' | 'no_request'> {
  if (input.type === 'user') return { lens: 'person', userId: input.id };
  if (input.type === 'project_request') {
    return { lens: 'entity', requestId: input.id, fromEngagement: false };
  }
  if (input.type === 'expert') {
    const profile = await expertsRepository.findUserIdByProfileId(input.id);
    return profile === undefined ? 'not_found' : { lens: 'person', userId: profile.user.id };
  }
  const engagement = await reminderWaitsRepository.findEngagementRequestId(input.id);
  if (engagement === undefined) return 'not_found';
  if (engagement.projectRequestId === null) return 'no_request';
  return { lens: 'entity', requestId: engagement.projectRequestId, fromEngagement: true };
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
  if (subject === 'no_request') {
    return {
      ok: true,
      view: buildLookupFollowUps({
        lens: 'entity',
        rows: [],
        live: new Map(),
        subject: null,
        origin: null,
        engagementWithoutRequest: true,
        now,
      }),
    };
  }

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
          keyPrefixes: REMINDER_SEQUENCE_IDS.map(
            (id) => `${reminderSequenceKeyPrefix(id)}${subject.requestId}:`
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

  const entityIds =
    subject.lens === 'entity'
      ? [subject.requestId]
      : [
          ...new Set(
            rows.flatMap((row) => {
              const parts = parseReminderSequenceKey(row.dedupeKey);
              return parts === null ? [] : [parts.entityId];
            })
          ),
        ];

  const [live, person] = await Promise.all([
    loadLiveWaits(entityIds),
    subject.lens === 'person' ? usersRepository.findById(subject.userId) : Promise.resolve(null),
  ]);

  if (subject.lens === 'person' && person === undefined) {
    return { ok: false, reason: 'not_found' };
  }

  const requestTitle =
    subject.lens === 'entity' && subject.fromEngagement
      ? (live.get(liveWaitKey('proposal_review', subject.requestId))?.title ??
        rows.find((row) => row.entity !== null)?.entity?.title ??
        null)
      : null;

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
      origin: requestTitle === null ? null : { requestTitle },
      now,
    }),
  };
}
