import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isLookupUuid } from '@balo/shared/lookup';
import { reminderSequenceKeyPrefix } from '@balo/shared/notifications';
import { db } from '../client';
import {
  agencies,
  companies,
  engagements,
  expertProfiles,
  notificationLog,
  projectEngagements,
  projectRequests,
  requestExpertRelationships,
  scheduledNotifications,
  users,
  type ScheduledNotificationPayload,
  type ScheduledNotificationStatus,
} from '../schema';

/** The most relationship ids {@link reminderWaitsRepository.listRequestRelationshipIds} returns. */
export const REQUEST_RELATIONSHIP_IDS_LIMIT = 200;

/** The most delivery outcomes {@link reminderWaitsRepository.listDeliveryOutcomes} returns. */
export const DELIVERY_OUTCOMES_LIMIT = 2000;

/**
 * One reminder row with the display facts its readers need, joined in so a reader makes one
 * query: the recipient's name and zone, and the facts of the entity the row's sequence is
 * about (a request, an engagement or an expert relationship).
 */
export interface ReminderWaitRow {
  id: string;
  dedupeKey: string;
  event: string;
  status: ScheduledNotificationStatus;
  scheduledFor: Date;
  publishedAt: Date | null;
  skipReason: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  payload: ScheduledNotificationPayload;
  /**
   * The stored payload's `correlationId`, the key its delivery is logged under; `null` when the
   * payload carries none usable.
   */
  correlationId: string | null;
  /** `null` when the recipient is gone or soft-deleted. */
  recipient: {
    firstName: string | null;
    lastName: string | null;
    timezone: string | null;
  } | null;
  /**
   * `null` when the row's subject is gone: the entity its key names is missing or soft-deleted.
   * The fields are individually `null` when that fact does not exist, such as the title of an
   * engagement whose originating request was deleted, or the agency of an independent expert.
   */
  entity: {
    title: string | null;
    companyName: string | null;
    agencyName: string | null;
  } | null;
}

/** One live engagement's delivery-review facts, with the project's folded delivery status. */
export interface DeliveryReviewState {
  engagementId: string;
  status: string;
  completionRequestedAt: Date | null;
}

/** One channel's recorded delivery result for a published reminder. */
export interface DeliveryOutcome {
  correlationId: string;
  channel: string;
  status: string;
  error: string | null;
  createdAt: Date;
}

export interface ListReminderWaitRowsInput {
  /** Dedupe-key prefixes to match, e.g. `seq:proposal_review:{entityId}:`. Empty → no rows. */
  keyPrefixes: readonly string[];
  /** Only rows addressed to this user (`payload.recipientUserId`). */
  recipientUserId?: string;
  createdSince: Date;
  limit: number;
}

/** The `payload.recipientUserId` / `payload.entityId` text a row's joins and filters read. */
const PAYLOAD_RECIPIENT = sql`${scheduledNotifications.payload}->>'recipientUserId'`;
const PAYLOAD_ENTITY = sql`${scheduledNotifications.payload}->>'entityId'`;

/** The tables a row's entity is read from, one set per sequence, each joined by its own prefix. */
const proposalRequest = alias(projectRequests, 'proposal_request');
const reviewEngagement = alias(engagements, 'review_engagement');
const reviewProject = alias(projectEngagements, 'review_project');
const reviewRequest = alias(projectRequests, 'review_request');
const invitedRelationship = alias(requestExpertRelationships, 'invited_relationship');
const invitationRequest = alias(projectRequests, 'invitation_request');
const invitedExpert = alias(expertProfiles, 'invited_expert');

/** True when the row's dedupe key belongs to `sequenceId`, so a join never reads another's rows. */
function keyIsSequence(sequenceId: 'proposal_review' | 'delivery_review' | 'invitation'): SQL {
  return sql`starts_with(${scheduledNotifications.dedupeKey}, ${reminderSequenceKeyPrefix(sequenceId)})`;
}

const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * A stored payload id as a uuid, or NULL when it is not uuid-shaped. The primary-key side of a
 * join compares against this, so the key stays indexable and a malformed id in a stored payload
 * simply fails to join instead of raising an invalid-uuid error.
 */
function payloadUuid(text: SQL): SQL {
  return sql`CASE WHEN ${text} ~* ${UUID_SHAPE} THEN (${text})::uuid END`;
}

