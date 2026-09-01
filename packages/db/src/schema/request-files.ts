import {
  pgTable,
  uuid,
  text,
  integer,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { requestFileSideEnum, requestFileAudienceEnum } from './enums';
import { projectRequests } from './project-requests';
import { requestExpertRelationships } from './request-origination';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * request_shared_files (BAL-431 / ADR-1048) — THE FIFTH FILE SCOPE: a file shared during
 * request origination, anchored on `project_requests.id`, carrying an AUDIENCE OF TRACKS.
 *
 * ── WHY A FIFTH TABLE AND NOT A COLUMN ON `conversation_files` ────────────────────────
 * BAL-424 / ADR-1045 (migration 0062) re-anchored `conversation_files` from
 * `request_expert_relationships.id` onto `conversations.id`, and a conversation reaches its
 * subject only through the polymorphic, FK-less, RLS-less `conversation_contexts` seam.
 * A REQUEST-GRAIN FILE HAS NO SINGLE `conversation_id` — an `invited` expert has no open
 * thread at all (`isThreadOpenStatus` excludes `invited`, deliberately and by a pinning
 * test), yet must inherit every prior share-to-all the moment their track exists.
 * Nullable-ing `conversation_files.conversation_id` would break the type at 6 `listFiles`
 * call sites, at the Ably wire payload, and — the decisive objection — would put AUDIENCE
 * COLUMNS on rows that the engagement, case and meeting surfaces read, turning ADR-1048 §3's
 * concealment from a TABLE FACT into a per-row conditional in a shared serializer.
 * ADR-1048's "extend rather than parallel table" line predates that schema. Four file scopes
 * already ship (`project_request_documents`, `proposal_documents`, `conversation_files`,
 * `meeting_files`); a fifth is the convention, not a deviation. Note also that a
 * request-grain file table ALREADY exists — `project_request_documents` is the BRIEF's
 * attachments (no uploader side, no audience) and is deliberately not extended here, because
 * conflating "the brief" with "files shared during origination" would give one row two
 * visibility rules.
 *
 * ── `side` AND `expert_relationship_id` COME FROM THE GATE. NEVER FROM A REQUEST BODY ──
 * The `meeting_files.party` rule (`schema/meeting-files.ts:37-44`) verbatim: the confirm
 * action writes `side: scope.side` and `expertRelationshipId: scope.viewer.relationshipId`,
 * and ITS ZOD INPUT SCHEMA HAS NO KEY FOR EITHER, so there is no path from a request body to
 * these columns. That is the load-bearing anti-cross-party control: a client-side member
 * cannot mint an expert-side file, and an expert cannot mint one on a sibling's track.
 * ⚠ IF YOU EVER FIND YOURSELF READING `side` OFF A REQUEST BODY, THE GATE HAS BEEN BYPASSED.
 *
 * ── RETENTION: SOFT-DELETE + A PREFIX-GUARDED R2 OBJECT DELETE (RULING 1) ─────────────
 * `meeting-files.ts:22-31` sets the platform rule "so the next file scope inherits a decision
 * rather than re-deriving one". THIS IS THAT NEXT SCOPE, and Ruling 1 (2026-08-31) resolves
 * the conflict with ADR-1048 §4's "R2 object retained" IN FAVOUR OF THE HOUSE RULE: tombstone
 * + best-effort prefix-guarded object delete, performed by the CALLER after commit (a
 * repository must not reach R2). ⚠ CONSEQUENCE, AND IT IS LOAD-BEARING: with the bytes gone,
 * "who had access to what, when" is answered from `audit_events` + this tombstone and NEVER
 * from the object — which is why the delete audit event MUST snapshot the RESOLVED AUDIENCE
 * at delete time (see `repositories/_shared/request-file-audit.ts`).
 *
 * ── `r2_key` UNIQUE IS NON-PARTIAL — THE SETTLED EXCEPTION ────────────────────────────
 * No `.where()`, against the usual soft-delete partial-unique rule (memory
 * `reference_softdelete_nonpartial_unique_recreate`). A fresh R2 key per upload is never
 * reused, so it is not the "reusable tuple" that rule targets; and making it PARTIAL would be
 * actively WRONG — a soft-deleted row's key must stay RESERVED, because the object delete is
 * best-effort and can fail. Same ruling as `meeting_file_key_idx`, `conversation_file_key_idx`,
 * `proposal_document_key_idx`, `project_request_document_key_idx`. The integration test
 * asserts the re-insert failure as a DELIBERATE PROPERTY, not a bug.
 *
 * NO RLS — matching `conversations`, `conversation_files`, `meetings`, `meeting_files`,
 * `credit_sessions` and `transcripts`: Balo auths with WorkOS + iron-session, `auth.uid()` is
 * meaningless, and the boundary is the application layer (ADR-1029). A knowing deviation from
 * the `drizzle-schema` skill's RLS checklist item, recorded here so a reviewer sees the reason
 * rather than the omission.
 */
export const requestSharedFiles = pgTable(
  'request_shared_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // THE ANCHOR. CASCADE — a shared file cannot outlive its request.
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),

    // ATTRIBUTION — restrict (ADR-1030; the `conversation_files` / `meeting_files` rule).
    // The uploader must survive their own departure from the company or agency: rights sit
    // on membership and are re-derived at every gate call; this records who shared it.
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // ⚠ FROM THE GATE'S RESOLVED SIDE, NEVER A REQUEST FIELD — see the docblock.
    side: requestFileSideEnum('side').notNull(),

    // ⚠ FROM THE GATE — see the docblock. IMMUTABLE after creation: there is no
    // `updateAudience` path anywhere (narrowing is delete + re-share as grants).
    audience: requestFileAudienceEnum('audience').notNull(),

    /**
     * The OWNING TRACK of an EXPERT upload. NOT NULL for `side='expert'`, NULL for
     * `side='client'` — enforced by `request_shared_file_side_shape` below.
     *
     * CASCADE via the composite FK: a hard-deleted relationship takes its own files with it
     * (there is no other party who could own them).
     */
    expertRelationshipId: uuid('expert_relationship_id'),

    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),

    /**
     * RULING 3 — who removed it. Delete rights are PARTY-LEVEL (whoever may upload to a side
     * may delete that side's files), so the deleter is frequently NOT the uploader; BOTH are
     * recorded, here and in the audit event. RESTRICT: attribution survives.
     */
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // NON-PARTIAL unique — the settled exception; rationale on the docblock.
    uniqueIndex('request_shared_file_key_idx').on(t.r2Key),

    /**
     * COMPOSITE-FK TARGET (a unique CONSTRAINT, not just an index) so `request_file_grants`
     * can pin its denormalised `project_request_id` to THIS file's request at the DB level.
     * `id` is already unique, so this is trivially satisfied. Same device as
     * `request_expert_relationship_id_request_uq` (`request-origination.ts:112`).
     */
    unique('request_shared_file_id_request_uq').on(t.id, t.projectRequestId),

    /**
     * THE LIST READ (client + expert lens): a request's LIVE files. Ordering is done on
     * `created_at`, so the index is (request, created_at) and the planner can range-scan.
     * Predicates on a COLUMN only, never an enum literal (house rule) — which is why neither
     * `side` nor `audience` appears in any predicate here.
     */
    index('request_shared_file_request_idx')
      .on(t.projectRequestId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * ⚠⚠ NON-PARTIAL, AND IT MUST BE, FOR TWO INDEPENDENT REASONS.
     *  1. THE ADMIN LENS READS TOMBSTONES (design ref `request-file-audience.jsx:814-818`),
     *     so it does not carry `deleted_at IS NULL` and the partial index above cannot serve
     *     it.
     *  2. THE CASCADE. `project_request_id` REFERENCES `project_requests(id) ON DELETE
     *     CASCADE`, and Postgres executes that cascade with an unqualified
     *     `DELETE FROM request_shared_files WHERE project_request_id = $1` — it does NOT add
     *     `deleted_at IS NULL`. With only the partial index the cascade seq-scans.
     * Exactly the `conversation_context_conversation_fk_idx` ruling
     * (`conversations.ts:164-177`).
     */
    index('request_shared_file_request_all_idx').on(t.projectRequestId),

    // The RESTRICT FKs' delete-time scans. Indexed on the `meeting_guests` reasoning: a
    // RESTRICT FK whose scan can actually run needs an index, and
    // `admin-dev/_actions/delete-user.ts` proves users really are hard-deleted.
    index('request_shared_file_uploaded_by_idx').on(t.uploadedByUserId),
    index('request_shared_file_deleted_by_idx').on(t.deletedByUserId),

    // The expert-track composite FK's cascade scan + the own-track read. NON-PARTIAL for the
    // same cascade reason as above (the leading column also serves the composite).
    index('request_shared_file_relationship_idx').on(t.expertRelationshipId),

    /**
     * COMPOSITE BACKSTOP FK — an expert file's track MUST belong to the SAME request. The
     * repository derives `expertRelationshipId` from the gate; this rejects any divergent row
     * from a raw write. Same device as `eoi_rel_request_match_fk`
     * (`request-origination.ts:162-166`).
     *
     * ⚠ MIGRATION STATEMENT ORDER — drizzle-kit emits the referenced table's UNIQUE
     * constraint AFTER the composite FK, which fails 42830 in EVERY environment (memory
     * `reference_drizzle_composite_fk_statement_order`). Here the referenced unique —
     * `request_expert_relationship_id_request_uq` — ALREADY EXISTS from an earlier migration,
     * so THIS arm is safe. The grant table's file arm is NOT; see 0079's hand-reorder.
     */
    foreignKey({
      columns: [t.expertRelationshipId, t.projectRequestId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.projectRequestId],
      name: 'request_shared_file_rel_request_match_fk',
    }).onDelete('cascade'),

    /**
     * THE STRUCTURAL EXPRESSION OF ADR-1048 §1, IN ONE CONSTRAINT.
     *   expert ⇔ audience='own_track' ⇔ a named track;
     *   client ⇔ audience ∈ {all_live_tracks, grants} ⇔ no named track.
     * "Expert uploads are hard-fixed to their own track; no picker exists expert-side,
     * structurally" is enforced by the DATABASE, not by a serializer convention.
     *
     * THREE-VALUED-LOGIC SAFE: `side` and `audience` are NOT NULL and compared to literals,
     * so this can never "pass by being unknown" (the `meeting_file_party_two_sided` note,
     * `meeting-files.ts:123-125`).
     *
     * Naming enum literals in a CHECK created in the SAME migration as the enum is SAFE —
     * both types are standalone `CREATE TYPE`s, and the one-transaction hazard applies ONLY
     * to `ALTER TYPE … ADD VALUE` (`enums.ts` transcript block).
     */
    check(
      'request_shared_file_side_shape',
      sql`(${t.side} = 'expert'
             AND ${t.audience} = 'own_track'
             AND ${t.expertRelationshipId} IS NOT NULL)
          OR
          (${t.side} = 'client'
             AND ${t.audience} IN ('all_live_tracks','grants')
             AND ${t.expertRelationshipId} IS NULL)`
    ),

    /**
     * Tombstone coherence: the deleter is recorded exactly when the row is deleted. Fails
     * closed against a half-written tombstone — with the bytes gone, an unattributed
     * tombstone would make Ruling 1's audit question unanswerable.
     */
    check(
      'request_shared_file_delete_attribution',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedByUserId} IS NULL)`
    ),
  ]
);

/**
 * request_file_grants (BAL-431 / ADR-1048 §1) — ONE explicit grant: file → track.
 *
 * ⚠ ONLY EVER WRITTEN FOR `side='client'` FILES WITH `audience='grants'`. An
 * `all_live_tracks` file has NO grant rows by construction — its audience is computed at read
 * time (that is what "dynamic" means), and materialising it would be exactly the SNAPSHOTTED
 * audience ADR-1048 rejected as its option 3.
 *
 * ⚠ REVOKE IS A SOFT DELETE OF ONE ROW, NOT A CHASE OF COPIES (ADR-1048 §4). Presigned
 * download URLs live 300s and are NOT revocable, so revoke and delete are FORWARD-ONLY by
 * construction. That is consistent with the ADR's own rationale ("revocation cannot unsend a
 * downloadable file") and is stated here so it is not rediscovered as a bug.
 *
 * ⚠ GRANTS SURVIVE A TRACK CLOSING, UNCONDITIONALLY. That is not a special case: a NEW grant
 * to a closed track is impossible (the repository rejects it in-transaction and the picker
 * lists live tracks only), so EVERY grant is pre-closure by construction. The invariant test
 * asserts this DIRECTLY rather than relying on ordering — the design reference makes the same
 * choice (`request-file-audience.jsx:204` returns before the decline check at `:205`).
 *
 * NO RLS — same reasoning as `request_shared_files`.
 */
export const requestFileGrants = pgTable(
  'request_file_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    fileId: uuid('file_id')
      .notNull()
      .references(() => requestSharedFiles.id, { onDelete: 'cascade' }),

    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),

    // Denormalised so BOTH composite backstops below can pin to it. Same device as
    // `expressions_of_interest.projectRequestId` (`request-origination.ts:137-139`).
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),

    // ATTRIBUTION — restrict. Who opened this access boundary.
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // RULING 3 — who closed it. NULL until revoked; restrict.
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ONE LIVE GRANT per (file, track). ⚠ PARTIAL on `deleted_at IS NULL` — memory
     * `reference_softdelete_nonpartial_unique_recreate`: soft-delete plus a NON-partial
     * unique makes a RE-GRANT after a revoke silently fail. (This is the opposite call from
     * `r2_key` above, and deliberately so: a (file, track) pair IS a reusable tuple, an R2
     * key is not.) Any `onConflict` arbiter against this index MUST restate the predicate
     * EXACTLY, as an INLINE literal via raw `sql` — a Drizzle `eq()` Param fails 42P10
     * (memory `reference_pg_partial_index_arbiter_param_42p10`).
     */
    uniqueIndex('request_file_grant_unique_idx')
      .on(t.fileId, t.relationshipId)
      .where(sql`${t.deletedAt} IS NULL`),

    // Cascade scans + the two hot reads ("this file's grants", "this track's grants").
    // NON-PARTIAL for the cascade reason documented on `request_shared_file_request_all_idx`.
    index('request_file_grant_file_idx').on(t.fileId),
    index('request_file_grant_relationship_idx').on(t.relationshipId),
    index('request_file_grant_request_idx').on(t.projectRequestId),

    // The RESTRICT FKs' delete-time scans.
    index('request_file_grant_granted_by_idx').on(t.grantedByUserId),
    index('request_file_grant_revoked_by_idx').on(t.revokedByUserId),

    /**
     * ⚠⚠ THE TWO COMPOSITE BACKSTOPS ARE THE CROSS-REQUEST INVARIANT, MADE STRUCTURAL.
     * Together they make "a grant joining request X's file to request Y's track"
     * UNREPRESENTABLE. ADR-1048 §7's cross-track invariant is then enforced by the database,
     * not by a rule someone has to remember.
     *
     * ⚠ MIGRATION 0079 HAND-REORDERS FOR THIS: drizzle-kit emits
     * `ALTER TABLE request_file_grants ADD CONSTRAINT request_file_grant_file_request_match_fk
     * FOREIGN KEY` BEFORE `ALTER TABLE request_shared_files ADD CONSTRAINT
     * request_shared_file_id_request_uq UNIQUE`, which fails 42830 in every environment. The
     * UNIQUE was moved above the FK in the generated SQL; THE SNAPSHOT IS UNTOUCHED (memory
     * `reference_drizzle_composite_fk_statement_order`).
     */
    foreignKey({
      columns: [t.fileId, t.projectRequestId],
      foreignColumns: [requestSharedFiles.id, requestSharedFiles.projectRequestId],
      name: 'request_file_grant_file_request_match_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.relationshipId, t.projectRequestId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.projectRequestId],
      name: 'request_file_grant_rel_request_match_fk',
    }).onDelete('cascade'),

    /** Revoke coherence — the reciprocal of `request_shared_file_delete_attribution`. */
    check(
      'request_file_grant_revoke_attribution',
      sql`(${t.deletedAt} IS NULL) = (${t.revokedByUserId} IS NULL)`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────
//
// ⚠ NEVER use the relational `with:` API to hydrate `uploadedBy` / `expertRelationship` on a
// CLIENT-BOUND read — it hydrates full rows including `users.workosId` / `email` (memory
// `reference_drizzle_with_hydration_leaks_secrets`). The repository uses explicit `select`
// projections throughout; these relations exist for typed joins and ad-hoc tooling.

export const requestSharedFilesRelations = relations(requestSharedFiles, ({ one, many }) => ({
  projectRequest: one(projectRequests, {
    fields: [requestSharedFiles.projectRequestId],
    references: [projectRequests.id],
  }),
  uploadedBy: one(users, {
    fields: [requestSharedFiles.uploadedByUserId],
    references: [users.id],
  }),
  expertRelationship: one(requestExpertRelationships, {
    fields: [requestSharedFiles.expertRelationshipId],
    references: [requestExpertRelationships.id],
  }),
  grants: many(requestFileGrants),
}));

export const requestFileGrantsRelations = relations(requestFileGrants, ({ one }) => ({
  file: one(requestSharedFiles, {
    fields: [requestFileGrants.fileId],
    references: [requestSharedFiles.id],
  }),
  relationship: one(requestExpertRelationships, {
    fields: [requestFileGrants.relationshipId],
    references: [requestExpertRelationships.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type RequestSharedFile = typeof requestSharedFiles.$inferSelect;
export type NewRequestSharedFile = typeof requestSharedFiles.$inferInsert;
export type RequestFileGrant = typeof requestFileGrants.$inferSelect;
export type NewRequestFileGrant = typeof requestFileGrants.$inferInsert;

/** Schema-derived — single source of truth. */
export type RequestFileSide = (typeof requestFileSideEnum.enumValues)[number];
export type RequestFileAudience = (typeof requestFileAudienceEnum.enumValues)[number];
