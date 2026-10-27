import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, gte, isNull, sql } from 'drizzle-orm';
import { DRAFT_DEADLINE_MS } from '@balo/shared/project-requests';
import type {
  ProposalDraftFailureReason,
  ProposalDraftOutput,
} from '@balo/shared/project-requests';
import { db } from '../client';
import { expertProfiles, proposalDraftGenerations, requestExpertRelationships } from '../schema';
import type { ProposalDraftGeneration } from '../schema';

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface CreateOrGetProposalDraftGenerationInput {
  readonly relationshipId: string;
  /** The expert opening the composer. The caller has already gated them on the relationship. */
  readonly requestedByUserId: string;
}

export interface CreateOrGetProposalDraftGenerationResult {
  readonly row: ProposalDraftGeneration;
  /** `true` when this call inserted the row; `false` when a live row already existed. */
  readonly created: boolean;
}

export interface FindProposalDraftGenerationForRequesterInput {
  readonly generationId: string;
  /** The relationship the web gate already access-checked. */
  readonly relationshipId: string;
  readonly requestedByUserId: string;
}

export interface FindProposalDraftGenerationForRelationshipExpertInput {
  readonly generationId: string;
  /** The user id resolved from the api bearer. */
  readonly userId: string;
}

export interface MarkProposalDraftGenerationSucceededInput {
  readonly generationId: string;
  /** The schema-validated model answer, stored raw; the web poll sanitises it. */
  readonly output: ProposalDraftOutput;
  readonly modelId: string;
  readonly promptVersion: string;
  /** Nullable: a provider can answer without reporting usage. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface MarkProposalDraftGenerationFailedInput {
  readonly generationId: string;
  /** ⚠ A FIXED literal from `PROPOSAL_DRAFT_FAILURE_REASONS`, never a model or vendor message. */
  readonly failureReason: ProposalDraftFailureReason;
}

export interface ReleaseProposalDraftGenerationInput {
  readonly generationId: string;
}

