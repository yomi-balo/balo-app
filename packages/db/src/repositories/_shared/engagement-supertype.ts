import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../client';
import {
  caseEngagements,
  engagements,
  projectEngagements,
  type Engagement,
  type ProjectEngagement,
} from '../../schema';

/**
 * The SUPERTYPE seam (BAL-417 / ADR-1045 §1). Every shape shared by the concrete
 * engagement repositories lives here — the parent insert, the parent lock, the
 * status projection, the soft-delete mirror, and the type-mismatch error — so the
 * two sibling child repositories (`project-engagements.ts`, `case-engagements.ts`)
 * never grow parallel copies of it (the same motivation stated in
 * `_shared/engagement-lock.ts`, and what keeps the Sonar new-code duplication gate
 * green).
 *
 * LOCK ORDER (documented once, obeyed everywhere): parent `engagements` row FOR
 * UPDATE → THEN the child row. Never the reverse (deadlock hazard).
 *
 * This module imports ONLY `../../client` and `../../schema`, so
 * `_shared/engagement-lock.ts` can import it without a module cycle.
 */

/** Active transaction handle — declared ONCE here; `engagement-lock.ts` re-exports it. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Engagement product type, derived from the schema column (single source of truth). */
export type EngagementType = Engagement['engagementType'];

/** Supertype lifecycle (3 labels), derived from the schema column. */
export type EngagementStatus = Engagement['status'];

/**
 * PROJECT delivery lifecycle (4 labels), derived from the schema column. Declared
 * HERE rather than in `project-engagements.ts` so `_shared/engagement-lock.ts` can
 * import it without a module cycle. Re-exported from `project-engagements.ts`.
 */
export type ProjectDeliveryStatus = ProjectEngagement['deliveryStatus'];

/**
 * Thrown when a concrete repository is handed an engagement of another type — e.g.
 * `projectEngagementsRepository.requestCompletion` called with a Case's id, or
 * `addMilestone` called on a Case. The friendly in-process message; the DB-level
 * enforcement is the composite FK + single-value CHECK on each child.
 */
export class EngagementTypeMismatchError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly expected: EngagementType,
    public readonly actual: EngagementType
  ) {
    super(`Engagement ${engagementId} is ${actual}, expected ${expected}`);
    this.name = 'EngagementTypeMismatchError';
  }
}

/**
 * The ONE place the project delivery status projects onto the supertype status.
 * The two terminals map 1:1; `pending_acceptance` folds into `active` because the
 * engagement still EXISTS and is not terminal.
 *
 * ⚠ THE PROJECTION IS LOSSY, AND THE LOSS MATTERS. `engagements.status = 'active'`
 * does NOT mean "mutable" for a project — a project awaiting client acceptance is
 * `active` here and MUST refuse milestone/action-item writes. That is why
 * `lockActiveEngagement` re-reads `delivery_status` for `engagement_type='project'`
 * instead of trusting this projection (see _shared/engagement-lock.ts).
 *
 * Every writer that changes `delivery_status` MUST write `engagements.status` from
 * this function in the SAME transaction — that invariant is the only thing keeping
 * the two columns from drifting, and it is asserted by an integration test after
 * every one of the five transitions.
 */
export function projectDeliveryToEngagementStatus(s: ProjectDeliveryStatus): EngagementStatus {
  if (s === 'completed') return 'completed';
  if (s === 'cancelled') return 'cancelled';
  return 'active';
}

/**
 * Insert the SUPERTYPE row. EVERY concrete engagement writer calls this FIRST, inside
 * its own transaction, then inserts its child row against the returned id. Extracted
 * so the parent insert exists exactly once (Sonar new-code duplication) and so
 * `engagement_type` can never be omitted — it is a required parameter with no default.
 *
 * `baloFeeBps` is accepted because PROJECT engagements snapshot it at kickoff. The
 * CASE path never passes it (D3: `credit_sessions.balo_fee_bps` is the case-margin
 * SSOT), and `CaseEngagementRow` omits the column entirely.
 */
export async function insertEngagementRowTx(
  tx: DbTx,
  input: {
    engagementType: EngagementType;
    companyId: string;
    expertProfileId: string;
    /** Defaults to `'active'` at the column. */
    status?: EngagementStatus;
    currency?: string;
    baloFeeBps?: number;
    activatedAt?: Date;
  }
): Promise<Engagement> {
  const [row] = await tx
    .insert(engagements)
    .values({
      engagementType: input.engagementType,
      companyId: input.companyId,
      expertProfileId: input.expertProfileId,
      status: input.status,
      currency: input.currency,
      baloFeeBps: input.baloFeeBps,
      activatedAt: input.activatedAt,
    })
    .returning();

  if (row === undefined) {
    throw new Error('Failed to create engagement');
  }
  return row;
}

/**
 * Lock the LIVE supertype row FOR UPDATE and assert its concrete type. LOCK ORDER
 * (documented once, obeyed everywhere): parent `engagements` row → THEN the child row.
 * Never the reverse (deadlock hazard) — the same order `lockActiveEngagement` uses.
 *
 * This asserts the TYPE only, NOT mutability — `advanceProjectDelivery` and
 * `caseEngagementsRepository.close` each apply their own state guard afterwards.
 * Throws `Error` (missing/soft-deleted) / `EngagementTypeMismatchError` (wrong type).
 */
export async function lockEngagementRowTx(
  tx: DbTx,
  engagementId: string,
  expectedType: EngagementType
): Promise<Engagement> {
  const [row] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
    .for('update');

  if (row === undefined) {
    throw new Error(`Engagement not found: ${engagementId}`);
  }
  if (row.engagementType !== expectedType) {
    throw new EngagementTypeMismatchError(engagementId, expectedType, row.engagementType);
  }
  return row;
}

/**
 * The ONLY sanctioned soft-delete path for an engagement. Stamps the PARENT
 * and its concrete CHILD with the SAME timestamp in ONE transaction, under the parent
 * lock. Never `.set({ deletedAt })` an engagement directly: stamping the parent alone
 * leaves the child's `project_request_id` occupying
 * `project_engagement_request_unique_idx`, which silently blocks re-materialising a
 * project for that request (reference_softdelete_nonpartial_unique_recreate).
 *
 * No production caller exists yet — this ships in BAL-417 precisely so the FIRST
 * caller cannot invent a wrong one. Idempotent: already-deleted rows are untouched.
 */
export async function softDeleteEngagementTx(
  tx: DbTx,
  engagementId: string,
  now?: Date
): Promise<void> {
  const [parent] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
    .for('update');

  // Idempotent: missing or already soft-deleted → nothing to do.
  if (parent === undefined) {
    return;
  }

  // ONE timestamp computed once so parent and child agree exactly.
  const deletedAt = now ?? new Date();

  await tx.update(engagements).set({ deletedAt }).where(eq(engagements.id, engagementId));

  if (parent.engagementType === 'project') {
    await tx
      .update(projectEngagements)
      .set({ deletedAt })
      .where(
        and(eq(projectEngagements.engagementId, engagementId), isNull(projectEngagements.deletedAt))
      );
  } else if (parent.engagementType === 'case') {
    await tx
      .update(caseEngagements)
      .set({ deletedAt })
      .where(
        and(eq(caseEngagements.engagementId, engagementId), isNull(caseEngagements.deletedAt))
      );
  }
}
