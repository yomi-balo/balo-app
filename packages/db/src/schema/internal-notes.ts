import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { internalNoteEntityTypeEnum } from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * internal_notes (BAL-541) — the staff-internal notebook: what one Balo staffer wants the next
 * one to know about an entity. Today the only entity is a project request; the table is shaped
 * for more (`schema/enums.ts` → `internal_note_entity_type`).
 *
 * ── STAFF-ONLY BY CONSTRUCTION ────────────────────────────────────────────────────────
 * Every read AND every write gates on the PLATFORM axis (ADR-1035): `manage_internal_notes`
 * to read/write and to delete one's OWN note, `delete_any_internal_note` (super_admin only)
 * to delete somebody else's. NO client or expert DTO carries a field for any of this,
 * anywhere — `RequestDetailView` and `PortfolioRowView` structurally lack the shape, pinned by
 * a leak invariant. There is no party-axis reader to widen, which is exactly why the
 * capability, and not a lens, is the boundary (see the token's docblock).
 *
 * ── POLYMORPHIC: `entity_id` HAS NO FOREIGN KEY, DELIBERATELY ─────────────────────────
 * `entity_type` decides which table `entity_id` points at, and Postgres cannot express that.
 * **THE WRITE PATH IS THE INTEGRITY BOUNDARY:** the create action proves the parent request is
 * live via `projectRequestsRepository.findById` BEFORE inserting, and passes `entityType` as a
 * SERVER-STATED LITERAL — its Zod schema has NO KEY for it, so there is no path from a request
 * body to this column (the `meeting_files.party` / `request_shared_files` rule verbatim). ⚠ IF
 * YOU EVER FIND YOURSELF READING `entityType` OFF A REQUEST BODY, THE BOUNDARY HAS BEEN
 * BYPASSED. Same FK-less, RLS-less seam shape as `meeting_contexts.context_id` and
 * `conversation_contexts` — and the same consequence: a deleted parent leaves orphan notes,
 * which is acceptable because nothing renders a note except a staff read of that parent.
 *
 * ── `body` HAS EXACTLY ONE HOME: THIS COLUMN ──────────────────────────────────────────
 * Never in an audit row (not even a flag — one step stricter than `project_requests.close_note`,
 * whose audit records `hasNote`), never in a notification payload, never in an analytics
 * property, never in a log line, not even its length. A leak therefore has exactly one place to
 * happen and one place to be tested. Length is capped in the ACTION's Zod schema, not here —
 * `@balo/db` carries no `drizzle-zod`.
 *
 * ── SOFT DELETE, NOT HARD ─────────────────────────────────────────────────────────────
 * A deleted note keeps its attribution and its audit trail; `deleted_at` is the marker and
 * `listForEntity` filters it. `author_user_id` is RESTRICT (the attribution house rule,
 * ADR-1030 — the same call `closed_by_user_id` and `created_by_user_id` make).
 *
 * ── NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────────
 * Matching `conversations`, `meeting_files`, `request_shared_files` and `credit_sessions`:
 * WorkOS + iron-session means `auth.uid()` is always null, so a Supabase-shaped policy would be
 * decoration, and the boundary is the application layer (ADR-1029/ADR-1035). Stated here so a
 * reviewer sees the reason rather than the omission.
 *
 * ── NO `relations()` BLOCK ────────────────────────────────────────────────────────────
 * Nothing needs a relational `with:` — a relational hydration of `users` would pull `workosId`
 * and the full PII row (memory `reference_drizzle_with_hydration_leaks_secrets`). `listForEntity`
 * LEFT JOINs `users` explicitly with a three-column projection. The same call BAL-540 made for
 * `closedByUserId`.
 */
export const internalNotes = pgTable(
  'internal_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The SUBJECT of the note. `entity_type` names the table, `entity_id` the row — see the
    // "no foreign key, deliberately" section above before adding one.
    entityType: internalNoteEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    // ⚠⚠ STAFF-ONLY FREE TEXT, AND THIS COLUMN IS ITS ONLY HOME. See the docblock.
    body: text('body').notNull(),

    // WHO wrote it. Preserve attribution → restrict (the dominant `users` reference across
    // this schema: `created_by_user_id`, `invited_by_user_id`, `closed_by_user_id`).
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // THE LIST READ: one entity's live notes, newest first. Predicates on a COLUMN only,
    // never an enum literal (the `action-items.ts` / `meeting-files.ts` house rule) — which
    // is also why `entity_type` appears in the index KEY but in no predicate, keeping a
    // future `ALTER TYPE … ADD VALUE` free of the single-transaction hazard.
    index('internal_notes_entity_idx')
      .on(t.entityType, t.entityId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),

    // The `restrict` FK's delete-time scan (drizzle-schema skill: index every FK column). On
    // the `meeting_files` reasoning: a restrict FK whose scan can actually run needs an index —
    // a hard-delete path existed at `admin-dev/_actions/delete-user.ts` until BAL-549 deleted
    // it, proving users really are hard-deleted.
    index('internal_notes_author_idx').on(t.authorUserId),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type InternalNote = typeof internalNotes.$inferSelect;
export type NewInternalNote = typeof internalNotes.$inferInsert;

/** Which kind of entity a note is about (schema-derived — single source of truth). */
export type InternalNoteEntityType = InternalNote['entityType'];