export interface CountProposalDraftGenerationsInput {
  readonly requestedByUserId: string;
  readonly since: Date;
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * ⚠⚠ THE UPSERT ARBITER — restates `proposal_draft_generations_relationship_live_idx`'s
 * predicate with NO bind parameter. Postgres proves arbiter-vs-index implication at plan time,
 * so a parameterised predicate never matches and every upsert fails `42P10` (memory
 * `reference_pg_partial_index_arbiter_param_42p10`).
 */
const LIVE_ROW_ARBITER = sql`"deleted_at" IS NULL`;

/**
 * ⚠⚠ THE CAS PREDICATE — the whole of the "terminal is terminal" guarantee. BullMQ delivers at
 * least once, and the web's `enqueue_failed` release can race the worker; whichever terminal
 * write lands second matches zero rows and returns `undefined`, which every caller reads as
 * "already terminal, nothing to do" — and as "do not fire analytics". It also refuses a
 * soft-deleted row, so a job the api did enqueue cannot write into a row the web has released.
 */
function pendingPredicate(generationId: string): ReturnType<typeof and> {
  return and(
    eq(proposalDraftGenerations.id, generationId),
    eq(proposalDraftGenerations.status, 'pending'),
    isNull(proposalDraftGenerations.deletedAt)
  );
}

// ── Repository ─────────────────────────────────────────────────────────────

/**
 * The deadline in whole seconds, for `make_interval(secs => …)` on the database clock.
 * @see DRAFT_DEADLINE_MS
 */
const DRAFT_DEADLINE_SECONDS = Math.ceil(DRAFT_DEADLINE_MS / 1000);

/**
 * `proposal_draft_generations` (BAL-611) — THE ONLY access path to the AI proposal draft's
 * handoff row. Every row read filters `deleted_at IS NULL`; the one exception is the
 * `countCreatedSince` rate count, which deliberately counts released rows too.
 *
 * ⚠ THREE READS, THREE SCOPES, AND THAT IS THE DESIGN:
 *   • {@link proposalDraftGenerationsRepository.findForRequester} — the WEB POLL. The id, the
 *     access-checked relationship AND the requesting user are all in the WHERE, so a foreign
 *     `generationId` is a not-found indistinguishable from a missing one.
 *   • {@link proposalDraftGenerationsRepository.findForRelationshipExpert} — the API ROUTE's
 *     independent re-check. A bearer yields a `userId` only, so the read joins through to the
 *     relationship's expert and requires that expert to be this user.
 *   • {@link proposalDraftGenerationsRepository.findById} — the WORKER's read. A BullMQ
 *     processor has no session to scope by. ⚠ Do not call it from a request path.
 */
export const proposalDraftGenerationsRepository = {
  /**
   * Open the relationship's one generation, or return the live one it already has. Idempotent:
   * a second call (another tab, a StrictMode double mount, a revisit) gets the same row with
   * `created: false` and the caller makes no second model call.
   *
   * The conflict arm is a deliberate no-op `SET updated_at = updated_at`: unlike `DO NOTHING`,
   * it returns the conflicting row under the same lock, so there is no racy follow-up read.
   * `created` compares the returned id with the one minted here (the
   * `scheduledNotificationsRepository.schedule` precedent).
   *
   * ⚠ NEVER CATCHES A 23505 — the upsert cannot raise one on the live-row index (memory
   * `reference_caught_23505_aborts_test_transaction`).
   */
  async createOrGetForRelationship(
    input: CreateOrGetProposalDraftGenerationInput
  ): Promise<CreateOrGetProposalDraftGenerationResult> {
    const mintedId = randomUUID();
    const [row] = await db
      .insert(proposalDraftGenerations)
      .values({
        id: mintedId,
        relationshipId: input.relationshipId,
        requestedByUserId: input.requestedByUserId,
      })
      .onConflictDoUpdate({
        target: proposalDraftGenerations.relationshipId,
        // ⚠⚠ Removing or parameterising this line breaks EVERY call with 42P10 at runtime.
        targetWhere: LIVE_ROW_ARBITER,
        set: { updatedAt: sql`${proposalDraftGenerations.updatedAt}` },
      })
      .returning();
    if (row === undefined) {
      throw new Error('proposal draft generation upsert returned no row');
    }
    return { row, created: row.id === mintedId };
  },

  /**
   * The relationship's live generation, if any. Rides the live-row unique index.
   *
   * ⚠ RELATIONSHIP-SCOPED ONLY — it checks no requester and no expert. Safe ONLY after the
   * caller has resolved the viewer's authority over `relationshipId` through
   * `resolveProposalAuthorAccess`; never feed it a relationship id taken from client input.
   */
  async findLiveByRelationship(
    relationshipId: string
  ): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .select()
      .from(proposalDraftGenerations)
      .where(
        and(
          eq(proposalDraftGenerations.relationshipId, relationshipId),
          isNull(proposalDraftGenerations.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠ THE WEB POLL'S READ. All three of id, relationship and requester are in the WHERE — never
   * soften this to a lookup-then-compare, which leaks existence through every future refactor
   * that forgets the comparison.
   */
  async findForRequester(
    input: FindProposalDraftGenerationForRequesterInput
  ): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .select()
      .from(proposalDraftGenerations)
      .where(
        and(
          eq(proposalDraftGenerations.id, input.generationId),
          eq(proposalDraftGenerations.relationshipId, input.relationshipId),
          eq(proposalDraftGenerations.requestedByUserId, input.requestedByUserId),
          isNull(proposalDraftGenerations.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠ THE API ENQUEUE ROUTE'S READ — one join, three conditions on the bearer's user: they
   * requested the generation, the generation's relationship is live, and that relationship's
   * expert profile belongs to them. (`expert_profiles` has no `deleted_at`.) A generation whose
   * requester is no longer the relationship's expert is a not-found.
   */
  async findForRelationshipExpert(
    input: FindProposalDraftGenerationForRelationshipExpertInput
  ): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .select(getTableColumns(proposalDraftGenerations))
      .from(proposalDraftGenerations)
      .innerJoin(
        requestExpertRelationships,
        eq(requestExpertRelationships.id, proposalDraftGenerations.relationshipId)
      )
      .innerJoin(expertProfiles, eq(expertProfiles.id, requestExpertRelationships.expertProfileId))
      .where(
        and(
          eq(proposalDraftGenerations.id, input.generationId),
          eq(proposalDraftGenerations.requestedByUserId, input.userId),
          isNull(proposalDraftGenerations.deletedAt),
          isNull(requestExpertRelationships.deletedAt),
          eq(expertProfiles.userId, input.userId)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠ THE WORKER'S READ, AND THE ONLY UNSCOPED ONE. Do not call it from a request path; use
   * `findForRequester` or `findForRelationshipExpert` there.
   */
  async findById(generationId: string): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .select()
      .from(proposalDraftGenerations)
      .where(
        and(
          eq(proposalDraftGenerations.id, generationId),
          isNull(proposalDraftGenerations.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * Terminal success. CAS on `pending` — see {@link pendingPredicate} — AND on the row being
   * younger than `DRAFT_DEADLINE_MS` by the database clock. Returns the updated row only when
   * this call won; `undefined` means the row was already terminal, soft-deleted, absent or past
   * the deadline, and the caller must not fire analytics.
   *
   * ⚠ THE DEADLINE IS IN THE WHERE, NOT ONLY IN THE WORKER. A read derives `failed` for a
   * `pending` row past the deadline, so storing a success after that moment would show the
   * expert a draft once they had already been told it failed. The worker's own deadline checks
   * still run first; they save the paid model call, this one keeps the stored outcome honest.
   * The worker re-reads the row and fails a still-pending one as `deadline_exceeded`; until that
   * write lands, every read already derives the row as failed.
   *
   * ⚠ `status`, `output` and `completed_at` are set in ONE `.set()`: the table's three
   * biconditional CHECKs reject any of them alone.
   */
  async markSucceeded(
    input: MarkProposalDraftGenerationSucceededInput
  ): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .update(proposalDraftGenerations)
      .set({
        status: 'succeeded',
        output: input.output,
        completedAt: new Date(),
        modelId: input.modelId,
        promptVersion: input.promptVersion,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      })
      .where(
        and(
          pendingPredicate(input.generationId),
          sql`${proposalDraftGenerations.createdAt} > now() - make_interval(secs => ${DRAFT_DEADLINE_SECONDS}::int)`
        )
      )
      .returning();
    return row;
  },

  /**
   * Terminal failure. Same CAS and the same `undefined`-means-already-terminal contract, so a
   * failure that races a success loses rather than overwriting an output the expert may already
   * be looking at.
   */
  async markFailed(
    input: MarkProposalDraftGenerationFailedInput
  ): Promise<ProposalDraftGeneration | undefined> {
    const [row] = await db
      .update(proposalDraftGenerations)
      .set({
        status: 'failed',
        failureReason: input.failureReason,
        completedAt: new Date(),
      })
      .where(pendingPredicate(input.generationId))
      .returning();
    return row;
  },

  /**
   * The web's answer to an `enqueue_failed`: fail the pending row AND soft-delete it, in ONE
   * statement under the same CAS as `mark*`. The caller reports the failure for this visit
   * itself (every scoped read misses the released row from here on), and because a soft-deleted
   * row frees `proposal_draft_generations_relationship_live_idx`, the next
   * `createOrGetForRelationship` opens a fresh row. A brief api outage therefore does not use
   * up the relationship's one draft.
   *
   * Returns the row only when this call won; `undefined` means the worker already finished it
   * (or it was already released), and the caller must not fire analytics.
   *
   * ⚠ RELEASED ROWS STILL COUNT TOWARDS `countCreatedSince`, so a retry loop during an outage
   * stays inside `MAX_PROPOSAL_DRAFTS_PER_HOUR`.
   */
  async releaseAfterEnqueueFailure(
    input: ReleaseProposalDraftGenerationInput
  ): Promise<ProposalDraftGeneration | undefined> {
    const now = new Date();
    const [row] = await db
      .update(proposalDraftGenerations)
      .set({
        status: 'failed',
        failureReason: 'enqueue_failed' satisfies ProposalDraftFailureReason,
        completedAt: now,
        deletedAt: now,
      })
      .where(pendingPredicate(input.generationId))
      .returning();
    return row;
  },

  /**
   * The web-side counter behind `MAX_PROPOSAL_DRAFTS_PER_HOUR`: generations this user opened at
   * or after `since`, whatever their outcome. ⚠ DELIBERATELY INCLUDES SOFT-DELETED ROWS: a row
   * released by `releaseAfterEnqueueFailure` still bounds how often an expert can retry while
   * the api is down. `apps/web` has no Redis, so the web's rolling window is a DB count; the
   * api's Redis limit is the second, independent bound. Rides
   * `proposal_draft_generations_requester_idx`, which is not partial.
   */
  async countCreatedSince(input: CountProposalDraftGenerationsInput): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(proposalDraftGenerations)
      .where(
        and(
          eq(proposalDraftGenerations.requestedByUserId, input.requestedByUserId),
          gte(proposalDraftGenerations.createdAt, input.since)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * Whether the relationship's live generation succeeded — the submit-time `ai_draft_generated`
   * lookup. It cannot tell whether the expert kept, cleared or discarded the draft; analytics
   * subtract `PROPOSAL_DRAFT_CLEARED` and `PROPOSAL_DRAFT_DISCARDED` for that.
   */
  async hasSucceededForRelationship(relationshipId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: proposalDraftGenerations.id })
      .from(proposalDraftGenerations)
      .where(
        and(
          eq(proposalDraftGenerations.relationshipId, relationshipId),
          eq(proposalDraftGenerations.status, 'succeeded'),
          isNull(proposalDraftGenerations.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },
};
