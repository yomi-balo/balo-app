import { pgTable, uuid, integer, text, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagementStatusEnum, engagementTypeEnum } from './enums';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { engagementMilestones } from './engagement-milestones';
import { projectEngagements } from './project-engagements';
import { caseEngagements } from './case-engagements';
import { timestamps, softDelete } from './helpers';

/**
 * engagements — the SUPERTYPE (BAL-417 / ADR-1045 §1). Kept in its OWN file (a
 * delivery-domain object, separate from the origination spine) so every engagement
 * product visibly extends it.
 *
 * THE SUPERTYPE/SUBTYPE SPLIT: this table carries ONLY what is true of EVERY
 * engagement product — the parties, the type discriminator, the coarse status, the
 * currency, the fee, activation, timestamps and soft-delete. The concrete shape
 * lives in a 1:1 CHILD table keyed on `engagement_id`:
 *
 *   `engagement_type = 'project'` → `project_engagements` (commercial terms,
 *      origination provenance, the full delivery lifecycle incl. `pending_acceptance`)
 *   `engagement_type = 'case'`    → `case_engagements` (title, sanitised-HTML
 *      description, the client-close resolution lifecycle)
 *   `package` / `retainer`        → declared labels, NO table yet (the visible seam).
 *
 * ⚠ `package` AND `retainer` ARE DECLARED-BUT-UNBUILT, AND THAT IS AN OPEN GAP, NOT A
 * CLOSED ONE. BAL-417 shipped child tables for `project` and `case` only. `retainer`
 * was named out of scope by the ticket; `package` was never named at all and sits in
 * the same unbuilt state. Concretely, TODAY:
 *
 *   · A `package`- or `retainer`-typed row is INSERTABLE as a BARE PARENT. Nothing
 *     forbids it — `project_engagement_type_is_project` / `case_engagement_type_is_case`
 *     only stop the WRONG child attaching, they cannot require that SOME child exists.
 *     (Nothing creates one today: `insertEngagementRowTx` takes the discriminator as a
 *     required parameter and no repository passes either label.)
 *   · `softDeleteEngagementTx` (repositories/_shared/engagement-supertype.ts) handles
 *     `project` and `case` and treats the other two as an EXPLICIT no-op — correct while
 *     they are childless, silently wrong the moment they are not.
 *
 * THE FIRST WRITER OF EITHER TYPE MUST SHIP THREE THINGS TOGETHER, IN ONE PR:
 *   1. the child table (composite FK against `engagement_id_type_uq` + a single-value
 *      `engagement_type` CHECK, exactly like the two existing children),
 *   2. its fold (`toPackageRow`/`toRetainerRow`) and repository, and
 *   3. the matching branch in `softDeleteEngagementTx`.
 *
 * Shipping (1) without (3) does not fail loudly — soft-delete silently skips the child,
 * the orphaned child keeps occupying whatever partial UNIQUE index it carries, and the
 * next attempt to re-materialise for the same source row fails `23505`. That is the
 * documented `reference_softdelete_nonpartial_unique_recreate` failure mode, and it is
 * why the three land together or not at all.
 *
 * THE PAIRING IS STRUCTURAL, NOT CONVENTIONAL. `engagement_id_type_uq` below is the
 * composite-FK target each child pins `(engagement_id, engagement_type)` against, and
 * each child additionally CHECKs its own `engagement_type` to a single value. A
 * wrong-type child, two children of the same type, and one parent carrying both a
 * project child and a case child are all impossible AT THE DATABASE.
 *
 * THE SEAM (unchanged in spirit, relocated): an active engagement — a pricing method,
 * payment terms, and a billing/approval model — must be expressible WITHOUT a
 * proposal or milestones existing, because a future embedded/retainer product writes
 * through the SAME seam. `project_engagements` keeps that property: its
 * `source_proposal_id` / `relationship_id` / `project_request_id` are ALL NULLABLE and
 * ALL `ON DELETE SET NULL`.
 *
 * THE PARTIES (`company_id`, `expert_profile_id`) are the one universal truth across
 * every engagement product ("a buyer org and a delivering expert") — together with
 * `engagement_type` and `status` they are the only NOT NULL non-defaulted columns on
 * this table.
 */
