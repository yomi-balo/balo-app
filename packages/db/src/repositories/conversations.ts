import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  ConversationContextTypeLabel,
  ConversationReadScope,
} from '@balo/shared/conversations';
import { db } from '../client';
import {
  conversationContexts,
  conversationMessages,
  conversationFiles,
  conversationReadStates,
  conversations,
  users,
  type Conversation,
  type ConversationContext,
  type ConversationContextType,
  type ConversationFile,
  type ConversationMessage,
  type ConversationReadState,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * TWO-WAY DRIFT GUARD between the pgEnum (`conversation_context_type`) and the hand-restated
 * union in `@balo/shared/conversations` (which cannot import a pgEnum without dragging
 * `postgres` into every client bundle). THIS module is the one place that can see both.
 *
 * Mirrors how `apps/api/src/services/meetings/authorize-meeting-participation.ts` pins
 * `MEETING_CONTEXT_PRECEDENCE`. A third label added on either side fails `tsc` here until it
 * is added on the other.
 */
type MissingConversationLabel = Exclude<ConversationContextType, ConversationContextTypeLabel>;
type StrayConversationLabel = Exclude<ConversationContextTypeLabel, ConversationContextType>;
type AssertNever<T extends never> = T;
export type AssertConversationContextLabelsMatch = [
  AssertNever<MissingConversationLabel>,
  AssertNever<StrayConversationLabel>,
];

/** Later of two nullable instants — null only when both are null. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * A conversation's anchor. `contextId` targets a `request_expert_relationships.id` (label
 * `relationship`) or an `engagements.id` (label `engagement`).
 *
 * ⚠⚠ UNVALIDATED AND UNCONSTRAINED. `conversation_contexts.context_id` has NO FK and there
 * is no RLS behind it, so a uuid belonging to ANOTHER TENANT does not raise `23503` — it
 * succeeds silently, and the read path then hands back that company's private thread
 * verbatim. EVERY CALLER must resolve the context's owning party and check a capability
 * BEFORE passing a ref in. The full statement of the obligation lives on the table in
 * `schema/conversations.ts`.
 */
export interface ConversationContextRef {
  contextType: ConversationContextType;
  contextId: string;
}

/** Stable map key for a batch context lookup. */
export function conversationContextKey(ref: ConversationContextRef): string {
  return `${ref.contextType}:${ref.contextId}`;
}

/**
 * Thrown by `attachContext` when the target `(contextType, contextId)` is already claimed by
 * a DIFFERENT live conversation. A NAMED error (mirroring `MeetingAdminContextExistsError`)
 * so callers branch on a type instead of string-matching driver SQLSTATEs.
 *
 * ⚠ NOT swallowed. This is the 1:1 invariant — "one live thread per subject" — being
 * violated, which means two threads exist for one case or one relationship. That is exactly
 * the state `conversation_context_subject_idx` exists to make unrepresentable.
 */
export class ConversationContextTakenError extends Error {
  constructor(
    public readonly contextType: ConversationContextType,
    public readonly contextId: string,
    public readonly existingConversationId: string
  ) {
    super(
      `Context ${contextType}:${contextId} is already anchored to conversation ${existingConversationId}`
    );
    this.name = 'ConversationContextTakenError';
  }
}

/** One thread's batch summary row — see `listThreadSummaries`. */
export interface ConversationThreadSummary {
  conversationId: string;
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

/** `unreadSummaryFor`'s answer — see its docblock for the borrowed "unread" definition. */
export interface ConversationUnreadSummary {
  unreadMessageCount: number;
  unreadFileCount: number;
  /**
   * How many DISTINCT people authored the unread activity (messages ∪ files). The digest
   * needs it to decide whether it may honestly NAME a sender: a coalesced 10-minute window
   * legitimately spans two people, and naming only the newest misattributes the rest.
   * `0` when nothing is unread.
   */
  distinctInboundSenderCount: number;
  /** max(newest inbound message, newest inbound file) — the `latestInboundActivityAt` rule. */
  latestInboundAt: Date | null;
  latestInboundSenderUserId: string | null;
  /** Body of the newest inbound MESSAGE, or null when the newest activity is a file. */
  latestInboundBody: string | null;
  /** File name of the newest inbound FILE, or null when the newest activity is a message. */
  latestInboundFileName: string | null;
}

/**
 * The `{ kind: 'meeting' }` narrowing, applied inside the message `where`.
 *
 * ⚠ `eq(col, value)` ON A NULL COLUMN IS NULL ⇒ NOT TRUE, SO MESSAGES WITH
 * `sent_during_meeting_id IS NULL` ARE EXCLUDED FOR A MEETING-LEVEL GUEST BY CONSTRUCTION.
 * That is the binding decision, not an oversight: a guest admitted to ONE call must never
 * read what the parties said between calls. DO NOT "fix" this with an `or(isNull(...))`.
 */
function messageScopePredicate(scope: ConversationReadScope): SQL | undefined {
  return scope.kind === 'meeting'
    ? eq(conversationMessages.sentDuringMeetingId, scope.meetingId)
    : undefined;
}

export const conversationsRepository = {
  // ── The context seam (BAL-424) ───────────────────────────────────────

  /**
   * IDEMPOTENT GET-OR-CREATE for one anchor, in ONE transaction.
   *
   * Inserts the `conversations` row, then the `conversation_contexts` row with an
   * `onConflictDoNothing` whose arbiter restates `conversation_context_subject_idx`'s
   * PARTIAL predicate EXACTLY — `deleted_at IS NULL`, literal-inlined via raw `sql` because
   * a Drizzle `eq()` Param in an arbiter predicate fails `42P10` (memory
   * `reference_pg_partial_index_arbiter_param_42p10`). On conflict the orphan conversation
   * is rolled back and the EXISTING one is returned with `created: false`.
   *
   * Accepts an optional executor so kickoff / case creation / invite can enlist it in their
   * own transaction; standalone it self-wraps.
   *
   * ⚠ NO NESTED SAVEPOINT IS TAKEN WHEN AN EXECUTOR IS SUPPLIED, AND NONE IS NEEDED:
   * `onConflictDoNothing` RETURNS zero rows rather than raising `23505`, so the conflict
   * path cannot abort an ambient transaction (`25P02`). The only other statements here are
   * an insert of a row we just minted and a delete of that same row.
   */
  async ensureForContext(
    ref: ConversationContextRef,
    exec?: DbExecutor
  ): Promise<{ conversation: Conversation; created: boolean }> {
    /**
     * READ-FIRST FAST PATH. Eager provisioning (`invite()`, `caseEngagementsRepository
     * .create()`, `projectEngagementsRepository.create()`) means the STEADY STATE is a hit,
     * and every conversation call site runs this on every request. Without this branch the
     * hit path still paid an INSERT into `conversations`, an INSERT that conflicts away, a
     * DELETE of the orphan, and the RI cascade that DELETE triggers — four writes and a WAL
     * record to answer a question a single indexed SELECT answers. Rides
     * `conversation_context_subject_idx`.
     *
     * ⚠ IT IS A FAST PATH, NOT THE GATE. The insert path below stays fully correct on its
     * own (the `onConflictDoNothing` arbiter is what actually makes this idempotent under
     * concurrency); this branch only skips it when the answer is already known. Two
     * concurrent callers that both miss the read still resolve to ONE conversation.
     */
    const existingHit = await selectConversationByContext(exec ?? db, ref);
    if (existingHit !== undefined) {
      return { conversation: existingHit, created: false };
    }

    const run = async (
      tx: DbExecutor
    ): Promise<{ conversation: Conversation; created: boolean }> => {
      const [conversation] = await tx.insert(conversations).values({}).returning();
      if (conversation === undefined) {
        throw new Error('Failed to create conversation');
      }

      const [context] = await tx
        .insert(conversationContexts)
        .values({
          conversationId: conversation.id,
          contextType: ref.contextType,
          contextId: ref.contextId,
        })
        .onConflictDoNothing({
          target: [conversationContexts.contextType, conversationContexts.contextId],
          // Arbiter predicate MUST match `conversation_context_subject_idx` exactly.
          where: sql`${conversationContexts.deletedAt} IS NULL`,
        })
        .returning();

      if (context !== undefined) {
        return { conversation, created: true };
      }

      // The subject is already claimed. Undo the orphan conversation we just minted and
      // return the incumbent — `ensureForContext` is a get-or-create, never a duplicator.
      await tx.delete(conversations).where(eq(conversations.id, conversation.id));

      const existing = await selectConversationByContext(tx, ref);
      if (existing === undefined) {
        throw new Error(
          `conversations.ensureForContext conflicted but no live conversation was found for ${conversationContextKey(ref)}`
        );
      }
      return { conversation: existing, created: false };
    };

    return exec === undefined ? db.transaction(run) : run(exec);
  },

  /**
   * Attach an ADDITIONAL anchor to an EXISTING conversation — the kickoff carry-over.
   *
   * Same `onConflictDoNothing` arbiter as `ensureForContext`. On conflict it re-reads the
   * live row: if it already points at THIS conversation the call is an idempotent no-op and
   * that row is returned (mirroring `meetingContextsRepository.attach`); if it points at a
   * DIFFERENT conversation the 1:1 invariant is being violated and
   * `ConversationContextTakenError` is thrown rather than swallowed.
   */
  async attachContext(
    input: { conversationId: string } & ConversationContextRef,
    exec?: DbExecutor
  ): Promise<ConversationContext> {
    const tx = exec ?? db;
    const [inserted] = await tx
      .insert(conversationContexts)
      .values({
        conversationId: input.conversationId,
        contextType: input.contextType,
        contextId: input.contextId,
      })
      .onConflictDoNothing({
        target: [conversationContexts.contextType, conversationContexts.contextId],
        where: sql`${conversationContexts.deletedAt} IS NULL`,
      })
      .returning();

    if (inserted !== undefined) {
      return inserted;
    }

    const [existing] = await tx
      .select()
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.contextType, input.contextType),
          eq(conversationContexts.contextId, input.contextId),
          isNull(conversationContexts.deletedAt)
        )
      )
      .limit(1);

    if (existing === undefined) {
      throw new Error(
        `conversations.attachContext conflicted but no live context row was found for ${conversationContextKey(input)}`
      );
    }
    if (existing.conversationId !== input.conversationId) {
      throw new ConversationContextTakenError(
        input.contextType,
        input.contextId,
        existing.conversationId
      );
    }
    return existing;
  },

  /**
   * The live conversation for ONE anchor, or `undefined`. Both sides filter
   * `deleted_at IS NULL`. Rides `conversation_context_subject_idx`.
   */
  async findByContext(
    ref: ConversationContextRef,
    exec?: DbExecutor
  ): Promise<Conversation | undefined> {
    return selectConversationByContext(exec ?? db, ref);
  },

  /**
   * Batch of `findByContext`, keyed by `conversationContextKey`. Misses are simply absent
   * from the Map. Empty input ⇒ empty Map, NO QUERY — this is what keeps the portfolio and
   * realtime-token paths off an N+1.
   *
   * ⚠ A READ. It never writes, which is why the portfolio loader uses it rather than
   * `ensureManyForContexts`.
   */
  async conversationIdsForContexts(refs: ConversationContextRef[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (refs.length === 0) {
      return result;
    }

    const rows = await db
      .select({
        contextType: conversationContexts.contextType,
        contextId: conversationContexts.contextId,
        conversationId: conversationContexts.conversationId,
      })
      .from(conversationContexts)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, conversationContexts.conversationId),
          isNull(conversations.deletedAt)
        )
      )
      .where(and(contextRefsPredicate(refs), isNull(conversationContexts.deletedAt)));

    const wanted = new Set(refs.map(conversationContextKey));
    for (const row of rows) {
      const key = conversationContextKey(row);
      // The `inArray` pair-filter is a cross-product over the two columns, so a row whose
      // (type, id) combination was not actually requested can come back. Drop it.
      if (wanted.has(key)) {
        result.set(key, row.conversationId);
      }
    }
    return result;
  },

  /**
   * `conversationIdsForContexts`, then `ensureForContext` for the misses. Used by the Ably
   * token action and the conversation view loaders, where a thread that does not yet exist
   * must not silently drop out of the entitled-channel list.
   *
   * ⚠ IT WRITES. A pure read path must call `conversationIdsForContexts` instead.
   */
  async ensureManyForContexts(refs: ConversationContextRef[]): Promise<Map<string, string>> {
    const found = await conversationsRepository.conversationIdsForContexts(refs);
    for (const ref of refs) {
      const key = conversationContextKey(ref);
      if (found.has(key)) {
        continue;
      }
      const { conversation } = await conversationsRepository.ensureForContext(ref);
      found.set(key, conversation.id);
    }
    return found;
  },

  /**
   * Every live anchor of one conversation, oldest first. After kickoff carry-over a project
   * thread legitimately has TWO (`relationship` + `engagement`) — see deviation 3 on
   * `conversation_contexts`. Feeds the guest scope resolver.
   */
  async listContexts(conversationId: string): Promise<ConversationContext[]> {
    return db
      .select()
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.conversationId, conversationId),
          isNull(conversationContexts.deletedAt)
        )
      )
      .orderBy(asc(conversationContexts.createdAt), asc(conversationContexts.id));
  },

  // ── Messages ─────────────────────────────────────────────────────────

  /**
   * Post a message to a conversation.
   *
   * CONTRACT — bare INSERT, no error isolation. A single un-wrapped `db.insert(...)` that
   * can throw a raw FK violation (23503) for an unknown `conversationId` (ON DELETE cascade),
   * `senderUserId` (ON DELETE restrict) or `sentDuringMeetingId` (ON DELETE set null); this
   * table has no unique constraint. If called INSIDE an open `db.transaction(...)`, that
   * error ABORTS the transaction (25P02) — every later statement fails until rollback. The
   * caller MUST isolate this insert in its own SAVEPOINT (nested `tx.transaction(...)`) so a
   * bad id can't poison a wider transaction.
   */
  async postMessage(input: {
    conversationId: string;
    senderUserId: string;
    body: string;
    /** BAL-418 seam — set ONLY when the message was sent from the in-call panel. */
    sentDuringMeetingId?: string;
  }): Promise<ConversationMessage> {
    const [row] = await db
      .insert(conversationMessages)
      .values({
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        body: input.body,
        ...(input.sentDuringMeetingId === undefined
          ? {}
          : { sentDuringMeetingId: input.sentDuringMeetingId }),
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create conversation message');
    }
    return row;
  },

  /**
   * Live messages for a conversation, chronological (oldest first), narrowed by `scope`.
   *
   * ⚠ `scope` IS REQUIRED, NOT OPTIONAL, AND THAT IS THE WHOLE POINT. A meeting-level guest
   * must never see a message that was not sent during their call. An optional parameter
   * would default to "show everything" and the filter would be one forgotten argument away
   * from a disclosure. Every party call site states `{ kind: 'full' }` explicitly.
   */
  async listMessages(
    conversationId: string,
    scope: ConversationReadScope
  ): Promise<ConversationMessage[]> {
    return db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          isNull(conversationMessages.deletedAt),
          messageScopePredicate(scope)
        )
      )
      .orderBy(asc(conversationMessages.createdAt));
  },

  /**
   * Keyset page of live messages with sender names, NEWEST-first internally;
   * returned chronological (oldest first) so callers can render top-down.
   *
   * Keyset is STRICT `(created_at, id) < (before.createdAt, before.id)` — same-timestamp
   * neighbours are disambiguated by `id`, so repeated "load earlier" calls never duplicate
   * or skip a row. Fetches `limit + 1` rows to derive `hasEarlier` without a second COUNT
   * round trip, then slices to `limit` and reverses. Rides the partial index
   * `conversation_message_thread_idx (conversation_id, created_at) WHERE deleted_at IS NULL`.
   *
   * ⚠ `scope` IS REQUIRED — see `listMessages`. A `{ kind: 'meeting' }` scope also EXCLUDES
   * every message whose `sent_during_meeting_id IS NULL`, by construction (see
   * `messageScopePredicate`).
   */
  async listMessagesPage(input: {
    conversationId: string;
    scope: ConversationReadScope;
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
          eq(conversationMessages.conversationId, input.conversationId),
          isNull(conversationMessages.deletedAt),
          messageScopePredicate(input.scope),
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
   * THE NEWEST LIVE MESSAGE PER RELATIONSHIP, for the inbox/detail recency fold.
   *
   * Exists because the Drizzle relational hop `with: { conversationMessages }` cannot
   * traverse the no-FK seam: relationship → `conversation_contexts` (polymorphic, no FK) →
   * `conversations` → messages. ONE round trip: contexts (`context_type='relationship'`) →
   * conversations → DISTINCT ON newest live message. Returns an entry only for
   * relationships that HAVE one. Empty input ⇒ empty Map, no query.
   *
   * ⚠ SHARED BY BOTH REWRITTEN HOPS (`project-requests.ts` and `projects-inbox.ts`) rather
   * than inlined twice — the SonarCloud new-code duplication gate is 3% and two ~25-line
   * DISTINCT ON blocks would trip it.
   */
  async latestMessagesForRelationships(
    relationshipIds: string[]
  ): Promise<Map<string, { id: string; createdAt: Date }>> {
    const result = new Map<string, { id: string; createdAt: Date }>();
    if (relationshipIds.length === 0) {
      return result;
    }

    const rows = await db
      .selectDistinctOn([conversationContexts.contextId], {
        relationshipId: conversationContexts.contextId,
        id: conversationMessages.id,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationContexts)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, conversationContexts.conversationId),
          isNull(conversations.deletedAt)
        )
      )
      .innerJoin(
        conversationMessages,
        and(
          eq(conversationMessages.conversationId, conversations.id),
          isNull(conversationMessages.deletedAt)
        )
      )
      .where(
        and(
          eq(conversationContexts.contextType, 'relationship'),
          inArray(conversationContexts.contextId, relationshipIds),
          isNull(conversationContexts.deletedAt)
        )
      )
      .orderBy(
        conversationContexts.contextId,
        desc(conversationMessages.createdAt),
        desc(conversationMessages.id)
      );

    for (const row of rows) {
      result.set(row.relationshipId, { id: row.id, createdAt: row.createdAt });
    }
    return result;
  },

  // ── Batch summaries ──────────────────────────────────────────────────

  /**
   * Batch per-thread summary for the tab strip / default-tab logic — ONE round trip for any
   * number of threads. Every leg filters `deleted_at IS NULL`:
   *
   * - `latestMessage`  — newest live message, ANY sender (tab preview);
   * - `latestInboundActivityAt` — max(newest live message NOT from the viewer, newest live
   *   file NOT from the viewer): the viewer's own activity never makes a thread unread, and
   *   a file can arrive without a message (nothing auto-posts), so files count toward
   *   inbound;
   * - `fileCount`  — live files, any uploader (Files pill badge);
   * - `lastReadAt` — the VIEWER's live watermark from `conversation_read_states`.
   *
   * ⚠ THE OUTER `FROM` IS `conversations`, NOT `request_expert_relationships` (BAL-424).
   * That removes the last read on this platform that reached SOFT-DELETED relationship rows:
   * a soft-deleted CONVERSATION is now excluded, and a relationship's lifecycle no longer
   * decides what this returns. `authorize-engagement-host.ts`'s "known limitation" paragraph
   * names this join — it is now strictly stronger than that paragraph claims.
   *
   * Returns exactly one element per input id, in input order, with zeros/nulls for empty
   * threads. Empty input → `[]` (no query).
   */
  async listThreadSummaries(input: {
    conversationIds: string[];
    viewerUserId: string;
  }): Promise<ConversationThreadSummary[]> {
    if (input.conversationIds.length === 0) {
      return [];
    }

    // Newest live message per thread (any sender) via DISTINCT ON.
    const latestMessageSq = db
      .selectDistinctOn([conversationMessages.conversationId], {
        conversationId: conversationMessages.conversationId,
        id: conversationMessages.id,
        body: conversationMessages.body,
        createdAt: conversationMessages.createdAt,
        senderUserId: conversationMessages.senderUserId,
      })
      .from(conversationMessages)
      .where(
        and(
          inArray(conversationMessages.conversationId, input.conversationIds),
          isNull(conversationMessages.deletedAt)
        )
      )
      .orderBy(
        conversationMessages.conversationId,
        desc(conversationMessages.createdAt),
        desc(conversationMessages.id)
      )
      .as('latest_message');

    // Newest live message per thread NOT sent by the viewer.
    const inboundMessageSq = db
      .select({
        conversationId: conversationMessages.conversationId,
        latestAt: max(conversationMessages.createdAt).as('latest_inbound_message_at'),
      })
      .from(conversationMessages)
      .where(
        and(
          inArray(conversationMessages.conversationId, input.conversationIds),
          isNull(conversationMessages.deletedAt),
          ne(conversationMessages.senderUserId, input.viewerUserId)
        )
      )
      .groupBy(conversationMessages.conversationId)
      .as('inbound_message');

    // Newest live file per thread NOT uploaded by the viewer.
    const inboundFileSq = db
      .select({
        conversationId: conversationFiles.conversationId,
        latestAt: max(conversationFiles.createdAt).as('latest_inbound_file_at'),
      })
      .from(conversationFiles)
      .where(
        and(
          inArray(conversationFiles.conversationId, input.conversationIds),
          isNull(conversationFiles.deletedAt),
          ne(conversationFiles.uploadedByUserId, input.viewerUserId)
        )
      )
      .groupBy(conversationFiles.conversationId)
      .as('inbound_file');

    // Live file count per thread, ANY uploader (different filter from the inbound leg
    // above, so it is its own grouped subquery).
    const fileCountSq = db
      .select({
        conversationId: conversationFiles.conversationId,
        fileCount: count().as('file_count'),
      })
      .from(conversationFiles)
      .where(
        and(
          inArray(conversationFiles.conversationId, input.conversationIds),
          isNull(conversationFiles.deletedAt)
        )
      )
      .groupBy(conversationFiles.conversationId)
      .as('file_count_leg');

    // The viewer's live read watermark — at most one row per thread thanks to the partial
    // unique index `conversation_read_state_unique_idx`.
    const readStateSq = db
      .select({
        conversationId: conversationReadStates.conversationId,
        lastReadAt: conversationReadStates.lastReadAt,
      })
      .from(conversationReadStates)
      .where(
        and(
          inArray(conversationReadStates.conversationId, input.conversationIds),
          eq(conversationReadStates.userId, input.viewerUserId),
          isNull(conversationReadStates.deletedAt)
        )
      )
      .as('read_state');

    const rows = await db
      .select({
        conversationId: conversations.id,
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
      .from(conversations)
      .leftJoin(latestMessageSq, eq(latestMessageSq.conversationId, conversations.id))
      .leftJoin(users, eq(users.id, latestMessageSq.senderUserId))
      .leftJoin(inboundMessageSq, eq(inboundMessageSq.conversationId, conversations.id))
      .leftJoin(inboundFileSq, eq(inboundFileSq.conversationId, conversations.id))
      .leftJoin(fileCountSq, eq(fileCountSq.conversationId, conversations.id))
      .leftJoin(readStateSq, eq(readStateSq.conversationId, conversations.id))
      .where(
        and(inArray(conversations.id, input.conversationIds), isNull(conversations.deletedAt))
      );

    // One element per INPUT id, in input order — unknown / soft-deleted ids (defensive) get
    // the empty shape.
    const byId = new Map(rows.map((row) => [row.conversationId, row]));
    return input.conversationIds.map((conversationId) => {
      const row = byId.get(conversationId);
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
        conversationId,
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
   * THE BAL-420 FIRE-TIME RECHECK'S READ (`conversation_unread`). For ONE (conversation,
   * viewer): what is still unread strictly after the viewer's watermark. A viewer with no
   * watermark row has read nothing, so everything counts.
   *
   * ⚠⚠ "UNREAD ACTIVITY" MEANS MESSAGES **AND** FILES, AND THE DEFINITION IS BORROWED, NOT
   * REWRITTEN. `listThreadSummaries`'s `latestInboundActivityAt` is already
   * `max(newest live inbound message, newest live inbound file)` — because a file can arrive
   * with no message at all (nothing auto-posts). This method MIRRORS that exact definition,
   * or the platform holds two contradictory answers to "is this thread unread": the tab
   * strip would show a badge while the digest guard skipped the email.
   *
   * INBOUND = `sender_user_id <> viewerUserId` on messages, `uploaded_by_user_id <>
   * viewerUserId` on files. The viewer's own activity never makes a thread unread.
   *
   * The two counts are returned SEPARATELY so the email can say "3 new messages and 1 file"
   * rather than an undifferentiated 4, and so a FILE-ONLY exchange (which today produces an
   * in-app notification and no email ever) still publishes. `publish` is warranted when
   * `unreadMessageCount + unreadFileCount > 0`.
   *
   * `latestInboundBody` is NULL when the newest inbound activity is a FILE — the template
   * then renders the file name instead of a message preview (and vice versa).
   */
  async unreadSummaryFor(input: {
    conversationId: string;
    viewerUserId: string;
  }): Promise<ConversationUnreadSummary> {
    const [watermarkRow] = await db
      .select({ lastReadAt: conversationReadStates.lastReadAt })
      .from(conversationReadStates)
      .where(
        and(
          eq(conversationReadStates.conversationId, input.conversationId),
          eq(conversationReadStates.userId, input.viewerUserId),
          isNull(conversationReadStates.deletedAt)
        )
      )
      .limit(1);
    const watermark = watermarkRow?.lastReadAt ?? null;

    // STRICTLY after the watermark. `gt(column, Date)` — never a raw `sql` fragment: a bare
    // `Date` in a raw fragment gives postgres-js no column to infer the parameter type from
    // and fails to serialize (the `meeting-contexts.ts` `::timestamptz` note).
    const unreadMessageWhere = and(
      eq(conversationMessages.conversationId, input.conversationId),
      isNull(conversationMessages.deletedAt),
      ne(conversationMessages.senderUserId, input.viewerUserId),
      watermark === null ? undefined : gt(conversationMessages.createdAt, watermark)
    );
    const unreadFileWhere = and(
      eq(conversationFiles.conversationId, input.conversationId),
      isNull(conversationFiles.deletedAt),
      ne(conversationFiles.uploadedByUserId, input.viewerUserId),
      watermark === null ? undefined : gt(conversationFiles.createdAt, watermark)
    );

    const [
      messageCountRows,
      fileCountRows,
      newestMessageRows,
      newestFileRows,
      messageSenderRows,
      fileSenderRows,
    ] = await Promise.all([
      db.select({ value: count() }).from(conversationMessages).where(unreadMessageWhere),
      db.select({ value: count() }).from(conversationFiles).where(unreadFileWhere),
      db
        .select({
          id: conversationMessages.id,
          body: conversationMessages.body,
          createdAt: conversationMessages.createdAt,
          senderUserId: conversationMessages.senderUserId,
        })
        .from(conversationMessages)
        .where(unreadMessageWhere)
        .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
        .limit(1),
      db
        .select({
          id: conversationFiles.id,
          fileName: conversationFiles.fileName,
          createdAt: conversationFiles.createdAt,
          uploadedByUserId: conversationFiles.uploadedByUserId,
        })
        .from(conversationFiles)
        .where(unreadFileWhere)
        .orderBy(desc(conversationFiles.createdAt), desc(conversationFiles.id))
        .limit(1),
      // The DISTINCT authors of the unread activity, per leg. Grouped rather than
      // `countDistinct`ed so the two legs can be unioned in JS — a person who sent both a
      // message and a file inside the window is ONE sender, not two.
      db
        .selectDistinct({ userId: conversationMessages.senderUserId })
        .from(conversationMessages)
        .where(unreadMessageWhere),
      db
        .selectDistinct({ userId: conversationFiles.uploadedByUserId })
        .from(conversationFiles)
        .where(unreadFileWhere),
    ]);

    const [newestMessage] = newestMessageRows;
    const [newestFile] = newestFileRows;
    const distinctInboundSenderCount = new Set([
      ...messageSenderRows.map((r) => r.userId),
      ...fileSenderRows.map((r) => r.userId),
    ]).size;

    // Which of the two legs is the NEWEST inbound activity decides which of `body` /
    // `fileName` is populated — exactly one of them, never both. A tie goes to the message
    // (it carries the richer preview).
    let latestInboundSenderUserId: string | null = null;
    let latestInboundBody: string | null = null;
    let latestInboundFileName: string | null = null;
    if (
      newestMessage !== undefined &&
      (newestFile === undefined ||
        newestMessage.createdAt.getTime() >= newestFile.createdAt.getTime())
    ) {
      latestInboundSenderUserId = newestMessage.senderUserId;
      latestInboundBody = newestMessage.body;
    } else if (newestFile !== undefined) {
      latestInboundSenderUserId = newestFile.uploadedByUserId;
      latestInboundFileName = newestFile.fileName;
    }

    return {
      unreadMessageCount: messageCountRows[0]?.value ?? 0,
      unreadFileCount: fileCountRows[0]?.value ?? 0,
      distinctInboundSenderCount,
      latestInboundAt: laterOf(newestMessage?.createdAt ?? null, newestFile?.createdAt ?? null),
      latestInboundSenderUserId,
      latestInboundBody,
      latestInboundFileName,
    };
  },

  // ── Files ────────────────────────────────────────────────────────────

  /**
   * Attach a file to a conversation. Unique r2_key enforced.
   *
   * CONTRACT — bare INSERT, no error isolation. A single un-wrapped `db.insert(...)` that
   * can throw a raw constraint violation: unique (23505) on a duplicate `r2Key`
   * (`conversation_file_key_idx`), or FK (23503) on an unknown `conversationId` (ON DELETE
   * cascade) / `uploadedByUserId` (ON DELETE restrict). If called INSIDE an open
   * `db.transaction(...)`, that error ABORTS the transaction (25P02) — every later statement
   * fails until rollback. The caller MUST isolate this insert — its own SAVEPOINT (nested
   * `tx.transaction(...)`), or pre-empt the duplicate with
   * `.onConflictDoNothing({ target: conversationFiles.r2Key })`.
   */
  async addFile(input: {
    conversationId: string;
    uploadedByUserId: string;
    r2Key: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<ConversationFile> {
    const [row] = await db
      .insert(conversationFiles)
      .values({
        conversationId: input.conversationId,
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

  /**
   * Live files for a conversation, oldest first.
   *
   * ⚠ A `{ kind: 'meeting' }` SCOPE RETURNS `[]` UNCONDITIONALLY, AND THAT IS THE CORRECT
   * ANSWER, NOT A STUB. `conversation_files` is CONVERSATION-scoped and carries no meeting
   * column, so there is no honest way to narrow it to one call. A meeting-level guest's
   * files are BAL-423's `meeting_files`, which is a different table with a different anchor.
   * Failing OPEN here would hand a guest the whole case's attachments.
   */
  async listFiles(
    conversationId: string,
    scope: ConversationReadScope
  ): Promise<ConversationFile[]> {
    if (scope.kind === 'meeting') {
      return [];
    }
    return db
      .select()
      .from(conversationFiles)
      .where(
        and(
          eq(conversationFiles.conversationId, conversationId),
          isNull(conversationFiles.deletedAt)
        )
      )
      .orderBy(asc(conversationFiles.createdAt));
  },

  /**
   * Live-row activity counts for ONE thread — interaction-depth analytics for the
   * proposal-request commit moment (BAL-272). Two indexed live-row counts
   * (`deleted_at IS NULL`, any sender/uploader) in parallel; zeros for an empty or unknown
   * thread (COUNT over no rows — never throws on a bad id).
   */
  async countThreadActivity(
    conversationId: string
  ): Promise<{ messageCount: number; fileCount: number }> {
    const [messageRows, fileRows] = await Promise.all([
      db
        .select({ value: count() })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            isNull(conversationMessages.deletedAt)
          )
        ),
      db
        .select({ value: count() })
        .from(conversationFiles)
        .where(
          and(
            eq(conversationFiles.conversationId, conversationId),
            isNull(conversationFiles.deletedAt)
          )
        ),
    ]);
    return {
      messageCount: messageRows[0]?.value ?? 0,
      fileCount: fileRows[0]?.value ?? 0,
    };
  },

  // ── Read watermark ───────────────────────────────────────────────────

  /**
   * Upsert the viewer's read watermark for a thread. NEVER moves backwards: the conflict arm
   * sets `GREATEST(existing, EXCLUDED.last_read_at)`, so concurrent or out-of-order marks
   * (multi-tab, retries) keep the newest instant. The arbiter is the PARTIAL unique index
   * `conversation_read_state_unique_idx (conversation_id, user_id) WHERE deleted_at IS NULL`
   * — `targetWhere` MUST restate that predicate or Postgres cannot match the index and the
   * insert throws a raw 23505 on the second mark. FK violations (23503) surface raw for an
   * unknown conversation/user id, mirroring `postMessage`/`addFile`.
   */
  async markThreadRead(input: {
    conversationId: string;
    userId: string;
    at: Date;
  }): Promise<ConversationReadState> {
    const [row] = await db
      .insert(conversationReadStates)
      .values({
        conversationId: input.conversationId,
        userId: input.userId,
        lastReadAt: input.at,
      })
      .onConflictDoUpdate({
        target: [conversationReadStates.conversationId, conversationReadStates.userId],
        // Partial-index arbiter — predicate REQUIRED (must match the index's WHERE clause
        // exactly).
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

/**
 * `(contextType, contextId)` pair filter. Postgres has no portable Drizzle helper for a row
 * constructor `IN`, so this is the cross-product of the two `inArray`s; the caller re-checks
 * each returned row against the requested key set (see `conversationIdsForContexts`).
 */
function contextRefsPredicate(refs: ConversationContextRef[]): SQL | undefined {
  const types = [...new Set(refs.map((ref) => ref.contextType))];
  const ids = [...new Set(refs.map((ref) => ref.contextId))];
  return and(
    inArray(conversationContexts.contextType, types),
    inArray(conversationContexts.contextId, ids)
  );
}

/** Shared body of `findByContext` / `ensureForContext`'s conflict re-read. */
async function selectConversationByContext(
  exec: DbExecutor,
  ref: ConversationContextRef
): Promise<Conversation | undefined> {
  const [row] = await exec
    .select({ conversation: conversations })
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .where(
      and(
        eq(conversationContexts.contextType, ref.contextType),
        eq(conversationContexts.contextId, ref.contextId),
        isNull(conversationContexts.deletedAt),
        isNull(conversations.deletedAt)
      )
    )
    .limit(1);
  return row?.conversation;
}
