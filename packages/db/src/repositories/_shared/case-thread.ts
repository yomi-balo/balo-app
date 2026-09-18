import { and, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../client';
import { conversationContexts, conversations, engagements } from '../../schema';

/**
 * ⚠ THE ONE DEFINITION OF "this case has a LIVE thread", as a correlated `EXISTS` over the
 * OUTER query's `engagements` row.
 *
 * WHY IT IS A SHARED PREDICATE AND NOT A COPY. `authorizeEngagementConversation` denies
 * `no_thread` when there is no live `conversations` row on the `engagement` label, and
 * `resolveCaseAccess` collapses that denial into the case page's `notFound()`. So a case with
 * no live thread 404s — and any list that offers it is offering a dead card. BAL-566's Up next
 * read and BAL-567's Cases index both have to answer exactly that question, and two hand-copied
 * `EXISTS` blocks would be two definitions of "live thread" free to drift apart. Extracted from
 * `upcoming-meetings.ts` (BAL-566), where it was written first.
 *
 * ⚠ IT CORRELATES ON `engagements.id`, so the calling query MUST have `engagements` in its FROM
 * list, unaliased. Every caller today starts from that table.
 *
 * ⚠ BUILT PER CALL, NEVER HOISTED TO A MODULE CONSTANT. `db` is a `let` that the integration
 * harness swaps for the per-test transaction (`_setDb`), so a subquery captured at module load
 * would bind the wrong executor.
 *
 * ⚠ BOTH LEGS FILTER `deleted_at IS NULL` — the join row AND the conversation — because
 * `conversationsRepository.findByContext`, the function this predicate mirrors, filters both.
 */
export function caseHasLiveThread(): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(conversationContexts)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, conversationContexts.conversationId),
          isNull(conversations.deletedAt)
        )
      )
      .where(
        and(
          eq(conversationContexts.contextType, 'engagement'),
          eq(conversationContexts.contextId, engagements.id),
          isNull(conversationContexts.deletedAt)
        )
      )
  );
}
