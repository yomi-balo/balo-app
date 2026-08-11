import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../client';
import { conversationContexts, conversations } from '../../schema';
import type { Conversation, ConversationContext, ConversationContextType } from '../../schema';
import { requestExpertRelationshipFactory } from './request-expert-relationship.factory';

interface ConversationFactoryOverrides {
  /** Anchor label. Defaults to `relationship`. */
  contextType?: ConversationContextType;
  /**
   * Anchor subject id. Defaults to a FRESH relationship seeded by
   * `requestExpertRelationshipFactory` — which already provisions that relationship's
   * conversation, so the default path REUSES it rather than minting a second one. Minting a
   * second would violate `conversation_context_subject_idx` (one live thread per subject).
   */
  contextId?: string;
}

export interface ConversationFactoryResult {
  conversation: Conversation;
  context: ConversationContext;
  /** Present only on the default path — the relationship this thread is anchored to. */
  relationshipId?: string;
}

/**
 * Seeds a conversation plus its single live anchor.
 *
 * RAW inserts, deliberately — a factory must be able to seed shapes the repository refuses
 * (a soft-deleted context, a second thread on a soft-deleted subject), so it does not route
 * through `conversationsRepository.ensureForContext`.
 */
export async function conversationFactory(
  overrides: ConversationFactoryOverrides = {}
): Promise<ConversationFactoryResult> {
  const contextType = overrides.contextType ?? 'relationship';

  // DEFAULT PATH — reuse the thread the relationship factory already provisioned.
  if (overrides.contextId === undefined && contextType === 'relationship') {
    const { relationship } = await requestExpertRelationshipFactory();
    const [row] = await db
      .select({ conversation: conversations, context: conversationContexts })
      .from(conversationContexts)
      .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
      .where(
        and(
          eq(conversationContexts.contextType, 'relationship'),
          eq(conversationContexts.contextId, relationship.id),
          isNull(conversationContexts.deletedAt)
        )
      )
      .limit(1);
    if (row === undefined) {
      throw new Error('requestExpertRelationshipFactory did not provision a conversation');
    }
    return {
      conversation: row.conversation,
      context: row.context,
      relationshipId: relationship.id,
    };
  }

  if (overrides.contextId === undefined) {
    throw new Error(
      `conversationFactory: contextId is required for contextType '${contextType}' (only 'relationship' has a default anchor).`
    );
  }

  const [conversation] = await db.insert(conversations).values({}).returning();
  if (conversation === undefined) {
    throw new Error('conversation insert failed');
  }
  const [context] = await db
    .insert(conversationContexts)
    .values({ conversationId: conversation.id, contextType, contextId: overrides.contextId })
    .returning();
  if (context === undefined) {
    throw new Error('conversation context insert failed');
  }
  return { conversation, context };
}