/** The payload's `correlationId` when it is a non-empty string. */
function storedCorrelationId(payload: ScheduledNotificationPayload): string | null {
  const value = payload['correlationId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * READ-ONLY access to `scheduled_notifications` for web surfaces (BAL-666). It has no write
 * member on purpose: scheduling, claiming and failing a row stay API-only
 * (`scheduledNotificationsRepository`, ADR-1047 Decision 11), and the web is barred from that
 * repository by an invariant. Every read excludes soft-deleted rows.
 */
export const reminderWaitsRepository = {
  /**
   * Rows whose dedupe key starts with any of `keyPrefixes`, newest first.
   *
   * Prefixes match with `starts_with`, never `LIKE`: a key holds `_` (a LIKE wildcard), so a
   * prefix built from one entity would otherwise match its siblings.
   */
  async listRows(input: ListReminderWaitRowsInput): Promise<ReminderWaitRow[]> {
    if (input.keyPrefixes.length === 0) {
      return [];
    }
    const prefixMatch = or(
      ...input.keyPrefixes.map(
        (prefix) => sql`starts_with(${scheduledNotifications.dedupeKey}, ${prefix})`
      )
    );
    const recipientMatch =
      input.recipientUserId === undefined
        ? undefined
        : sql`${PAYLOAD_RECIPIENT} = ${input.recipientUserId}`;

    const rows = await db
      .select({
        id: scheduledNotifications.id,
        dedupeKey: scheduledNotifications.dedupeKey,
        event: scheduledNotifications.event,
        status: scheduledNotifications.status,
        scheduledFor: scheduledNotifications.scheduledFor,
        publishedAt: scheduledNotifications.publishedAt,
        skipReason: scheduledNotifications.skipReason,
        lastError: scheduledNotifications.lastError,
        attempts: scheduledNotifications.attempts,
        createdAt: scheduledNotifications.createdAt,
        updatedAt: scheduledNotifications.updatedAt,
        payload: scheduledNotifications.payload,
        recipientId: users.id,
        recipientFirstName: users.firstName,
        recipientLastName: users.lastName,
        recipientTimezone: users.timezone,
        subjectId: sql<
          string | null
        >`COALESCE(${proposalRequest.id}, ${reviewEngagement.id}, ${invitedRelationship.id})`,
        entityTitle: sql<
          string | null
        >`COALESCE(${proposalRequest.title}, ${reviewRequest.title}, ${invitationRequest.title})`,
        entityCompanyName: companies.name,
        entityAgencyName: agencies.name,
      })
      .from(scheduledNotifications)
      .leftJoin(
        users,
        and(sql`${users.id} = ${payloadUuid(PAYLOAD_RECIPIENT)}`, isNull(users.deletedAt))
      )
      .leftJoin(
        proposalRequest,
        and(
          keyIsSequence('proposal_review'),
          sql`${proposalRequest.id} = ${payloadUuid(PAYLOAD_ENTITY)}`,
          isNull(proposalRequest.deletedAt)
        )
      )
      .leftJoin(
        reviewEngagement,
        and(
          keyIsSequence('delivery_review'),
          sql`${reviewEngagement.id} = ${payloadUuid(PAYLOAD_ENTITY)}`,
          isNull(reviewEngagement.deletedAt)
        )
      )
      .leftJoin(
        reviewProject,
        and(eq(reviewProject.engagementId, reviewEngagement.id), isNull(reviewProject.deletedAt))
      )
      .leftJoin(
        reviewRequest,
        and(eq(reviewRequest.id, reviewProject.projectRequestId), isNull(reviewRequest.deletedAt))
      )
      .leftJoin(
        invitedRelationship,
        and(
          keyIsSequence('invitation'),
          sql`${invitedRelationship.id} = ${payloadUuid(PAYLOAD_ENTITY)}`,
          isNull(invitedRelationship.deletedAt)
        )
      )
      .leftJoin(
        invitationRequest,
        and(
          eq(invitationRequest.id, invitedRelationship.projectRequestId),
          isNull(invitationRequest.deletedAt)
        )
      )
      .leftJoin(invitedExpert, eq(invitedExpert.id, invitedRelationship.expertProfileId))
      .leftJoin(agencies, eq(agencies.id, invitedExpert.agencyId))
      .leftJoin(
        companies,
        eq(
          companies.id,
          sql`COALESCE(${proposalRequest.companyId}, ${reviewEngagement.companyId}, ${invitationRequest.companyId})`
        )
      )
      .where(
        and(
          isNull(scheduledNotifications.deletedAt),
          gte(scheduledNotifications.createdAt, input.createdSince),
          prefixMatch,
          recipientMatch
        )
      )
      .orderBy(desc(scheduledNotifications.createdAt), desc(scheduledNotifications.id))
      .limit(input.limit);

    return rows.map((row) => ({
      id: row.id,
      dedupeKey: row.dedupeKey,
      event: row.event,
      status: row.status,
      scheduledFor: row.scheduledFor,
      publishedAt: row.publishedAt,
      skipReason: row.skipReason,
      lastError: row.lastError,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      payload: row.payload,
      correlationId: storedCorrelationId(row.payload),
      recipient:
        row.recipientId === null
          ? null
          : {
              firstName: row.recipientFirstName,
              lastName: row.recipientLastName,
              timezone: row.recipientTimezone,
            },
      entity:
        row.subjectId === null
          ? null
          : {
              title: row.entityTitle,
              companyName: row.entityCompanyName,
              agencyName: row.entityAgencyName,
            },
    }));
  },

  /**
   * The project request an engagement came from, with its title when that request is live.
   * `undefined` when the engagement does not exist or is soft-deleted; `{ projectRequestId: null }`
   * for a case, a project with no originating request, or a project engagement that is
   * soft-deleted. `requestTitle` is `null` when the request is soft-deleted or absent.
   */
  async findEngagementRequestId(
    engagementId: string
  ): Promise<{ projectRequestId: string | null; requestTitle: string | null } | undefined> {
    const [row] = await db
      .select({
        projectRequestId: projectEngagements.projectRequestId,
        requestTitle: projectRequests.title,
      })
      .from(engagements)
      .leftJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
      .leftJoin(
        projectRequests,
        and(
          eq(projectRequests.id, projectEngagements.projectRequestId),
          isNull(projectRequests.deletedAt)
        )
      )
      .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
      .limit(1);
    return row === undefined
      ? undefined
      : { projectRequestId: row.projectRequestId, requestTitle: row.requestTitle };
  },

  /**
   * Every live relationship on a request, in any status, oldest invite first then by id. These
   * are the entities the request's `invitation` waits are keyed on. Capped at
   * {@link REQUEST_RELATIONSHIP_IDS_LIMIT}; a caller seeing that many ids may have a truncated set.
   */
  async listRequestRelationshipIds(projectRequestId: string): Promise<string[]> {
    const rows = await db
      .select({ id: requestExpertRelationships.id })
      .from(requestExpertRelationships)
      .where(
        and(
          eq(requestExpertRelationships.projectRequestId, projectRequestId),
          isNull(requestExpertRelationships.deletedAt)
        )
      )
      .orderBy(asc(requestExpertRelationships.invitedAt), asc(requestExpertRelationships.id))
      .limit(REQUEST_RELATIONSHIP_IDS_LIMIT);
    return rows.map((row) => row.id);
  },

  /**
   * The delivery-review facts of each live project engagement among `engagementIds`: its folded
   * delivery status and completion request. A case, an unknown id or a soft-deleted engagement or
   * project has no row. Empty (or no uuid-shaped) ids make no query.
   */
  async listDeliveryReviewStates(engagementIds: readonly string[]): Promise<DeliveryReviewState[]> {
    const ids = engagementIds.filter(isLookupUuid);
    if (ids.length === 0) {
      return [];
    }
    const rows = await db
      .select({
        engagementId: engagements.id,
        status: projectEngagements.deliveryStatus,
        completionRequestedAt: projectEngagements.completionRequestedAt,
      })
      .from(engagements)
      .innerJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
      .where(and(inArray(engagements.id, ids), isNull(engagements.deletedAt)));
    return rows;
  },

  /**
   * What `notification_log` recorded for each of `correlationIds`, one row per channel, newest
   * first, so a hit cap drops the oldest outcomes. Soft-deleted log rows are excluded. A status of
   * `sent` means the provider accepted the message, not that it arrived. A correlation id with no row has not been
   * delivered or logged yet. Empty ids make no query; capped at {@link DELIVERY_OUTCOMES_LIMIT}.
   */
  async listDeliveryOutcomes(input: {
    correlationIds: readonly string[];
  }): Promise<DeliveryOutcome[]> {
    const ids = [...new Set(input.correlationIds.filter((id) => id !== ''))];
    if (ids.length === 0) {
      return [];
    }
    return db
      .select({
        correlationId: notificationLog.correlationId,
        channel: notificationLog.channel,
        status: notificationLog.status,
        error: notificationLog.error,
        createdAt: notificationLog.createdAt,
      })
      .from(notificationLog)
      .where(and(inArray(notificationLog.correlationId, ids), isNull(notificationLog.deletedAt)))
      .orderBy(desc(notificationLog.createdAt), desc(notificationLog.id))
      .limit(DELIVERY_OUTCOMES_LIMIT);
  },
};
