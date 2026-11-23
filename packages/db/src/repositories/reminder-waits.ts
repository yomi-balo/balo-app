import { and, desc, eq, gte, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  engagements,
  projectEngagements,
  projectRequests,
  scheduledNotifications,
  users,
  type ScheduledNotificationPayload,
  type ScheduledNotificationStatus,
} from '../schema';

/**
 * One reminder row with the display facts its readers need, joined in so a reader makes one
 * query: the recipient's name and zone, and — when the row is about a project request — the
 * request's title and its company's name.
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
  /** `null` when the recipient is gone or soft-deleted. */
  recipient: {
    firstName: string | null;
    lastName: string | null;
    timezone: string | null;
  } | null;
  /** `null` when the row's entity is not a live project request. */
  entity: { title: string; companyName: string | null } | null;
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

const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * A stored payload id as a uuid, or NULL when it is not uuid-shaped. The primary-key side of a
 * join compares against this, so the key stays indexable and a malformed id in a stored payload
 * simply fails to join instead of raising an invalid-uuid error.
 */
function payloadUuid(text: SQL): SQL {
  return sql`CASE WHEN ${text} ~* ${UUID_SHAPE} THEN (${text})::uuid END`;
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
        entityId: projectRequests.id,
        entityTitle: projectRequests.title,
        entityCompanyName: companies.name,
      })
      .from(scheduledNotifications)
      .leftJoin(
        users,
        and(sql`${users.id} = ${payloadUuid(PAYLOAD_RECIPIENT)}`, isNull(users.deletedAt))
      )
      .leftJoin(
        projectRequests,
        and(
          sql`${projectRequests.id} = ${payloadUuid(PAYLOAD_ENTITY)}`,
          isNull(projectRequests.deletedAt)
        )
      )
      .leftJoin(companies, eq(companies.id, projectRequests.companyId))
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
      recipient:
        row.recipientId === null
          ? null
          : {
              firstName: row.recipientFirstName,
              lastName: row.recipientLastName,
              timezone: row.recipientTimezone,
            },
      entity:
        row.entityId === null || row.entityTitle === null
          ? null
          : { title: row.entityTitle, companyName: row.entityCompanyName },
    }));
  },

  /**
   * The project request an engagement came from. `undefined` when the engagement does not exist
   * or is soft-deleted; `{ projectRequestId: null }` for a case, a project with no
   * originating request, or a project engagement that is soft-deleted.
   */
  async findEngagementRequestId(
    engagementId: string
  ): Promise<{ projectRequestId: string | null } | undefined> {
    const [row] = await db
      .select({ projectRequestId: projectEngagements.projectRequestId })
      .from(engagements)
      .leftJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
      .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
      .limit(1);
    return row === undefined ? undefined : { projectRequestId: row.projectRequestId };
  },
};
