import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type {
  ProjectBriefFailureReason,
  ProjectBriefParseResult,
  ProjectBriefParseSourceDocument,
} from '@balo/shared/project-requests';
import { db } from '../client';
import { projectBriefParses } from '../schema';
import type { ProjectBriefParse, NewProjectBriefParse } from '../schema';

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * The model/prompt provenance of one parse attempt (ADR-1013 audit parity). Absent on a row
 * that never reached the model — an `enqueue_failed`, or a `too_large` refused before the call.
 */
export interface ProjectBriefParseAudit {
  readonly modelId: string;
  readonly modelVersion: string | null;
  readonly promptId: string;
  readonly promptVersion: string;
}

/**
 * D10 — the per-parse budget is ENFORCED as a byte ceiling and OBSERVED as these two counts.
 * Both nullable because a provider can answer without usage, and a budget you cannot measure
 * is better recorded as "unknown" than as zero.
 */
export interface ProjectBriefParseUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface CreateProjectBriefParseInput {
  readonly companyId: string;
  readonly requestedByUserId: string;
  /**
   * ⚠⚠ ALREADY SESSION-VALIDATED (Ruling A / §12 Gate 1). This repository does NOT and CANNOT
   * check the keys — it has no session. `startProjectBriefParseAction` re-derives
   * `project-documents/{session.companyId}/{session.userId}/` for every key before calling
   * here, and this is the ONLY write path into `source_documents`. A second caller of `create`
   * that skipped that check would defeat the gate that makes the `{ parseId }`-only job
   * payload safe.
   */
  readonly sourceDocuments: readonly ProjectBriefParseSourceDocument[];
}

export interface FindProjectBriefParseForOwnerInput {
  readonly parseId: string;
  readonly companyId: string;
  readonly requestedByUserId: string;
}

export interface FindProjectBriefParseForRequesterInput {
  readonly parseId: string;
  readonly requestedByUserId: string;
}

export interface MarkProjectBriefParseSucceededInput {
  readonly parseId: string;
  readonly result: ProjectBriefParseResult;
  readonly audit: ProjectBriefParseAudit;
  readonly usage: ProjectBriefParseUsage;
}

export interface MarkProjectBriefParseFailedInput {
  readonly parseId: string;
  /**
   * ⚠ A FIXED literal from `PROJECT_BRIEF_FAILURE_REASONS`, never a model or vendor message.
   * ⚠ NEVER `'timed_out'` OR `'not_found'` — those two members of the union are DERIVED at
   * read and have no stored representation (D3).
   */
  readonly failureReason: ProjectBriefFailureReason;
  /** Absent when the failure happened before the model was reached. */
  readonly audit?: ProjectBriefParseAudit;
  /** Absent for the same reason, and also when the provider reported no usage. */
  readonly usage?: ProjectBriefParseUsage;
}

export interface CountProjectBriefParsesInput {
  readonly requestedByUserId: string;
  readonly since: Date;
}

// ── The read-side state ────────────────────────────────────────────────────

/**
 * The read-side state as a DISCRIMINATED UNION. The database stores three NULL facts (D3 — no
 * `status` column, no pgEnum); this is where they become one value nothing above the DB has to
 * re-derive.
 *
 * ⚠ THERE IS NO `timed_out` ARM, DELIBERATELY. That fourth state is a function of `created_at`
 * and `PARSE_DEADLINE_MS` — i.e. of a CLOCK — and this package holds none. The web read layer
 * derives it from the `pending` arm's `row.createdAt`; keeping it out of here is what stops a
 * clock creeping into the data-access layer and makes this function pure.
 */
export type ProjectBriefParseState =
  | { readonly state: 'pending'; readonly row: ProjectBriefParse }
  | {
      readonly state: 'succeeded';
      readonly row: ProjectBriefParse;
      readonly result: ProjectBriefParseResult;
    }
  | { readonly state: 'failed'; readonly row: ProjectBriefParse; readonly failureReason: string };

/**
 * Read a row's three NULL facts as one state. PURE — no clock, no I/O.
 *
 * ⚠ THE ORDER OF THE TESTS IS LOAD-BEARING ONLY AS A BELT. `project_brief_parses_single_outcome`
 * makes "both `result` and `failure_reason`" unrepresentable and
 * `project_brief_parses_completion_carries_an_outcome` makes "completed with neither"
 * unrepresentable, so on any row Postgres will accept these branches are disjoint and total.
 * A row that somehow carried a `result` with no `completed_at` still reads as `succeeded`
 * rather than as a lie about being pending.
 */
