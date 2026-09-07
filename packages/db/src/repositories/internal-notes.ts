import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { internalNotes, users } from '../schema';
import type { InternalNote, InternalNoteEntityType } from '../schema';
import { auditEventsRepository } from './audit-events';

/**
 * One live note, with its author's identity flattened onto it.
 *
 * ⚠ THREE AUTHOR COLUMNS, NEVER A HYDRATED USER ROW. A relational `with:` would pull
 * `workosId` and the full PII row into a staff surface that needs a name
 * (memory `reference_drizzle_with_hydration_leaks_secrets`).
 *
 * `authorFirstName`/`authorLastName` are `null` when the AUTHOR has been soft-deleted — the
 * note survives its author and the caller renders a fallback. They are NOT null merely because
 * a user has no surname; a caller cannot distinguish those cases from these two fields alone
 * and does not need to (both render the same way).
 */
export interface InternalNoteWithAuthor {
  id: string;
  entityType: InternalNoteEntityType;
  entityId: string;
  body: string;
  authorUserId: string;
  authorFirstName: string | null;
  authorLastName: string | null;
  createdAt: Date;
}

/**
 * Outcome of soft-deleting one note. A DISCRIMINATED UNION, not a throw: both failure arms are
 * ordinary product states the action renders as copy.
 *
 * ⚠ `not_found` DELIBERATELY CONFLATES THREE CASES — missing, already soft-deleted, and
 * "belongs to a different entity than the caller was authorized for". A distinct answer for
 * the third would confirm the existence of a note the caller has no business knowing about
 * (the `findInMeeting` IDOR posture verbatim), and "already deleted" answering `not_found`
 * makes a double-click idempotent rather than an error storm.
 */
export type SoftDeleteInternalNoteResult =
  | { outcome: 'deleted'; noteId: string; auditId: string }
  | { outcome: 'not_found' }
  | { outcome: 'forbidden' };

/**
 * internal_notes (BAL-541) — the staff-internal notebook. See `schema/internal-notes.ts` for
 * the table's doctrine; the rules that bind THIS file:
 *
 * ⚠ `entityType`/`entityId` ARE SERVER-STATED FACTS, NEVER REQUEST BODY FIELDS. The column
 * pair is polymorphic and has NO foreign key, so the WRITE PATH is the integrity boundary: the
 * calling action proves the parent request is live BEFORE calling `create`, and passes the
 * entity type as a literal from a Zod schema that has no key for it.
 *
 * ⚠ THE NOTE BODY NEVER LEAVES THE `body` COLUMN. It is absent from every audit row here —
 * not even a `hasBody` flag, one step stricter than `project_requests.close_note` — and this
 * repository writes no notification, no analytics and no log line at all
 * (`invariants/repositories-never-notify.test.ts`).
 *
 * ⚠ THIS REPOSITORY NEVER READS A `platformRole`. `allowAnyAuthor` arrives as an ALREADY
 * RESOLVED capability boolean (`delete_any_internal_note`, super_admin only); the ownership
 * arm is a plain id comparison. Both are data, never a role read (ADR-1029) — the same shape
 * as `close({ actorKind })`.
 */
