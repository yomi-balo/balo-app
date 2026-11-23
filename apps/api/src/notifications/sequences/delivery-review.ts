import {
  companiesRepository,
  projectEngagementsRepository,
  type ProjectEngagementWithMilestones,
} from '@balo/db';
import { trackServer, ENGAGEMENT_SERVER_EVENTS } from '@balo/analytics/server';
import { deliveryReviewWait } from '@balo/shared/engagements';
import { createLogger } from '@balo/shared/logging';
import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  REMINDER_SEQUENCE_AUDIENCE,
  REMINDER_SEQUENCE_CHANNELS,
  REMINDER_SEQUENCE_STEPS,
} from '@balo/shared/notifications';
import { formatShortUtc } from '@balo/shared/timezone';
import { deliveryEmailFields } from '../../lib/delivery-email-fields.js';
import { mapWithConcurrency } from '../../lib/map-with-concurrency.js';
import { REMINDER_SEQUENCE_SWEEP_LEAD_MS } from './cadence.js';
import type { ReminderCadence, ReminderSequence, SequenceEntity } from './types.js';

const log = createLogger('reminder-sequence-delivery-review');

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const CADENCE: ReminderCadence = 'hourly';
/** The lead the sweep arms a step ahead by, which is also the window's slack. */
const SWEEP_LEAD_MS = REMINDER_SEQUENCE_SWEEP_LEAD_MS[CADENCE];
/** Rows hydrated at once while `find` loads the engagements inside the arming window. */
const HYDRATE_CONCURRENCY = 4;

const STEP_OFFSETS_MS = REMINDER_SEQUENCE_STEPS.delivery_review.map(
  (step) => step.offsetMinutes * MINUTE_MS
);
const EARLIEST_STEP_OFFSET_MS = Math.min(...STEP_OFFSETS_MS);
const LATEST_STEP_OFFSET_MS = Math.max(...STEP_OFFSETS_MS);

/**
 * Whole days left until auto-accept, rounded up and never below 1, so the email never promises
 * "0 days". Recomputed from the fire-time clock.
 */
export function deliveryReviewDaysLeft(autoAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((autoAt.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Pure. The waiting entity for a hydrated project, or null unless it is `pending_acceptance`
 * with a completion request. `status` is the folded delivery status. The anchor is the request
 * instant, so a withdrawn-then-re-requested delivery is a new anchor and arms a fresh key.
 */
export function deliveryReviewEntity(
  engagement: ProjectEngagementWithMilestones,
  ownerUserId: string | undefined,
  now: Date
): SequenceEntity | null {
  const wait = deliveryReviewWait(engagement);
  if (wait === null) {
    return null;
  }
  const { anchor, autoAcceptAt: autoAt } = wait;
  return {
    entityId: engagement.id,
    anchor,
    companyId: engagement.company.id,
    candidateUserIds: ownerUserId === undefined ? [] : [ownerUserId],
    fresh: {
      ...deliveryEmailFields(engagement),
      requestedDate: formatShortUtc(anchor),
      autoDate: formatShortUtc(autoAt),
      daysLeft: deliveryReviewDaysLeft(autoAt, now),
    },
  };
}

/** One engagement's live entity, or null when it is gone or no longer awaits the client. */
async function loadEntity(engagementId: string, now: Date): Promise<SequenceEntity | null> {
  const engagement = await projectEngagementsRepository.findWithMilestones(engagementId);
  if (engagement === undefined || deliveryReviewWait(engagement) === null) {
    return null;
  }
  const owner = await companiesRepository.findOwnerUserIdByCompanyId(engagement.company.id);
  return deliveryReviewEntity(engagement, owner, now);
}

function freshText(entity: SequenceEntity, key: string): string {
  const value = entity.fresh[key];
  return typeof value === 'string' ? value : '';
}

function freshNumber(entity: SequenceEntity, key: string, fallback: number): number {
  const value = entity.fresh[key];
  return typeof value === 'number' ? value : fallback;
}

function nonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The delivery-review follow-up: the client company owner is reminded, once, shortly before a
 * `pending_acceptance` project auto-accepts. The recipient is the live owner, the person
 * `engagement.review_reminder` emails; a company with no live owner has no candidate and is
 * never reminded.
 */
export const deliveryReviewSequence: ReminderSequence<'engagement.review_reminder'> = {
  id: 'delivery_review',
  event: 'engagement.review_reminder',
  channels: REMINDER_SEQUENCE_CHANNELS.delivery_review,
  audience: REMINDER_SEQUENCE_AUDIENCE.delivery_review,
  cadence: CADENCE,
  exemptFromDailyLimit: true,

  async find(now) {
    // A step arms from one sweep lead before its send time until REMINDER_ARMABLE_AFTER_DUE_MS
    // after it, so only a request inside this anchor window can plan a step. The slack keeps the
    // window wider than `planDueSteps`, which stays the exact gate.
    const newest = new Date(now.getTime() - EARLIEST_STEP_OFFSET_MS + SWEEP_LEAD_MS);
    const oldest = now.getTime() - LATEST_STEP_OFFSET_MS - REMINDER_ARMABLE_AFTER_DUE_MS;
    const oldestExclusive = oldest - SWEEP_LEAD_MS;
    const rows = await projectEngagementsRepository.listPendingAutoAccept(newest);
    const inWindow = rows.filter(
      (row) =>
        row.completionRequestedAt !== null && row.completionRequestedAt.getTime() > oldestExclusive
    );
    const loaded = await mapWithConcurrency(inWindow, HYDRATE_CONCURRENCY, async (row) => {
      try {
        return await loadEntity(row.id, now);
      } catch (error) {
        log.error(
          {
            sequence: 'delivery_review',
            entityId: row.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Delivery review entity load failed'
        );
        return null;
      }
    });
    return loaded.filter((entity): entity is SequenceEntity => entity !== null);
  },

  evaluate(entityId) {
    return loadEntity(entityId, new Date());
  },

  resolveRecipients(entity) {
    return Promise.resolve(entity.candidateUserIds);
  },

  payloadMatchesEntity(payload, entityId) {
    return (
      payload.engagementId === entityId &&
      typeof payload.recipientId === 'string' &&
      payload.recipientId === payload.recipientUserId
    );
  },

  buildPayload(entity, stepKey, recipientUserId, correlationId) {
    return {
      correlationId,
      sequenceId: 'delivery_review',
      step: stepKey,
      entityId: entity.entityId,
      anchorIso: entity.anchor.toISOString(),
      recipientUserId,
      recipientId: recipientUserId,
      engagementId: entity.entityId,
      clientCompanyName: freshText(entity, 'clientCompanyName'),
      expertPartyLabel: freshText(entity, 'expertPartyLabel'),
      projectTitle: freshText(entity, 'projectTitle'),
      milestonesTotal: freshNumber(entity, 'milestonesTotal', 0),
      requestedDate: freshText(entity, 'requestedDate'),
      autoDate: freshText(entity, 'autoDate'),
      daysLeft: freshNumber(entity, 'daysLeft', 1),
    };
  },

  trackPublished(payload) {
    const { engagementId, recipientUserId } = payload;
    if (!nonBlankText(engagementId) || !nonBlankText(recipientUserId)) {
      return;
    }
    trackServer(ENGAGEMENT_SERVER_EVENTS.REVIEW_REMINDER_SENT, {
      engagement_id: engagementId,
      distinct_id: recipientUserId,
    });
  },
};
