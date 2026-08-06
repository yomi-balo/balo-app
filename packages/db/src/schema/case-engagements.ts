import { pgTable, uuid, text, timestamp, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { caseCloseReasonEnum, engagementTypeEnum } from './enums';
import { engagements } from './engagements';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * case_engagements — the CASE subtype of the `engagements` supertype (BAL-417 /
 * ADR-1045 §1). A Case is a per-minute consultation engagement: a title, a
 * sanitised-HTML description of the problem, and a client-close resolution lifecycle.
 *
 * PRIMARY KEY IS `engagement_id`, not a synthetic `id` — the same deliberate
 * supertype/subtype deviation documented on `project_engagements`: the child is a 1:1
 * EXTENSION OF ITS PARENT'S IDENTITY, and a surrogate key would permit two case rows
 * for one engagement.
 *
 * TYPE PAIRING IS STRUCTURAL: `engagement_type` is mirrored here, CHECKed to the
 * single value `'case'`, and `(engagement_id, engagement_type)` composite-FKs
 * `engagements(id, engagement_type)` via `engagement_id_type_uq`.
 *
 * TERMINAL STATE: a closed case sets `engagements.status = 'completed'` plus the
 * `closed_*` columns here. There is NO case-cancel path — a Case's terminal state is
 * `completed`, never `cancelled` (`cancelEngagement` is project-only). If a future
 * ticket needs a distinct "cancelled" terminal for cases, it needs its OWN attribution
 * columns here; it must not reuse `project_engagements.cancelled_*`.
 *
 * ⚠ ENUM-LITERAL CAVEAT (R9): `case_engagement_close_coherent` below references
 * `case_close_reason` ENUM LITERALS. That is safe because `case_close_reason` is a
 * standalone `CREATE TYPE` in the same migration (all labels commit atomically with
 * the type). If a future ticket appends a label via `ALTER TYPE … ADD VALUE`, THIS
 * CHECK MUST NOT BE REWRITTEN TO REFERENCE THE NEW LABEL IN THAT SAME MIGRATION —
 * that is the documented one-transaction ADD-VALUE hazard.
 *
 * ACTOR-FK INDEXING — explicit ruling (BAL-417). The two `ON DELETE restrict` actor
 * FKs below (`closed_by_user_id`, `resolution_requested_by_user_id`) are DELIBERATELY
 * UNINDEXED, matching the inherited status quo on the four project actor FKs. No query
 * in the repo filters or joins on an actor column (they are hydrated by id through a
 * `one` relation, which uses the `users` PK), and `users` rows are never hard-deleted
 * in this application (soft delete via `deleted_at`), so the `restrict` FK's
 * delete-time scan never runs. Adding unused indexes would cost write amplification for
 * zero read benefit. IF A FUTURE TICKET INTRODUCES A HARD USER DELETE, ALL SIX ACTOR
 * FKS (four on `project_engagements`, two here) NEED INDEXES AT THAT POINT.
 */
export const caseEngagements = pgTable(
  'case_engagements',
  {
    /**
     * PK and the parent link in one. Declared WITHOUT an inline `.references()` — the
     * composite FK below carries the reference and the `ON DELETE cascade`.
     */
    engagementId: uuid('engagement_id').primaryKey(),

    /** Mirrored discriminator — pinned to `'case'` by CHECK + composite FK. */
    engagementType: engagementTypeEnum('engagement_type').notNull().default('case'),

    /** Short plain-text case title (no length cap; non-empty enforced by CHECK). */
    title: text('title').notNull(),

    /**
     * Sanitised HTML (ADR-1022 rich text). The WEB CALLER sanitises before persist —
     * `sanitizeProjectHtml` (apps/web/src/lib/sanitize/project-html.ts, `server-only`),
     * exactly as `submit-project-request.ts` does for `project_requests.description`
     * and `milestone-action-shared.ts` does for `engagement_milestones.description_html`.
     * `@balo/db` NEVER sanitises and NEVER validates caller input — the same house
     * contract as `billing_model`/`approval_model` value-space validation.
     *
     * ⚠ BAL-417 ships NO web producer (D4), so nothing calls a sanitiser for this
     * column yet. The FIRST writer (BAL-400 booking / BAL-421 case surface) MUST
     * sanitise. Storing raw client HTML here is a stored-XSS vector.
     */
    description: text('description').notNull(),

    // ── Close / resolution lifecycle ──
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * The CLIENT-SIDE user who closed the case. NULL for the `auto_inactive` sweep
     * path (ADR-1030 system-actor attribution exemption). `restrict` preserves
     * attribution. The repository invariant — this user MUST be a LIVE member of
     * `engagements.company_id` — is enforced in `caseEngagementsRepository.close()`
     * (it spans `company_members`, so it cannot be a CHECK).
     */
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    closeReason: caseCloseReasonEnum('close_reason'),

    /**
     * INERT (BAL-417 / D1) — the expert's "please confirm this is resolved" request.
     * Columns only: NO repository writer, NO server action, NO capability gate, NO
     * notification, NO analytics event, NO audit action. The write path is BAL-421's.
     * The pair is both-NULL-or-both-set (`case_engagement_resolution_request_paired`).
     */
    resolutionRequestedAt: timestamp('resolution_requested_at', { withTimezone: true }),
    resolutionRequestedByUserId: uuid('resolution_requested_by_user_id').references(
      () => users.id,
      { onDelete: 'restrict' }
    ),

    // ⚠ `created_at` HERE IS NEVER READ. The case inactivity clock is the PARENT's
    // `engagements.created_at`: `listOpenCreatedBefore` filters the parent's column and
    // `CaseEngagementRow.createdAt` exposes the parent's, so the set the candidate scan
    // selects and the set `isCaseInactive` re-evaluates cannot diverge on two clocks.
    // This column exists only to satisfy the every-table convention.
    ...timestamps,
    // SOFT DELETE — the PARENT `engagements.deleted_at` is the SSOT; every read
    // filters on it. The two child `deleted_at` columns are MIRRORS, maintained so
    // the partial UNIQUE / partial indexes on the children are correct. THE ONLY
    // SANCTIONED WRITER IS `softDeleteEngagementTx(tx, engagementId)` in
    // repositories/_shared/engagement-supertype.ts — it stamps parent AND child in
    // one transaction under the parent lock. Never `.set({ deletedAt })` an
    // engagement or an engagement child directly: stamping the parent alone leaves
    // the child's `project_request_id` occupying `project_engagement_request_unique_idx`
    // and silently blocks re-materialisation (reference_softdelete_nonpartial_unique_recreate).
    ...softDelete,
  },
  (t) => [
    // The open-case half of the inactivity candidate scan (§1.7b). The
    // `created_at <= cutoff` half is served by the PARENT's
    // `engagement_type_status_created_idx`, because the scan filters the PARENT's
    // `created_at` (§1.6.5). Predicate references two timestamps, no enum literal.
    index('case_engagement_open_idx')
      .on(t.engagementId)
      .where(sql`${t.closedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // BAL-390 — the rating-nudge candidate scan: `closed_at` inside a ONE-HOUR band
    // (`listClosedBetween`). Closing is the CASE's terminal anchor. ⚠ THIS YIELDS AN
    // EMPTY CANDIDATE SET TODAY (D5): `caseEngagementsRepository.close()` has zero
    // production callers, so nothing stamps `closed_at`. The index and its reader ship
    // now so the nudge self-activates with ZERO code change the moment BAL-420/BAL-421
    // land. Predicate references ONLY `deleted_at`, never an enum literal.
    index('case_engagement_closed_at_idx')
      .on(t.closedAt)
      .where(sql`${t.deletedAt} IS NULL`),
    check('case_engagement_type_is_case', sql`${t.engagementType} = 'case'`),
    check('case_engagement_title_nonempty', sql`length(btrim(${t.title})) > 0`),
    check('case_engagement_description_nonempty', sql`length(btrim(${t.description})) > 0`),
    // The structural encoding of "closed_by_user_id is always a client-side user, or
    // NULL for auto_inactive": either fully open, or resolved-by-a-person, or
    // auto-closed-by-the-system. See the ENUM-LITERAL CAVEAT in the file docblock.
    //
    // ⚠ `IS NOT DISTINCT FROM`, NOT `=`. A CHECK that evaluates to NULL is SATISFIED in
    // Postgres. With plain `=`, the shape `closed_at IS NOT NULL AND close_reason IS
    // NULL` made disjunct 1 FALSE and disjuncts 2 and 3 NULL (`NULL = 'resolved'` is
    // NULL), so the whole constraint returned NULL and a CLOSED CASE WITH NO CLOSE
    // REASON was ACCEPTED — the exact hole this check exists to close. `IS NOT DISTINCT
    // FROM` is null-safe and always returns a boolean, so every disjunct is decidable.
    // Never weaken this back to `=`.
    check(
      'case_engagement_close_coherent',
      sql`(${t.closedAt} IS NULL AND ${t.closeReason} IS NULL AND ${t.closedByUserId} IS NULL)
        OR (${t.closedAt} IS NOT NULL AND ${t.closeReason} IS NOT DISTINCT FROM 'resolved' AND ${t.closedByUserId} IS NOT NULL)
        OR (${t.closedAt} IS NOT NULL AND ${t.closeReason} IS NOT DISTINCT FROM 'auto_inactive' AND ${t.closedByUserId} IS NULL)`
    ),
    // D1 both-NULL-or-both-set. Enum-literal-free and therefore hazard-proof.
    check(
      'case_engagement_resolution_request_paired',
      sql`(${t.resolutionRequestedAt} IS NULL) = (${t.resolutionRequestedByUserId} IS NULL)`
    ),
    foreignKey({
      columns: [t.engagementId, t.engagementType],
      foreignColumns: [engagements.id, engagements.engagementType],
      name: 'case_engagement_parent_type_fk',
    }).onDelete('cascade'),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const caseEngagementsRelations = relations(caseEngagements, ({ one }) => ({
  engagement: one(engagements, {
    fields: [caseEngagements.engagementId],
    references: [engagements.id],
  }),
  closedBy: one(users, {
    fields: [caseEngagements.closedByUserId],
    references: [users.id],
  }),
  // INERT (D1) — no writer in BAL-417. Declared so BAL-421's write path inherits a
  // hydration path for "who asked for resolution" without a schema change.
  resolutionRequestedBy: one(users, {
    fields: [caseEngagements.resolutionRequestedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CaseEngagement = typeof caseEngagements.$inferSelect;
export type NewCaseEngagement = typeof caseEngagements.$inferInsert;