export function toProjectBriefParseState(row: ProjectBriefParse): ProjectBriefParseState {
  if (row.result !== null) return { state: 'succeeded', row, result: row.result };
  if (row.failureReason !== null) {
    return { state: 'failed', row, failureReason: row.failureReason };
  }
  return { state: 'pending', row };
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * ⚠⚠ THE CAS PREDICATE, AND IT IS THE WHOLE OF THE "TERMINAL IS TERMINAL" GUARANTEE.
 *
 * BullMQ delivers at LEAST once: a job whose process crashed after `markSucceeded` but before
 * the ack is redelivered and runs the parse again. Without `completed_at IS NULL` in the WHERE,
 * the second run would silently overwrite a result the client may already have written into
 * their draft — or, worse, overwrite a success with a failure. With it, the second write
 * matches zero rows and both `mark*` return `undefined`, which every caller reads as "already
 * terminal, nothing to do".
 *
 * `deleted_at IS NULL` rides along: a soft-deleted parse is not work anybody can complete.
 */
function claimablePredicate(parseId: string): ReturnType<typeof and> {
  return and(
    eq(projectBriefParses.id, parseId),
    isNull(projectBriefParses.deletedAt),
    isNull(projectBriefParses.completedAt)
  );
}

/** The six provenance columns, spread into a `mark*` payload. All NULL when unknown. */
function auditColumns(
  audit: ProjectBriefParseAudit | undefined,
  usage: ProjectBriefParseUsage | undefined
): Partial<NewProjectBriefParse> {
  return {
    modelId: audit?.modelId ?? null,
    modelVersion: audit?.modelVersion ?? null,
    promptId: audit?.promptId ?? null,
    promptVersion: audit?.promptVersion ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

// ── Repository ─────────────────────────────────────────────────────────────

/**
 * `project_brief_parses` (BAL-254) — THE ONLY access path to the AI brief parse's handoff row.
 *
 * ⚠⚠ EVERY READ HERE IS OWNERSHIP-SCOPED EXCEPT `findById`, AND THAT IS THE DESIGN. §12's
 * gates 4 and 5 live in this file:
 *   • {@link projectBriefParsesRepository.findForOwner} — `company_id` AND
 *     `requested_by_user_id` in the WHERE, so a cross-tenant `parseId` is a NOT-FOUND and the
 *     poll action cannot distinguish "not yours" from "does not exist". Never soften this to a
 *     lookup-then-compare: an id-only read that compares afterwards leaks existence through
 *     timing and through every future refactor that forgets the comparison.
 *   • {@link projectBriefParsesRepository.findForRequester} — the API route's INDEPENDENT
 *     identity check. A WorkOS bearer yields a `userId` and no `companyId`, so this is the
 *     whole check available there, and it is deliberately a second one on top of the web
 *     session rather than a substitute for it (D9).
 *   • {@link projectBriefParsesRepository.findById} — the WORKER's read. No session exists in a
 *     BullMQ processor, so there is nothing to scope by; the worker's protection is Gate 3, it
 *     re-asserts every `source_documents` key against `project-documents/{row.companyId}/
 *     {row.requestedByUserId}/` derived from THE ROW. ⚠ Do not call this from a request path.
 *
 * Every read filters `deleted_at IS NULL`.
 */
export const projectBriefParsesRepository = {
  /**
   * Open a parse. The row starts PENDING by construction: `completed_at`, `result` and
   * `failure_reason` all fall to NULL, which the two CHECKs accept and which
   * {@link toProjectBriefParseState} reads as `pending`.
   *
   * ⚠ D12 — REGENERATE CREATES A NEW ROW, it never resets an existing one. A new uuid means a
   * new BullMQ jobId, so the per-parse id is per-WRITE and not per-STATE and cannot dedup
   * against a retained completed job (memory
   * `reference_bullmq_jobid_must_be_per_write_not_per_state`). The previous row stays as
   * historical record.
   */
  async create(input: CreateProjectBriefParseInput): Promise<ProjectBriefParse> {
    const [row] = await db
      .insert(projectBriefParses)
      .values({
        companyId: input.companyId,
        requestedByUserId: input.requestedByUserId,
        // Copied into a mutable array for the jsonb column; the input stays `readonly` so a
        // caller's array cannot be mutated by this package.
        sourceDocuments: [...input.sourceDocuments],
      })
      .returning();
    if (row === undefined) throw new Error('project brief parse insert failed');
    return row;
  },

  /**
   * ⚠⚠ §12 GATE 4 — THE WEB POLL'S READ. BOTH ownership columns are in the WHERE. See the
   * repository docblock; this is the assertion the security review looks for, and
   * `project-brief-parses.integration.test.ts` pins it for a wrong `companyId` AND for a wrong
   * `requestedByUserId`.
   *
   * Rides `project_brief_parses_owner_idx` on the leading `requested_by_user_id` column.
   */
  async findForOwner(
    input: FindProjectBriefParseForOwnerInput
  ): Promise<ProjectBriefParse | undefined> {
    const [row] = await db
      .select()
      .from(projectBriefParses)
      .where(
        and(
          eq(projectBriefParses.id, input.parseId),
          eq(projectBriefParses.companyId, input.companyId),
          eq(projectBriefParses.requestedByUserId, input.requestedByUserId),
          isNull(projectBriefParses.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠ §12 GATE 5 — THE API ENQUEUE ROUTE'S READ. `requireAuth` resolves a `userId` from the
   * WorkOS bearer and nothing else, so identity is the entire check the route can make; that is
   * still strictly more than `requireInternalAuth` could offer, which would let any holder of
   * `INTERNAL_API_SECRET` enqueue any `parseId` (D9).
   */
  async findForRequester(
    input: FindProjectBriefParseForRequesterInput
  ): Promise<ProjectBriefParse | undefined> {
    const [row] = await db
      .select()
      .from(projectBriefParses)
      .where(
        and(
          eq(projectBriefParses.id, input.parseId),
          eq(projectBriefParses.requestedByUserId, input.requestedByUserId),
          isNull(projectBriefParses.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠ THE WORKER'S READ, AND THE ONLY UNSCOPED ONE. A BullMQ processor has no session to scope
   * by. Its protection is Gate 3 — it re-asserts every `source_documents` key against the
   * prefix derived from THIS ROW's `companyId`/`requestedByUserId`. Do not call it from a
   * request path; use `findForOwner` or `findForRequester` there.
   */
  async findById(parseId: string): Promise<ProjectBriefParse | undefined> {
    const [row] = await db
      .select()
      .from(projectBriefParses)
      .where(and(eq(projectBriefParses.id, parseId), isNull(projectBriefParses.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Terminal-success write. ⚠ CAS on `completed_at IS NULL` — see {@link claimablePredicate}.
   * Returns `undefined` when the row was already terminal (or soft-deleted, or absent): a
   * no-op, never an error, because a duplicate BullMQ delivery is an ordinary event.
   *
   * ⚠ `completedAt` IS SET IN THE SAME `.set()` AS THE OUTCOME, and it must stay that way:
   * `project_brief_parses_completion_carries_an_outcome` rejects either half on its own.
   * The `Date` goes through a MAPPED `.set()`, never inside a raw `sql` template (memory
   * `reference_date_in_raw_sql_template_throws`).
   */
  async markSucceeded(
    input: MarkProjectBriefParseSucceededInput
  ): Promise<ProjectBriefParse | undefined> {
    const [row] = await db
      .update(projectBriefParses)
      .set({
        result: input.result,
        completedAt: new Date(),
        ...auditColumns(input.audit, input.usage),
      })
      .where(claimablePredicate(input.parseId))
      .returning();
    return row;
  },

  /**
   * Terminal-failure write. Same CAS, same reasons, same `undefined`-means-already-terminal
   * contract — so a `markFailed` that races a `markSucceeded` loses rather than overwriting a
   * result the client may already be looking at.
   *
   * `audit`/`usage` are optional: an `enqueue_failed` or a `too_large` never reached the model.
   */
  async markFailed(
    input: MarkProjectBriefParseFailedInput
  ): Promise<ProjectBriefParse | undefined> {
    const [row] = await db
      .update(projectBriefParses)
      .set({
        failureReason: input.failureReason,
        completedAt: new Date(),
        ...auditColumns(input.audit, input.usage),
      })
      .where(claimablePredicate(input.parseId))
      .returning();
    return row;
  },

  /**
   * The web-side abuse counter behind `MAX_PARSES_PER_HOUR` — the
   * `auditEventsRepository.countByActorAndActionSince` precedent, and for the same reason:
   * `apps/web` HAS NO REDIS (no `ioredis` dependency, no client), so a rolling-window counter
   * that the web layer can read has to be a DB count. The api-side Redis limit is the second,
   * independent bound; neither replaces the other.
   *
   * Counts LIVE rows only, and counts every attempt regardless of outcome — a user who burns
   * the hour's budget on twelve failures has still spent twelve model calls' worth of intent.
   * Rides `project_brief_parses_owner_idx` (`requested_by_user_id`, `created_at`), whose
   * partial predicate matches this query's `deleted_at IS NULL` term exactly.
   */
  async countCreatedSince(input: CountProjectBriefParsesInput): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(projectBriefParses)
      .where(
        and(
          eq(projectBriefParses.requestedByUserId, input.requestedByUserId),
          gte(projectBriefParses.createdAt, input.since),
          isNull(projectBriefParses.deletedAt)
        )
      );
    return row?.count ?? 0;
  },
};
