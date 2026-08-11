import { pgTable, uuid, text, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingFileSourceEnum, meetingParticipantPartyEnum } from './enums';
import { meetings } from './meetings';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_files (BAL-423) — THE FOURTH FILE SCOPE: files shared DURING one live call,
 * anchored on `meetings.id` (BAL-418's primitive).
 *
 * ── D0: ONE STORE, TWO IN-CALL ENTRY POINTS; A DIFFERENT TABLE BETWEEN CALLS ──────────
 * BOTH in-call entry points write HERE and are told apart by `source`:
 *   · `chat`      — the in-call chat paperclip.
 *   · `files_tab` — the in-call Files tab drop-zone.
 * A file shared BETWEEN calls is a `conversation_files` row — a different table with a
 * different anchor (a between-call attachment belongs to no meeting, so it cannot key to
 * `meetings.id`). **BAL-421 MERGES THE TWO ON READ** in the case surface; neither table is
 * a view of the other and neither is going away. `listByMeeting` therefore does NOT filter
 * `source` — returning both entry points in one list is the acceptance criterion.
 *
 * ── D3: RETENTION IS INDEFINITE. SOFT-DELETE ONLY. ────────────────────────────────────
 * **RETENTION: INDEFINITE. SOFT-DELETE ONLY. This is the platform's stated rule, set here
 * so the next file scope inherits a decision rather than re-deriving one.** There is no
 * TTL, no `expires_at` and no purge sweep — matching every shipped file scope, matching
 * transcripts (BAL-387 has no retention rule at all), and matching the platform-wide fact
 * that nothing hard-deletes soft-deleted rows (`schema/conversations.ts` — the seed
 * truncator is "the only hard-delete path on the platform today"). Deletion is a
 * `deleted_at` marker plus a prefix-guarded R2 object delete on explicit user removal,
 * copying `deleteConversationFileFromR2`. Building purge infrastructure is out of scope and
 * would leave transcripts and recaps inconsistent with it.
 *
 * A consequence, stated so it is not rediscovered as a bug: files OUTLIVE THE CALL. Nothing
 * here consults `meetings.status`, and no writer may start — "can I still upload after the
 * call ended" is a product rule owned by BAL-132/BAL-134, not a schema one.
 *
 * ── `party` IS DERIVED FROM THE GATE'S RESOLVED SIDE. IT IS NEVER A REQUEST FIELD. ─────
 * BAL-408 settled this and it is not re-litigated here. `party` is whatever the
 * participation gate RETURNS as the actor's `side`; the confirm action writes
 * `party: access.side` and its Zod input schema HAS NO `party` KEY, so there is no path
 * from a request body to this column. That single decision is the load-bearing
 * anti-cross-party control: a client-side member cannot mint an expert-side file, and vice
 * versa. ⚠ IF YOU EVER FIND YOURSELF READING `party` OFF A REQUEST BODY, THE GATE HAS BEEN
 * BYPASSED.
 *
 * `party` REUSES `meeting_participant_party` (three labels) narrowed by the CHECK
 * `meeting_file_party_two_sided` to `client | expert` — the `meeting_guests.party` ruling
 * verbatim. A narrow two-label enum would need `ALTER TYPE … ADD VALUE` the first time a
 * Balo staffer (`observer`) uploads, and that migration inherits the one-transaction hazard
 * (memory `reference_enum_default_same_tx_migration_hazard`); RELAXING A CHECK has no such
 * hazard. It also keeps ONE vocabulary across `meeting_presence.party`,
 * `meeting_guests.party` and `meeting_files.party`, which is what lets BAL-388's lens-aware
 * rendering share one type. Naming the two literals in a CHECK in migration 0063 is SAFE:
 * `meeting_participant_party` was created by a standalone `CREATE TYPE` in
 * `0056_bal418_meetings_primitive.sql` and both are ORIGINAL labels.
 *
 * ── `r2_key` UNIQUE IS NON-PARTIAL — THE SETTLED EXCEPTION ────────────────────────────
 * `meeting_file_key_idx` carries NO `.where()`, against the usual soft-delete
 * partial-unique rule (memory `reference_softdelete_nonpartial_unique_recreate`). The
 * rationale is `schema/conversations.ts`'s, copied: a fresh R2 key per upload is never
 * reused (`generateMeetingFileKey` mints a `crypto.randomUUID()` leaf every call), so it is
 * not the "reusable tuple" that rule targets — the same ruling as `proposal_document_key_idx`
 * and `project_request_document_key_idx`. Making it PARTIAL would be actively WRONG here: a
 * soft-deleted row's key must stay RESERVED, because the R2 object may still exist (D3
 * deletes it best-effort, and that delete can fail). The integration test asserts the
 * re-insert failure as a DELIBERATE PROPERTY, not a bug.
 *
 * NO RLS — matching `meetings`, `meeting_contexts`, `meeting_guests`, `conversation_files`,
 * `transcripts` and `credit_sessions`: Balo auths with WorkOS + iron-session, `auth.uid()`
 * is meaningless, and the boundary is the application layer (ADR-1029).
 */
export const meetingFiles = pgTable(
  'meeting_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // BAL-418's anchor. CASCADE — a file cannot outlive its call's row.
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    // ATTRIBUTION — restrict (ADR-1030; the `conversation_files` / `proposal_documents`
    // rule). The uploader must survive their own departure from the company or agency:
    // rights sit on membership and are re-derived at every gate call, while this column
    // records who actually shared the file.
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // ⚠ DERIVED FROM THE GATE'S RESOLVED SIDE. NEVER A REQUEST FIELD (BAL-408's rule) —
    // see the docblock.
    party: meetingParticipantPartyEnum('party').notNull(),

    // Which in-call entry point produced it (D0). Unlike `party` this IS a legitimate
    // caller fact — it says which UI produced the upload and carries no authorization
    // weight whatsoever.
    source: meetingFileSourceEnum('source').notNull(),

    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // NON-PARTIAL unique — the settled exception; the rationale is on the docblock.
    uniqueIndex('meeting_file_key_idx').on(t.r2Key),

    // THE LIST READ: a meeting's live files, oldest first. Predicates on a COLUMN only,
    // never an enum literal (the `action-items.ts` / `transcripts.ts` house rule) — which
    // is also why `source` appears in no index predicate.
    index('meeting_file_meeting_idx')
      .on(t.meetingId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),

    // The `restrict` FK's delete-time scan. Indexed on the `meeting_guests` reasoning: a
    // `restrict` FK whose scan can actually run needs an index, and
    // `admin-dev/_actions/delete-user.ts` proves users really are hard-deleted.
    index('meeting_file_uploaded_by_idx').on(t.uploadedByUserId),

    // Two-sided, by CHECK — see the enum decision on the docblock. THREE-VALUED-LOGIC
    // SAFE: `party` is NOT NULL and is compared to literals, so this can never "pass by
    // being unknown".
    check('meeting_file_party_two_sided', sql`${t.party} IN ('client','expert')`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingFilesRelations = relations(meetingFiles, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingFiles.meetingId], references: [meetings.id] }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingFile = typeof meetingFiles.$inferSelect;
export type NewMeetingFile = typeof meetingFiles.$inferInsert;

/** Which in-call entry point produced the file (schema-derived — single source of truth). */
export type MeetingFileSource = (typeof meetingFileSourceEnum.enumValues)[number];
