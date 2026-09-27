import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { conversationFiles } from '../../schema';

interface ConversationFileFactoryInput {
  conversationId: string;
  uploadedByUserId: string;
  /**
   * REQUIRED, no default — the same reason as `conversationMessageFactory`: a defaulted
   * timestamp ties with every other row the test transaction writes.
   */
  createdAt: Date;
  deletedAt?: Date;
  /** Defaults to `seed.pdf`. */
  fileName?: string;
}

/**
 * Seeds ONE `conversation_files` row (a file shared in a thread, between calls) with a
 * controlled `createdAt` and a fresh unique `r2_key`.
 *
 * Inserts DIRECTLY via `db`: `conversationsRepository.addFile` takes no `createdAt`.
 */
export async function conversationFileFactory(
  input: ConversationFileFactoryInput
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationFiles)
    .values({
      conversationId: input.conversationId,
      uploadedByUserId: input.uploadedByUserId,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: input.fileName ?? 'seed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    })
    .returning({ id: conversationFiles.id, createdAt: conversationFiles.createdAt });
  if (row === undefined) {
    throw new Error('conversation file insert failed');
  }
  return row;
}
