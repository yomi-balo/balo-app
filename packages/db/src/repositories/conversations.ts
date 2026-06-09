import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  conversationMessages,
  conversationFiles,
  type ConversationMessage,
  type ConversationFile,
} from '../schema';

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
};
