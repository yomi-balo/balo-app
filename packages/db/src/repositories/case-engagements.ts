import { and, asc, eq, gt, isNull, lte, notExists, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  caseEngagements,
  engagements,
  reviews,
  type CaseEngagement,
  type Engagement,
} from '../schema';
import type { RatingNudgeCandidate } from './reviews';
import { partyMembershipsRepository } from './party-memberships';
import { recordDeliveryAudit, recordEngagementCreated } from './_shared/delivery-audit';
import { insertEngagementRowTx, lockEngagementRowTx } from './_shared/engagement-supertype';

/**
 * The CASE engagement repository (BAL-417 / ADR-1045 §1). A Case is the per-minute
 * consultation engagement product: a title, a sanitised-HTML problem description, and
 * a client-close resolution lifecycle.
 *
 * ⚠ BAL-417 ships NO live case producer (D4). Everything here is exercisable only
 * through repository calls and integration tests; the booking surface (BAL-400) and
 * the case surface (BAL-421) are the first real callers.
 */

/** Reason a case was closed (schema-derived; NULL only while open). */
export type CaseCloseReason = NonNullable<CaseEngagement['closeReason']>;

/**
 * The FLAT case-engagement row: the supertype row plus every case-only column.
 * `status` is the 3-value universal union — a Case has NO sub-status.
 *
 * ⚠ `baloFeeBps` is OMITTED DELIBERATELY (D3). `credit_sessions.balo_fee_bps` is the
 * SSOT for a case's margin; `engagements.balo_fee_bps` on a case row sits at its bare
 * default having NEVER been charged. Surfacing it here would let a caller believe it
 * sets or reports case economics — and would put a raw margin into a projection that
 * BAL-421 will hand to a client surface. Making it unreachable is the mitigation.
 *
 * `createdAt` is the PARENT's — the same clock `listOpenCreatedBefore` filters on, so
 * BAL-420 can feed it straight into `isCaseInactive` from `@balo/shared/engagements`.
 */
export type CaseEngagementRow = Omit<Engagement, 'baloFeeBps'> &
  Omit<CaseEngagement, 'engagementId' | 'engagementType' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/**
 * Thrown when `closed_by_user_id` would not be a LIVE member of the case's
 * contracting company (`engagements.company_id`). This is a DATA-INTEGRITY
 * invariant — is the ROW COHERENT — not an authorization gate. The DELIVERING
 * EXPERT holds no membership in the client company, so the invariant is what makes
 * "the expert cannot close" structurally true rather than merely documented.
 *
 * ⚠ NOT a capability check. It resolves no capability token and compares no role.
 * The AUTHORIZATION rule — `hasCapability(actor, CAPABILITIES.PARTICIPATE,
 * { companyId })` — is BAL-421's, in the close server action.
 */
export class CaseCloserNotMemberError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly userId: string
  ) {
    super(`User ${userId} is not a live member of the company contracting case ${engagementId}`);
    this.name = 'CaseCloserNotMemberError';
  }
}

/** Thrown when close is attempted on an already-closed case (idempotency guard). */
export class CaseAlreadyClosedError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly closedAt: Date
  ) {
    super(`Case ${engagementId} was already closed at ${closedAt.toISOString()}`);
    this.name = 'CaseAlreadyClosedError';
  }
}

/**
 * The ONE place a parent + child pair becomes a flat case row. `baloFeeBps` is
 * stripped from the parent here — see `CaseEngagementRow`.
 *
 * EXPORTED FOR THE TEST FACTORY ONLY (`test/factories/case-engagement.factory.ts`).
 * The factory seeds its rows with raw inserts rather than through `create()` (it must
 * be able to force `createdAt`, `deletedAt` and a pre-closed child), so it needs THIS
 * fold. It must never re-implement the strip: a duplicated destructure is a copy that
 * keeps passing after the production one is deleted, which is precisely how a raw
 * margin (`baloFeeBps`) would start reaching a client surface unnoticed. Not in the
 * package barrel — `@balo/db` consumers get `CaseEngagementRow` from the repository
 * methods, never this.
 */
export function toCaseRow(parent: Engagement, child: CaseEngagement): CaseEngagementRow {
  const { baloFeeBps: _baloFeeBps, ...parentRest } = parent;
  const {
    engagementId: _engagementId,
    engagementType: _engagementType,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...childRest
  } = child;
  return { ...parentRest, ...childRest };
}

