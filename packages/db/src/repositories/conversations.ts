import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  conversationMessages,
  conversationFiles,
  type ConversationMessage,
  type ConversationFile,
} from '../schema';

export const conversationsRepository = {
  /** Post a message to a relationship's thread. */
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

  /** Attach a file to a relationship's conversation. Unique r2_key enforced. */
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