export const internalNotesRepository = {
  /**
   * One entity's LIVE notes, newest first — the panel's list read. Rides
   * `internal_notes_entity_idx` (`entity_type, entity_id, created_at` WHERE `deleted_at IS
   * NULL`).
   *
   * ⚠ THE AUTHOR JOIN IS A `LEFT JOIN` WITH `users.deleted_at IS NULL` IN THE JOIN CONDITION,
   * NOT IN THE `WHERE`. In the WHERE it would DROP the note whose author was soft-deleted; in
   * the join condition it yields NULL names and the note still lists. Attribution degrades,
   * the note survives — which is the whole point of keeping a handover note.
   */
  async listForEntity(input: {
    entityType: InternalNoteEntityType;
    entityId: string;
  }): Promise<InternalNoteWithAuthor[]> {
    return db
      .select({
        id: internalNotes.id,
        entityType: internalNotes.entityType,
        entityId: internalNotes.entityId,
        body: internalNotes.body,
        authorUserId: internalNotes.authorUserId,
        authorFirstName: users.firstName,
        authorLastName: users.lastName,
        createdAt: internalNotes.createdAt,
      })
      .from(internalNotes)
      .leftJoin(users, and(eq(users.id, internalNotes.authorUserId), isNull(users.deletedAt)))
      .where(
        and(
          eq(internalNotes.entityType, input.entityType),
          eq(internalNotes.entityId, input.entityId),
          isNull(internalNotes.deletedAt)
        )
      )
      .orderBy(desc(internalNotes.createdAt));
  },

  /**
   * Append one note. ONE transaction: the row and its `internal_note.created` audit row commit
   * or roll back together.
   *
   * ⚠ FIXED METADATA CONTRACT. `audit_events` is APPEND-ONLY, so the shape is unrecoverable if
   * wrong; it is asserted key-by-key in `internal-notes.integration.test.ts`.
   *
   * ⚠ THE DOUBLING OF `entityType`/`entityId` IS DELIBERATE AND NEITHER HALF MAY BE "TIDIED
   * AWAY". The audit ROW's own `entity_type`/`entity_id` name the NOTE (`'internal_note'` + the
   * note id — the grain every other audit row on this table uses). The METADATA's
   * `entityType`/`entityId` name the note's SUBJECT, which is what a staff history read
   * actually wants and is NOT recoverable from the note row once it is soft-deleted.
   *
   * ⚠ AND THE BODY IS IN NEITHER. See the file docblock.
   */
  async create(input: {
    entityType: InternalNoteEntityType;
    entityId: string;
    body: string;
    authorUserId: string;
  }): Promise<{ note: InternalNote; auditId: string }> {
    return db.transaction(async (tx) => {
      const [note] = await tx
        .insert(internalNotes)
        .values({
          entityType: input.entityType,
          entityId: input.entityId,
          body: input.body,
          authorUserId: input.authorUserId,
        })
        .returning();

      if (note === undefined) {
        throw new Error('internal_notes insert returned no row');
      }

      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.authorUserId,
          action: 'internal_note.created',
          entityType: 'internal_note',
          entityId: note.id,
          metadata: { entityType: input.entityType, entityId: input.entityId },
        },
        tx
      );

      return { note, auditId: auditRow.id };
    });
  },

  /**
   * Soft-delete one note. ONE transaction: lock the row FOR UPDATE, decide, then write the
   * `deleted_at` marker and its `internal_note.deleted` audit row together.
   *
   * ── THE DELETE RULE (author OR super_admin), WITHOUT A ROLE READ ──────────────────────
   * `note.authorUserId === actorUserId || allowAnyAuthor`. The first arm is an OWNERSHIP
   * comparison — data, not a role read, and permitted under ADR-1029. The second is a boolean
   * the CALLER resolved from `delete_any_internal_note` via `hasPlatformCapability`; this
   * repository must never be handed a role to interpret.
   *
   * ⚠ `forbidden` WRITES NOTHING — no marker, no audit row. A refusal is not an event.
   *
   * ⚠ `expectedEntity` IS A CONTAINMENT TERM, NOT A POST-FILTER RESULT. The caller was
   * authorized against ONE entity; a note id naming a different one resolves to `not_found`,
   * indistinguishably from a stale uuid. It is checked BEFORE the author arm so a wrong-entity
   * probe cannot learn who wrote the note either.
   */
  async softDelete(input: {
    noteId: string;
    actorUserId: string;
    /** ⚠ AN ALREADY-RESOLVED CAPABILITY BOOLEAN (`delete_any_internal_note`), never a role. */
    allowAnyAuthor: boolean;
    expectedEntity: { entityType: InternalNoteEntityType; entityId: string };
  }): Promise<SoftDeleteInternalNoteResult> {
    return db.transaction(async (tx) => {
      const [note] = await tx
        .select({
          id: internalNotes.id,
          entityType: internalNotes.entityType,
          entityId: internalNotes.entityId,
          authorUserId: internalNotes.authorUserId,
        })
        .from(internalNotes)
        .where(and(eq(internalNotes.id, input.noteId), isNull(internalNotes.deletedAt)))
        .for('update');

      if (
        note === undefined ||
        note.entityType !== input.expectedEntity.entityType ||
        note.entityId !== input.expectedEntity.entityId
      ) {
        return { outcome: 'not_found' };
      }

      if (note.authorUserId !== input.actorUserId && !input.allowAnyAuthor) {
        return { outcome: 'forbidden' };
      }

      const [updated] = await tx
        .update(internalNotes)
        .set({ deletedAt: new Date() })
        .where(eq(internalNotes.id, note.id))
        .returning({ id: internalNotes.id });

      if (updated === undefined) {
        throw new Error(`Failed to soft-delete internal note: ${input.noteId}`);
      }

      // Same fixed contract, same deliberate doubling, same absent body as `create` above.
      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'internal_note.deleted',
          entityType: 'internal_note',
          entityId: note.id,
          metadata: { entityType: note.entityType, entityId: note.entityId },
        },
        tx
      );

      return { outcome: 'deleted', noteId: note.id, auditId: auditRow.id };
    });
  },
};