export const caseEngagementsRepository = {
  /**
   * Create a case: the supertype row (`engagementType: 'case'`) + the child, in ONE
   * transaction. `description` MUST already be sanitised HTML — the WEB caller
   * sanitises, `@balo/db` never does (D8; see the column docblock).
   *
   * A Case is `active` from creation, so `activatedAt` defaults to now exactly as the
   * project path does.
   *
   * NOTE the absent `baloFeeBps` parameter: see `CaseEngagementRow`. This path writes the
   * parent's column as `null` EXPLICITLY — the `engagement_balo_fee_bps_case_null` CHECK
   * requires it, and omitting it would fall through to the column DEFAULT (2500) and be
   * rejected 23514 rather than silently stored.
   *
   * Emits ONE `engagement.created` audit row in the SAME transaction (see
   * `recordEngagementCreated`), so a Case's trail starts at creation and not at close.
   *
   * CONTRACT — bare INSERT. Raw FK violation (23503) on an unknown `companyId` /
   * `expertProfileId`; CHECK (23514) on a blank `title` / `description`.
   */
  async create(input: {
    companyId: string;
    expertProfileId: string;
    title: string;
    description: string;
    currency?: string;
    activatedAt?: Date;
    /**
     * The human who created the case, for the `engagement.created` audit row. OPTIONAL:
     * BAL-417 ships no live producer (D4), so every current caller is a test and there
     * is no actor to name — an omitted/`null` value is the ADR-1030 SYSTEM-ACTOR
     * ATTRIBUTION EXEMPTION (the same shape `createFromExtraction` uses), NOT a
     * fabricated one. BAL-400's booking surface should pass the booking user.
     */
    actorUserId?: string | null;
  }): Promise<CaseEngagementRow> {
    return db.transaction(async (tx) => {
      const parent = await insertEngagementRowTx(tx, {
        engagementType: 'case',
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        currency: input.currency,
        // EXPLICIT NULL — see the `balo_fee_bps` docblock on `engagements`.
        baloFeeBps: null,
        activatedAt: input.activatedAt ?? new Date(),
      });

      const [child] = await tx
        .insert(caseEngagements)
        .values({
          engagementId: parent.id,
          title: input.title,
          description: input.description,
        })
        .returning();

      if (child === undefined) {
        throw new Error('Failed to create case engagement');
      }

      await recordEngagementCreated(tx, {
        engagementId: parent.id,
        engagementType: 'case',
        actorUserId: input.actorUserId ?? null,
      });

      return toCaseRow(parent, child);
    });
  },

  /** Live case by engagement id (parent + child, both `deleted_at IS NULL`). */
  async findByEngagementId(engagementId: string): Promise<CaseEngagementRow | undefined> {
    const [row] = await db
      .select({ parent: engagements, child: caseEngagements })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.engagementType, 'case'),
          isNull(engagements.deletedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .limit(1);

    return row === undefined ? undefined : toCaseRow(row.parent, row.child);
  },

  /**
   * Close a case. Discriminated union, mirroring `acceptCompletion`:
   *   - `{ reason: 'resolved', userId }` — a CLIENT-SIDE user closes. `userId` MUST be
   *     a LIVE member of `engagements.company_id` — the DATA-INTEGRITY invariant on
   *     `closed_by_user_id`. A non-member (including the delivering expert) fails
   *     closed → `CaseCloserNotMemberError`.
   *   - `{ reason: 'auto_inactive' }` — the BAL-420 sweep. Type-CANNOT supply a user;
   *     `closed_by_user_id` stays NULL (ADR-1030 system-actor exemption).
   *
   * ⚠ THIS IS NOT AN AUTHORIZATION GATE. No capability is resolved here and no role
   * is interpreted — the membership read's returned role string is deliberately
   * discarded. `hasCapability(actor, CAPABILITIES.PARTICIPATE, { companyId })` is
   * BAL-421's, in the close server action. This file imports NOTHING from
   * `@balo/shared/authz`; a reviewer can check the ruling still holds by grepping it.
   *
   * ONE transaction, ONE connection: `lockEngagementRowTx(tx, id, 'case')` → lock the
   * child FOR UPDATE → guard `closed_at IS NULL` → assert LIVE membership ON `tx` →
   * write child `{closedAt, closedByUserId, closeReason}` AND parent
   * `status = 'completed'` → `recordDeliveryAudit(tx, …)`.
   *
   * A Case's terminal state is `completed`, never `cancelled`.
   *
   * ⚠ BAL-390 CONTRACT — READ THIS BEFORE WIRING THE FIRST CALLER. This repository
   * CANNOT publish notification events: `@balo/db` depends only on `@balo/shared`,
   * `drizzle-orm` and `postgres`, so no publisher is reachable from here, and this file
   * deliberately imports nothing from the notifications tree. Closing a case IS the
   * terminal anchor for the review ask, so THE FIRST CALLER (BAL-420's sweep /
   * BAL-421's server action) MUST, POST-COMMIT:
   *   1. mint a `review_invite_tokens` row for the resolved client-side reviewer, and
   *   2. publish `engagement.case_closed` carrying the RAW `reviewToken`, when that
   *      reviewer has not already rated the delivering expert.
   * The event, its rule, its email and in-app templates and its Zod publish arm ALL ship
   * in BAL-390 with NO publisher — the caller adds exactly ONE `publishNotificationEvent`
   * line.
   *
   * The NUDGE half needs no caller wiring: `listClosedBetween` below starts matching the
   * moment `closed_at` is first stamped. It is NOT close-reason-blind, though — it reads
   * the `close_reason` written HERE and threads it to the +7d nudge copy, which says
   * "things went quiet … rather than leave it hanging" for `auto_inactive` and a neutral
   * "we closed the case out on {date}" for `resolved`, mirroring `CaseClosedEmail`. So
   * WRITE THE HONEST REASON: passing `auto_inactive` for a client-initiated close would
   * make the nudge assert inactivity about an action the client took themselves.
   */
  async close(
    input: { engagementId: string } & (
      | { reason: 'resolved'; userId: string }
      | { reason: 'auto_inactive' }
    )
  ): Promise<CaseEngagementRow> {
    return db.transaction(async (tx) => {
      // LOCK ORDER: parent → child. Never the reverse.
      const parent = await lockEngagementRowTx(tx, input.engagementId, 'case');

      const [child] = await tx
        .select()
        .from(caseEngagements)
        .where(
          and(
            eq(caseEngagements.engagementId, input.engagementId),
            isNull(caseEngagements.deletedAt)
          )
        )
        .for('update');

      if (child === undefined) {
        throw new Error(`Case engagement child row missing: ${input.engagementId}`);
      }
      if (child.closedAt !== null) {
        throw new CaseAlreadyClosedError(input.engagementId, child.closedAt);
      }

      let closedByUserId: string | null = null;
      if (input.reason === 'resolved') {
        // THE DATA-INTEGRITY INVARIANT: `closed_by_user_id` must be a LIVE member of
        // the contracting company. Read on `tx` — the SAME executor as the locks and
        // the write — so the check and the write are atomic (a second pooled
        // connection would miss this transaction's view and could block it while it
        // holds row locks).
        const role = await partyMembershipsRepository.getMemberRole(
          'company',
          parent.companyId,
          input.userId,
          tx
        );
        if (role === undefined) {
          throw new CaseCloserNotMemberError(input.engagementId, input.userId);
        }
        // ⚠ THE ROLE STRING IS DELIBERATELY DISCARDED. Presence of a LIVE membership is
        // the whole test. Do NOT reintroduce `roleHasCapability(role, …)`,
        // `CAPABILITIES.*`, or any `role ===` comparison here — any of those turns this
        // back into the authorization gate the owner ruled out. Capabilities are
        // resolved at the call site (ADR-1029), and the call site is BAL-421's server
        // action.
        closedByUserId = input.userId;
      }

      const closedAt = new Date();

      const [updatedChild] = await tx
        .update(caseEngagements)
        .set({ closedAt, closedByUserId, closeReason: input.reason })
        .where(eq(caseEngagements.engagementId, input.engagementId))
        .returning();

      if (updatedChild === undefined) {
        throw new Error(`Failed to close case: ${input.engagementId}`);
      }

      const [updatedParent] = await tx
        .update(engagements)
        .set({ status: 'completed' })
        .where(eq(engagements.id, input.engagementId))
        .returning();

      if (updatedParent === undefined) {
        throw new Error(`Failed to close case: ${input.engagementId}`);
      }

      await recordDeliveryAudit(tx, {
        actorUserId: closedByUserId,
        action: 'engagement.case_closed',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { close_reason: input.reason, from: 'active', to: 'completed' },
      });

      return toCaseRow(updatedParent, updatedChild);
    });
  },

  /**
   * OPEN cases created on/before `cutoff`, oldest first — the SQL-EXPRESSIBLE HALF of
   * the 30-day inactivity rule. Rooted on `engagements`
   * (`engagement_type='case' AND status='active' AND deleted_at IS NULL AND
   * created_at <= cutoff`) INNER JOINed to `case_engagements`
   * (`closed_at IS NULL AND deleted_at IS NULL`), `ORDER BY engagements.created_at ASC`.
   * Rides `engagement_type_status_created_idx` + `case_engagement_open_idx`.
   *
   * ⚠ The cutoff is compared against the PARENT's `created_at` — the same value
   * `CaseEngagementRow.createdAt` exposes, so the set this selects and the set BAL-420
   * re-evaluates with `isCaseInactive` cannot diverge on two clocks.
   *
   * ⚠ This is a SUPERSET, not the rule: it is consultation-blind, because no FK links
   * a case to its consultations yet (`credit_sessions` has no `engagement_id`;
   * `consultations` is an availability stub — BAL-418's `meeting_contexts` is the
   * link). BAL-420 refines each row with `isCaseInactive()` from
   * `@balo/shared/engagements`, and MUST NOT run a sweep over this before BAL-418
   * lands. The caller computes `cutoff = now - CASE_INACTIVITY_DAYS` — the repo stays
   * policy-free (mirrors `listPendingAutoAccept(cutoff)`).
   */
  async listOpenCreatedBefore(cutoff: Date): Promise<CaseEngagementRow[]> {
    const rows = await db
      .select({ parent: engagements, child: caseEngagements })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(
        and(
          eq(engagements.engagementType, 'case'),
          eq(engagements.status, 'active'),
          isNull(engagements.deletedAt),
          lte(engagements.createdAt, cutoff),
          isNull(caseEngagements.closedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .orderBy(asc(engagements.createdAt));

    return rows.map((r) => toCaseRow(r.parent, r.child));
  },

  /**
   * BAL-390 — the CASE half of the rating-nudge candidate scan: live cases whose
   * `closed_at` falls in the HALF-OPEN band `(after, until]` and whose delivering expert
   * has not already been rated on that engagement. The exact contract, band semantics and
   * `NOT EXISTS` suppression as `projectEngagementsRepository.listAcceptedBetween` — the
   * two are deliberately shape-identical (both return `RatingNudgeCandidate[]`) so the
   * sweep queries both anchors every tick without branching.
   *
   * ⚠ THIS RETURNS `[]` TODAY, AND THAT IS EXPECTED (D5). `close()` has ZERO production
   * callers, so nothing stamps `closed_at` yet. DO NOT delete this method, its index, or
   * the sweep's call to it on the grounds that "it always returns empty" — it
   * SELF-ACTIVATES with zero code change the moment BAL-420/BAL-421 land, and the sweep's
   * unit test asserts both anchors are queried precisely to stop that deletion.
   *
   * CHILD-ROOTED so it rides `case_engagement_closed_at_idx`; both parent and child
   * `deleted_at` are guarded.
   */
  async listClosedBetween(after: Date, until: Date): Promise<RatingNudgeCandidate[]> {
    const rows = await db
      .select({
        engagementId: engagements.id,
        companyId: engagements.companyId,
        expertProfileId: engagements.expertProfileId,
        anchorAt: caseEngagements.closedAt,
        title: caseEngagements.title,
        // BAL-390 — carried so the +7d nudge can distinguish a deliberate `resolved`
        // close from an `auto_inactive` one instead of asserting "things went quiet"
        // over both. NULL only on a row that predates the CHECK, hence the ?? below.
        closeReason: caseEngagements.closeReason,
      })
      .from(caseEngagements)
      .innerJoin(engagements, eq(engagements.id, caseEngagements.engagementId))
      .where(
        and(
          gt(caseEngagements.closedAt, after),
          lte(caseEngagements.closedAt, until),
          isNull(caseEngagements.deletedAt),
          isNull(engagements.deletedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(reviews)
              .where(
                and(
                  eq(reviews.engagementId, engagements.id),
                  eq(reviews.expertProfileId, engagements.expertProfileId),
                  isNull(reviews.deletedAt)
                )
              )
          )
        )
      )
      .orderBy(asc(caseEngagements.closedAt));

    return rows.flatMap((row) => {
      // `closed_at` is NULLABLE on the column, but the band predicate above cannot match
      // NULL — this guard exists to satisfy the type, never to filter.
      if (row.anchorAt === null) {
        return [];
      }
      return [
        {
          engagementId: row.engagementId,
          engagementKind: 'case' as const,
          companyId: row.companyId,
          expertProfileId: row.expertProfileId,
          anchorAt: row.anchorAt,
          title: row.title,
          // `close_reason` is NOT NULL for any closed row under
          // `case_engagement_close_coherent`, but the COLUMN is nullable, so a NULL
          // degrades to "reason unknown" and the nudge copy falls back to the
          // reason-blind wording rather than guessing.
          closeReason: row.closeReason ?? undefined,
        },
      ];
    });
  },
};
