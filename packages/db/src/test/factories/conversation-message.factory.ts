import { db } from '../../client';
import { conversationMessages } from '../../schema';

interface ConversationMessageFactoryInput {
  conversationId: string;
  senderUserId: string;
  /**
   * REQUIRED, no default. `defaultNow()` is the per-test transaction's start, shared by every
   * row the test writes, so a defaulted timestamp ties with everything else and makes any
   * "newest wins" or "N days ago" assertion meaningless.
   */
  createdAt: Date;
  /** Defaults to a fixed one-paragraph body. */
  body?: string;
  /** A fixed id, for keyset tie-break tests. */
  id?: string;
  deletedAt?: Date;
  /** Set only for a message sent from the in-call panel (BAL-418). */
  sentDuringMeetingId?: string;
}

/**
 * Seeds ONE `conversation_messages` row with a controlled `createdAt`.
 *
 * Inserts DIRECTLY via `db`: `conversationsRepository.postMessage` takes no `createdAt` and
 * writes no soft-deleted row, so it cannot seed a timeline.
 */
export async function conversationMessageFactory(
  input: ConversationMessageFactoryInput
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationMessages)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      body: input.body ?? '<p>Seed message.</p>',
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
      ...(input.sentDuringMeetingId === undefined
        ? {}
        : { sentDuringMeetingId: input.sentDuringMeetingId }),
    })
    .returning({ id: conversationMessages.id, createdAt: conversationMessages.createdAt });
  if (row === undefined) {
    throw new Error('conversation message insert failed');
  }
  return row;
}
