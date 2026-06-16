import { and, asc, count, desc, eq, inArray, isNull, lt, max, ne, or, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  conversationMessages,
  conversationFiles,
  conversationReadStates,
  requestExpertRelationships,
  users,
  type ConversationMessage,
  type ConversationFile,
  type ConversationReadState,
} from '../schema';

/** Later of two nullable instants — null only when both are null. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** One thread's batch summary row — see `listThreadSummaries`. */
export interface ConversationThreadSummary {
  relationshipId: string;
  /** Newest LIVE message in the thread, any sender. Null for an empty thread. */
  latestMessage: {
    id: string;
    body: string;
    createdAt: Date;
    senderUserId: string;
    /** The sender's first name (joined from `users`); null if unset. */
    senderFirstName: string | null;
  } | null;
  /**
   * Newest LIVE activity NOT authored by the viewer:
   * max(newest live message not from viewer, newest live file not from viewer).
   * Null when the other party has never written/shared anything.
   */
  latestInboundActivityAt: Date | null;
  /** LIVE file count for the thread. */
  fileCount: number;
  /** The VIEWER's live read watermark. Null when they have never marked read. */
  lastReadAt: Date | null;
}

export const conversationsRepository = {
  /**
   * Post a message to a relationship's thread.
   *
   * CONTRACT — bare INSERT, no error isolation. A single un-wrapped
   * `db.insert(...)` that can throw a raw FK violation (23503) for an unknown
   * `relationshipId` (ON DELETE cascade) or `senderUserId` (ON DELETE restrict);
   * this table has no unique constraint. If called INSIDE an open
   * `db.transaction(...)`, that error ABORTS the transaction (25P02) — every
   * later statement fails until rollback. The A4 caller MUST isolate this insert
   * in its own SAVEPOINT (nested `tx.transaction(...)`) so a bad id can't poison
   * a wider transaction. No production callers yet.
   */
  async postMessage(input: {
    relationshipId: string;
    senderUserId: string;
    body: string;
  }): Promise<ConversationMessage> {
    const [row] = await db
      .insert(conversationMessages)
      .values({
        relationshipId: input.relationshipId,
        senderUserId: input.senderUserId,
        body: input.body,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create conversation message');
    }
    return row;
  },

  /** Live messages for a relationship, chronological (oldest first). */
  async listMessages(relationshipId: string): Promise<ConversationMessage[]> {
    return db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.relationshipId, relationshipId),
          isNull(conversationMessages.deletedAt)
        )
      )
      .orderBy(asc(conversationMessages.createdAt));
  },

  /**
   * Keyset page of live messages with sender names, NEWEST-first internally;
   * returned chronological (oldest first) so callers can render top-down.
   *
   * Keyset is STRICT `(created_at, id) < (before.createdAt, before.id)` —
   * same-timestamp neighbours are disambiguated by `id`, so repeated "load
   * earlier" calls never duplicate or skip a row. Fetches `limit + 1` rows to
   * derive `hasEarlier` without a second COUNT round trip, then slices to
   * `limit` and reverses. Rides the partial index
   * `conversation_message_thread_idx (relationship_id, created_at) WHERE
   * deleted_at IS NULL`.
   */
  async listMessagesPage(input: {
    relationshipId: string;
    /** Exclusive cursor — the OLDEST message of the previously loaded page. */
    before?: { createdAt: Date; id: string };
    limit: number;
  }): Promise<{
    messages: Array<
      ConversationMessage & { senderFirstName: string | null; senderLastName: string | null }
    >;
    hasEarlier: boolean;
  }> {
    const rows = await db
      .select({
        message: conversationMessages,
        senderFirstName: users.firstName,
        senderLastName: users.lastName,
      })
      .from(conversationMessages)
      .innerJoin(users, eq(users.id, conversationMessages.senderUserId))
      .where(
        and(
          eq(conversationMessages.relationshipId, input.relationshipId),
          isNull(conversationMessages.deletedAt),
          input.before === undefined
            ? undefined
            : or(
                lt(conversationMessages.createdAt, input.before.createdAt),
                and(
                  eq(conversationMessages.createdAt, input.before.createdAt),
                  lt(conversationMessages.id, input.before.id)
                )
              )
        )
      )
      .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
      .limit(input.limit + 1);

    const hasEarlier = rows.length > input.limit;
    const page = hasEarlier ? rows.slice(0, input.limit) : rows;
    page.reverse(); // newest-first → chronological ascending

    return {
      messages: page.map((row) => ({
        ...row.message,
        senderFirstName: row.senderFirstName,
        senderLastName: row.senderLastName,
      })),
      hasEarlier,
    };
  },

  /**
   * Batch per-thread summary for the tab strip / default-tab logic — ONE round
   * trip for any number of threads. Every leg filters `deleted_at IS NULL`:
   *
   * - `latestMessage`  — newest live message, ANY sender (tab preview);
   * - `latestInboundActivityAt` — max(newest live message NOT from the viewer,
   *   newest live file NOT from the viewer): the viewer's own activity never
   *   makes a thread unread, and a file can arrive without a message (nothing
   *   auto-posts), so files count toward inbound;
   * - `fileCount`  — live files, any uploader (Files pill badge);
   * - `lastReadAt` — the VIEWER's live watermark from `conversation_read_states`.
   *
   * Returns exactly one element per input id, in input order, with
   * zeros/nulls for empty threads. Empty input → `[]` (no query).
   */
  async listThreadSummaries(input: {
    relationshipIds: string[];
    viewerUserId: string;
  }): Promise<ConversationThreadSummary[]> {
    if (input.relationshipIds.length === 0) {
      return [];
    }

    // Newest live message per thread (any sender) via DISTINCT ON.
    const latestMessageSq = db
      .selectDistinctOn([conversationMessages.relationshipId], {
        relationshipId: conversationMessages.relationshipId,
        id: conversationMessages.id,
        body: conversationMessages.body,
        createdAt: conversationMessages.createdAt,
        senderUserId: conversationMessages.senderUserId,
      })
      .from(conversationMessages)
      .where(
        and(
          inArray(conversationMessages.relationshipId, input.relationshipIds),
          isNull(conversationMessages.deletedAt)
        )
      )
      .orderBy(
        conversationMessages.relationshipId,
        desc(conversationMessages.createdAt),
        desc(conversationMessages.id)
      )
      .as('latest_message');

    // Newest live message per thread NOT sent by the viewer.
    const inboundMessageSq = db
      .select({
        relationshipId: conversationMessages.relationshipId,
        latestAt: max(conversationMessages.createdAt).as('latest_inbound_message_at'),
      })
      .from(conversationMessages)
      .where(
        and(
          inArray(conversationMessages.relationshipId, input.relationshipIds),
          isNull(conversationMessages.deletedAt),
          ne(conversationMessages.senderUserId, input.viewerUserId)
        )
      )
      .groupBy(conversationMessages.relationshipId)
      .as('inbound_message');

    // Newest live file per thread NOT uploaded by the viewer.
    const inboundFileSq = db
      .select({
        relationshipId: conversationFiles.relationshipId,
        latestAt: max(conversationFiles.createdAt).as('latest_inbound_file_at'),
      })
      .from(conversationFiles)
      .where(
        and(
          inArray(conversationFiles.relationshipId, input.relationshipIds),
          isNull(conversationFiles.deletedAt),
          ne(conversationFiles.uploadedByUserId, input.viewerUserId)
        )
      )
      .groupBy(conversationFiles.relationshipId)
      .as('inbound_file');

    // Live file count per thread, ANY uploader (different filter from the
    // inbound leg above, so it is its own grouped subquery).
    const fileCountSq = db
      .select({
        relationshipId: conversationFiles.relationshipId,
        fileCount: count().as('file_count'),
      })
      .from(conversationFiles)
      .where(
        and(
          inArray(conversationFiles.relationshipId, input.relationshipIds),
          isNull(conversationFiles.deletedAt)
        )
      )
      .groupBy(conversationFiles.relationshipId)
      .as('file_count_leg');

    // The viewer's live read watermark — at most one row per thread thanks to
    // the partial unique index `conversation_read_state_unique_idx`.
    const readStateSq = db
      .select({
        relationshipId: conversationReadStates.relationshipId,
        lastReadAt: conversationReadStates.lastReadAt,
      })
      .from(conversationReadStates)
      .where(
        and(
          inArray(conversationReadStates.relationshipId, input.relationshipIds),
          eq(conversationReadStates.userId, input.viewerUserId),
          isNull(conversationReadStates.deletedAt)
        )
      )
      .as('read_state');

    const rows = await db
      .select({
        relationshipId: requestExpertRelationships.id,
        latestMessageId: latestMessageSq.id,
        latestMessageBody: latestMessageSq.body,
        latestMessageCreatedAt: latestMessageSq.createdAt,
        latestMessageSenderUserId: latestMessageSq.senderUserId,
        latestMessageSenderFirstName: users.firstName,
        latestInboundMessageAt: inboundMessageSq.latestAt,
        latestInboundFileAt: inboundFileSq.latestAt,
        fileCount: fileCountSq.fileCount,
        lastReadAt: readStateSq.lastReadAt,
      })
      .from(requestExpertRelationships)
      .leftJoin(latestMessageSq, eq(latestMessageSq.relationshipId, requestExpertRelationships.id))
      .leftJoin(users, eq(users.id, latestMessageSq.senderUserId))
      .leftJoin(
        inboundMessageSq,
        eq(inboundMessageSq.relationshipId, requestExpertRelationships.id)
      )
      .leftJoin(inboundFileSq, eq(inboundFileSq.relationshipId, requestExpertRelationships.id))
      .leftJoin(fileCountSq, eq(fileCountSq.relationshipId, requestExpertRelationships.id))
      .leftJoin(readStateSq, eq(readStateSq.relationshipId, requestExpertRelationships.id))
      .where(inArray(requestExpertRelationships.id, input.relationshipIds));

    // One element per INPUT id, in input order — unknown ids (defensive; the
    // callers pass ids from the loaded request graph) get the empty shape.
    const byId = new Map(rows.map((row) => [row.relationshipId, row]));
    return input.relationshipIds.map((relationshipId) => {
      const row = byId.get(relationshipId);
      const latestMessage =
        row !== undefined &&
        row.latestMessageId !== null &&
        row.latestMessageBody !== null &&
        row.latestMessageCreatedAt !== null &&
        row.latestMessageSenderUserId !== null
          ? {
              id: row.latestMessageId,
              body: row.latestMessageBody,
              createdAt: row.latestMessageCreatedAt,
              senderUserId: row.latestMessageSenderUserId,
              senderFirstName: row.latestMessageSenderFirstName,
            }
          : null;
      return {
        relationshipId,
        latestMessage,
        latestInboundActivityAt: laterOf(
          row?.latestInboundMessageAt ?? null,
          row?.latestInboundFileAt ?? null
        ),
        fileCount: row?.fileCount ?? 0,
        lastReadAt: row?.lastReadAt ?? null,
      };
    });
  },

  /**
   * Attach a file to a relationship's conversation. Unique r2_key enforced.
   *
   * CONTRACT — bare INSERT, no error isolation. A single un-wrapped
   * `db.insert(...)` that can throw a raw constraint violation: unique (23505)
   * on a duplicate `r2Key` (`conversation_file_key_idx`), or FK (23503) on an
   * unknown `relationshipId` (ON DELETE cascade) / `uploadedByUserId` (ON DELETE
   * restrict). If called INSIDE an open `db.transaction(...)`, that error ABORTS
   * the transaction (25P02) — every later statement fails until rollback. The A4
   * caller MUST isolate this insert — its own SAVEPOINT (nested
   * `tx.transaction(...)`), or pre-empt the duplicate with
   * `.onConflictDoNothing({ target: conversationFiles.r2Key })` — so a duplicate
   * upload can't poison a wider transaction. No production callers yet.
   */
  async addFile(input: {
    relationshipId: string;
    uploadedByUserId: string;
    r2Key: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<ConversationFile> {
    const [row] = await db
      .insert(conversationFiles)
      .values({
        relationshipId: input.relationshipId,
        uploadedByUserId: input.uploadedByUserId,
        r2Key: input.r2Key,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create conversation file');
    }
    return row;
  },

  /** Live files for a relationship, oldest first. */
  async listFiles(relationshipId: string): Promise<ConversationFile[]> {
    return db
      .select()
      .from(conversationFiles)
      .where(
        and(
          eq(conversationFiles.relationshipId, relationshipId),
          isNull(conversationFiles.deletedAt)
        )
      )
      .orderBy(asc(conversationFiles.createdAt));
  },

  /**
   * Live-row activity counts for ONE thread — interaction-depth analytics for
   * the proposal-request commit moment (BAL-272). Two indexed live-row counts
   * (`deleted_at IS NULL`, any sender/uploader) in parallel; zeros for an
   * empty or unknown thread (COUNT over no rows — never throws on a bad id).
   */
  async countThreadActivity(
    relationshipId: string
  ): Promise<{ messageCount: number; fileCount: number }> {
    const [messageRows, fileRows] = await Promise.all([
      db
        .select({ value: count() })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.relationshipId, relationshipId),
            isNull(conversationMessages.deletedAt)
          )
        ),
      db
        .select({ value: count() })
        .from(conversationFiles)
        .where(
          and(
            eq(conversationFiles.relationshipId, relationshipId),
            isNull(conversationFiles.deletedAt)
          )
        ),
    ]);
    return {
      messageCount: messageRows[0]?.value ?? 0,
      fileCount: fileRows[0]?.value ?? 0,
    };
  },

  /**
   * Upsert the viewer's read watermark for a thread. NEVER moves backwards:
   * the conflict arm sets `GREATEST(existing, EXCLUDED.last_read_at)`, so
   * concurrent or out-of-order marks (multi-tab, retries) keep the newest
   * instant. The arbiter is the PARTIAL unique index
   * `conversation_read_state_unique_idx (relationship_id, user_id) WHERE
   * deleted_at IS NULL` — `targetWhere` MUST restate that predicate or
   * Postgres cannot match the index and the insert throws a raw 23505 on the
   * second mark. FK violations (23503) surface raw for an unknown
   * relationship/user id, mirroring `postMessage`/`addFile`.
   */
  async markThreadRead(input: {
    relationshipId: string;
    userId: string;
    at: Date;
  }): Promise<ConversationReadState> {
    const [row] = await db
      .insert(conversationReadStates)
      .values({
        relationshipId: input.relationshipId,
        userId: input.userId,
        lastReadAt: input.at,
      })
      .onConflictDoUpdate({
        target: [conversationReadStates.relationshipId, conversationReadStates.userId],
        // Partial-index arbiter — predicate REQUIRED (must match the index's
        // WHERE clause exactly).
        targetWhere: isNull(conversationReadStates.deletedAt),
        set: {
          lastReadAt: sql`GREATEST(${conversationReadStates.lastReadAt}, EXCLUDED.last_read_at)`,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to upsert conversation read state');
    }
    return row;
  },
};