export const engagements = pgTable(
  'engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The supertype discriminator (BAL-417). DELIBERATELY has NO schema-level
     * default: a default of `'project'` would let a case insert that forgets the
     * discriminator silently become a project — the exact class of bug this split
     * exists to prevent. Every writer goes through `insertEngagementRowTx`, which
     * takes it as a required parameter.
     */
    engagementType: engagementTypeEnum('engagement_type').notNull(),

    // ── Parties (always required — every engagement is a client↔expert deal) ──
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),

    /**
     * The COARSE, type-agnostic lifecycle (3 labels). For a PROJECT it is the lossy
     * projection of `project_engagements.delivery_status`
     * (`projectDeliveryToEngagementStatus`) — `'active'` here does NOT mean the
     * project is mutable; a project in `pending_acceptance` reads `'active'` here.
     */
    status: engagementStatusEnum('status').notNull().default('active'),

    currency: text('currency').notNull().default('aud'),

    /**
     * Balo service margin snapshot (basis points; 2500 = 25%). NULLABLE-FOR-CASES.
     *
     * THE INVARIANT (`engagement_balo_fee_bps_case_null`, a BICONDITIONAL CHECK):
     *
     *     (engagement_type = 'case') = (balo_fee_bps IS NULL)
     *
     * i.e. NULL on EVERY case row and NOT NULL on every project/package/retainer row.
     * This is STRICTLY STRONGER than the plain `NOT NULL` it replaced: it keeps NOT NULL
     * semantics for every non-case type AND forces NULL for a case. See the constraint's
     * own comment below for the three-valued-logic proof.
     *
     * PROJECT snapshots it from the accepted proposal at kickoff and it is IMMUTABLE; a
     * future retainer/package snapshots its own. Marked-up client figures are DERIVED on
     * read (`applyBaloFee`), never stored.
     *
     * THE COLUMN DEFAULT (2500) IS DELIBERATELY KEPT. A project/retainer writer that
     * omits the fee (the seam writer `projectEngagementsRepository.create` types it
     * OPTIONAL for exactly that reason) still gets a valid row; the CASE path writes
     * NULL **explicitly** (`caseEngagementsRepository.create` →
     * `insertEngagementRowTx({ baloFeeBps: null })`). So a case path that FORGETS fails
     * LOUDLY on the CHECK (23514) instead of silently storing a 2500 that was never
     * charged at that rate.
     *
     * ⚠ CASE MARGIN IS NOT HERE — `credit_sessions.balo_fee_bps` IS THE SSOT FOR A
     * CASE'S MARGIN (BAL-417 / D3). That column is the value actually charged: it
     * sizes `client_rate_minor_per_minute` and `expert_rate_minor_per_minute` at
     * `open` (see schema/credit-sessions.ts:95 and repositories/credit-sessions.ts).
     * `credit_sessions` has NO `engagement_id` column and there is NO join between
     * the two tables in either direction. Before the CHECK existed, an
     * `engagement_type = 'case'` row sat at the bare default (2500) — a credible-but-
     * WRONG number that any raw `db.select().from(engagements)` in a reporting query,
     * an admin surface or a reconciliation script would have read straight through
     * `CaseEngagementRow`'s `Omit`, `toCaseRow`'s strip and this docblock. NULL cannot
     * be misread. Do not report, reconcile, invoice, or derive case economics from this
     * column — read `credit_sessions.balo_fee_bps` instead.
     */
    baloFeeBps: integer('balo_fee_bps').default(2500),

    activatedAt: timestamp('activated_at', { withTimezone: true }),

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
    index('engagement_company_idx').on(t.companyId),
    index('engagement_expert_idx').on(t.expertProfileId),
    // ⚠ ON A CASE ROW (`balo_fee_bps IS NULL`) THIS EVALUATES TO NULL, WHICH POSTGRES
    // TREATS AS SATISFIED — AND THAT IS EXACTLY WHAT WE WANT. This is the BENIGN
    // direction of the three-valued-logic quirk: the range only ever has to constrain a
    // value that EXISTS, and `engagement_balo_fee_bps_case_null` below is what decides
    // whether one may exist at all. DO NOT "fix" this into `COALESCE(balo_fee_bps, …)`
    // or `IS NOT DISTINCT FROM` — either would make the CHECK reject NULL and break
    // every case insert. (Contrast `case_engagement_close_coherent`, where a NULL
    // result was the MALIGN direction and had to be closed.)
    check('engagement_balo_fee_bps_range', sql`${t.baloFeeBps} >= 0 AND ${t.baloFeeBps} <= 10000`),
    // NULLABLE-FOR-CASES, enforced as a BICONDITIONAL — see the `baloFeeBps` docblock.
    // Strictly stronger than the `NOT NULL` it replaced: NOT NULL for every non-case
    // type AND NULL for every case.
    //
    // NO THREE-VALUED-LOGIC HOLE (proven, not assumed):
    //   · LHS `engagement_type = 'case'` — `engagement_type` is NOT NULL and `'case'` is
    //     a literal, so `=` yields TRUE or FALSE, NEVER NULL.
    //   · RHS `balo_fee_bps IS NULL` — `IS NULL` is total; it NEVER yields NULL.
    //   · `boolean = boolean` with two non-NULL operands yields TRUE or FALSE.
    // So the constraint can never evaluate to NULL, and therefore never "passes by
    // being unknown" the way `case_engagement_close_coherent` did before its
    // `=` → `IS NOT DISTINCT FROM` fix. The live truth table is asserted in
    // `_shared/engagement-supertype.integration.test.ts`.
    //
    // The `'case'` literal is safe inside a CHECK because `engagement_type` is a
    // standalone `CREATE TYPE` in the SAME migration (0055) — the one-transaction
    // hazard applies only to `ALTER TYPE … ADD VALUE`. A future migration that APPENDS
    // a label must not rewrite this CHECK to mention the new label in that same
    // migration.
    check(
      'engagement_balo_fee_bps_case_null',
      sql`(${t.engagementType} = 'case') = (${t.baloFeeBps} IS NULL)`
    ),
    // The composite-FK TARGET that makes the supertype/subtype pairing STRUCTURAL.
    // `id` is already the PK so this constraint is trivially satisfied; it exists only
    // so each child table can FK `(engagement_id, engagement_type)` and thereby be
    // unable to attach to a parent of the wrong type. A UNIQUE CONSTRAINT (not a
    // uniqueIndex) because Postgres composite FKs require a constraint. Precedent:
    // `request_expert_relationship_id_request_uq` (request-origination.ts).
    unique('engagement_id_type_uq').on(t.id, t.engagementType),
    // Serves three readers with one index: the D5 type filters on the two list graphs
    // (leading `engagement_type`), any type-scoped supertype read
    // (`engagement_type, status`), and the case inactivity candidate scan
    // (`engagement_type='case' AND status='active' AND created_at <= cutoff`). The
    // predicate references ONLY deleted_at — NEVER an enum literal (that would be the
    // ADD-VALUE one-tx migration hazard). Filtering on the enum COLUMNS at query time
    // is safe.
    index('engagement_type_status_created_idx')
      .on(t.engagementType, t.status, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementsRelations = relations(engagements, ({ one, many }) => ({
  company: one(companies, {
    fields: [engagements.companyId],
    references: [companies.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [engagements.expertProfileId],
    references: [expertProfiles.id],
  }),
  // The concrete-shape child. Exactly ONE is non-null, and WHICH one is determined by
  // `engagement_type` — enforced at the DB by each child's composite FK against
  // `engagement_id_type_uq` plus a single-value CHECK on the child's own
  // `engagement_type`. A wrong-type child and a double child are both structurally
  // impossible; the repositories' `EngagementTypeMismatchError` is the friendly
  // in-process message, not the enforcement.
  projectEngagement: one(projectEngagements),
  caseEngagement: one(caseEngagements),
  // Milestones FK the SUPERTYPE (`engagement_milestones.engagement_id` → `engagements.id`,
  // NOT NULL, cascade). Milestone WRITES are nevertheless project-only — every writer
  // passes `{ requireType: 'project' }` to `lockActiveEngagement` (a Case is not
  // milestone-shaped and `aggregateMilestoneProgress` must never count Case milestones).
  milestones: many(engagementMilestones),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
