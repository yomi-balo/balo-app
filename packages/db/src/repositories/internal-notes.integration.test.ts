import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, internalNotes } from '../schema';
import { userFactory, projectRequestFactory } from '../test/factories';
import { internalNotesRepository } from './internal-notes';

/**
 * BAL-541 — `internal_notes`, the staff-internal notebook.
 *
 * Two things this suite exists to hold, beyond the usual happy paths:
 *
 *  1. **The note body never leaves its column.** Every note here is seeded with a distinctive
 *     sentinel string and every audit row is stringified and checked for it. A leak into an
 *     append-only table cannot be undone, so the assertion is on the SERIALISED row rather than
 *     on the keys we happen to expect.
 *  2. **The audit metadata contract, key-by-key.** `audit_events` has no `updated_at` and no
 *     backfill path; if the shape ships wrong it stays wrong. `toEqual` (not `toMatchObject`)
 *     so an extra key fails.
 *
 * ⚠ CONCURRENCY IS NOT EXPRESSIBLE HERE, and no test below pretends otherwise. The harness runs
 * ONE transaction per test on a `max:1` pool, so `softDelete`'s `FOR UPDATE` serialisation is
 * argued by inspection (as `close()` does) — a green run is not evidence of it.
 */

/** A distinctive body, so a leak into an audit row is unmistakable. */
function sentinelBody(): string {
  return `SENTINEL-NOTE-BODY-${randomUUID()}`;
}

/** A live Balo staffer. Authorization happens above this layer — the row just needs an author. */
async function staffUser() {
  return userFactory({ platformRole: 'admin' });
}

async function noteAuditRows(noteId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, noteId),
        inArray(auditEvents.action, ['internal_note.created', 'internal_note.deleted'])
      )
    );
}

/** Re-reads the raw row INCLUDING soft-deleted ones — the repository read cannot see those. */
async function rawNote(noteId: string) {
  const [row] = await db.select().from(internalNotes).where(eq(internalNotes.id, noteId));
  return row;
}

/**
 * Force a distinct `created_at`.
 *
 * ⚠ MANDATORY BEFORE ANY ORDER-SENSITIVE ASSERTION. `created_at` defaults to `now()`, which
 * in Postgres is TRANSACTION START TIME, and the harness holds each test inside ONE
 * transaction — so rows inserted "seconds apart" here share a BYTE-IDENTICAL `created_at` and
 * the canonicity ordering falls through to `id desc`, a random v4 UUID. Without this stamp a
 * "newest wins" assertion is a coin flip that passes about half the time (`calendar-subscriptions
 * .integration.test.ts`'s `stampCreatedAt`).
 */
async function stampCreatedAt(id: string, iso: string): Promise<void> {
  await db
    .update(internalNotes)
    .set({ createdAt: new Date(iso) })
    .where(eq(internalNotes.id, id));
}

describe('internalNotesRepository.create', () => {
  it('inserts the note and exactly one audit row in the same transaction', async () => {
    const author = await staffUser();
    const request = await projectRequestFactory();
    const body = sentinelBody();

    const { note, auditId } = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body,
      authorUserId: author.id,
    });

    expect(note.entityType).toBe('project_request');
    expect(note.entityId).toBe(request.id);
    expect(note.body).toBe(body);
    expect(note.authorUserId).toBe(author.id);
    expect(note.deletedAt).toBeNull();

    const audits = await noteAuditRows(note.id);
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    if (audit === undefined) throw new Error('expected an audit row');
    expect(audit.id).toBe(auditId);
    expect(audit.action).toBe('internal_note.created');
    expect(audit.actorUserId).toBe(author.id);
    // The row's OWN grain names the NOTE…
    expect(audit.entityType).toBe('internal_note');
    expect(audit.entityId).toBe(note.id);
    // …and the metadata names its SUBJECT. Both halves are deliberate — see the repository.
    expect(audit.metadata).toEqual({ entityType: 'project_request', entityId: request.id });
  });

  it('NEVER puts the note body in the audit row, not even a flag', async () => {
    const author = await staffUser();
    const request = await projectRequestFactory();
    const body = sentinelBody();

    const { note } = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body,
      authorUserId: author.id,
    });

    const audits = await noteAuditRows(note.id);
    expect(JSON.stringify(audits)).not.toContain(body);
    // Not even a DERIVED signal — the exact key set, so a later `hasBody` / `bodyLength`
    // "improvement" fails here rather than shipping into an append-only table.
    expect(Object.keys(audits[0]?.metadata ?? {}).sort()).toEqual(['entityId', 'entityType']);
  });
});

describe('internalNotesRepository.listForEntity', () => {
  it('returns one entity’s live notes newest-first, with author names', async () => {
    const author = await userFactory({ platformRole: 'admin', firstName: 'Dana', lastName: 'Ko' });
    const request = await projectRequestFactory();

    const first = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'oldest',
      authorUserId: author.id,
    });
    const second = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'newest',
      authorUserId: author.id,
    });
    await stampCreatedAt(first.note.id, '2026-08-01T00:00:00Z');
    await stampCreatedAt(second.note.id, '2026-08-02T00:00:00Z');

    const notes = await internalNotesRepository.listForEntity({
      entityType: 'project_request',
      entityId: request.id,
    });

    expect(notes.map((n) => n.id)).toEqual([second.note.id, first.note.id]);
    const [newest] = notes;
    if (newest === undefined) throw new Error('expected a note');
    expect(newest.body).toBe('newest');
    expect(newest.authorUserId).toBe(author.id);
    expect(newest.authorFirstName).toBe('Dana');
    expect(newest.authorLastName).toBe('Ko');
    expect(newest.entityType).toBe('project_request');
    expect(newest.entityId).toBe(request.id);
  });

  it('omits soft-deleted notes', async () => {
    const author = await staffUser();
    const request = await projectRequestFactory();

    const kept = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'kept',
      authorUserId: author.id,
    });
    const removed = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'removed',
      authorUserId: author.id,
    });

    await internalNotesRepository.softDelete({
      noteId: removed.note.id,
      actorUserId: author.id,
      allowAnyAuthor: false,
      expectedEntity: { entityType: 'project_request', entityId: request.id },
    });

    const notes = await internalNotesRepository.listForEntity({
      entityType: 'project_request',
      entityId: request.id,
    });

    expect(notes.map((n) => n.id)).toEqual([kept.note.id]);
  });

  it('is entity-scoped — a note on another request never leaks in', async () => {
    const author = await staffUser();
    const mine = await projectRequestFactory();
    const theirs = await projectRequestFactory();

    const ours = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: mine.id,
      body: 'ours',
      authorUserId: author.id,
    });
    await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: theirs.id,
      body: 'theirs',
      authorUserId: author.id,
    });

    const notes = await internalNotesRepository.listForEntity({
      entityType: 'project_request',
      entityId: mine.id,
    });

    expect(notes.map((n) => n.id)).toEqual([ours.note.id]);
  });

  it('still lists a note whose AUTHOR was soft-deleted, with null names', async () => {
    const author = await userFactory({
      platformRole: 'admin',
      firstName: 'Gone',
      lastName: 'Away',
      deletedAt: new Date(),
    });
    const request = await projectRequestFactory();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'the handover still matters',
      authorUserId: author.id,
    });

    const notes = await internalNotesRepository.listForEntity({
      entityType: 'project_request',
      entityId: request.id,
    });

    // Attribution degrades; the note survives. (A WHERE-clause filter would have dropped it.)
    expect(notes.map((n) => n.id)).toEqual([created.note.id]);
    const [note] = notes;
    if (note === undefined) throw new Error('expected a note');
    expect(note.authorUserId).toBe(author.id);
    expect(note.authorFirstName).toBeNull();
    expect(note.authorLastName).toBeNull();
  });

  it('returns an empty array for an entity with no notes', async () => {
    const request = await projectRequestFactory();
    await expect(
      internalNotesRepository.listForEntity({
        entityType: 'project_request',
        entityId: request.id,
      })
    ).resolves.toEqual([]);
  });
});

describe('internalNotesRepository.softDelete', () => {
  it('lets the AUTHOR delete their own note and writes one audit row', async () => {
    const author = await staffUser();
    const request = await projectRequestFactory();
    const body = sentinelBody();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body,
      authorUserId: author.id,
    });

    const result = await internalNotesRepository.softDelete({
      noteId: created.note.id,
      actorUserId: author.id,
      allowAnyAuthor: false,
      expectedEntity: { entityType: 'project_request', entityId: request.id },
    });

    expect(result.outcome).toBe('deleted');
    if (result.outcome !== 'deleted') throw new Error('expected deleted');
    expect(result.noteId).toBe(created.note.id);

    const raw = await rawNote(created.note.id);
    expect(raw?.deletedAt).not.toBeNull();

    const audits = await noteAuditRows(created.note.id);
    const deletedRows = audits.filter((a) => a.action === 'internal_note.deleted');
    expect(deletedRows).toHaveLength(1);
    const [deleted] = deletedRows;
    if (deleted === undefined) throw new Error('expected a delete audit row');
    expect(deleted.id).toBe(result.auditId);
    expect(deleted.actorUserId).toBe(author.id);
    expect(deleted.entityType).toBe('internal_note');
    expect(deleted.entityId).toBe(created.note.id);
    expect(deleted.metadata).toEqual({ entityType: 'project_request', entityId: request.id });
    // The body is absent from the delete row too.
    expect(JSON.stringify(deleted)).not.toContain(body);
  });

  it('is idempotent — a second delete answers not_found', async () => {
    const author = await staffUser();
    const request = await projectRequestFactory();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'once',
      authorUserId: author.id,
    });

    const args = {
      noteId: created.note.id,
      actorUserId: author.id,
      allowAnyAuthor: false,
      expectedEntity: { entityType: 'project_request' as const, entityId: request.id },
    };

    await expect(internalNotesRepository.softDelete(args)).resolves.toMatchObject({
      outcome: 'deleted',
    });
    await expect(internalNotesRepository.softDelete(args)).resolves.toEqual({
      outcome: 'not_found',
    });

    // Still exactly one delete audit row — the second call wrote nothing.
    const audits = await noteAuditRows(created.note.id);
    expect(audits.filter((a) => a.action === 'internal_note.deleted')).toHaveLength(1);
  });

  it('refuses a NON-author without allowAnyAuthor, and leaves the note live', async () => {
    const author = await staffUser();
    const other = await staffUser();
    const request = await projectRequestFactory();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'not yours to remove',
      authorUserId: author.id,
    });

    const result = await internalNotesRepository.softDelete({
      noteId: created.note.id,
      actorUserId: other.id,
      allowAnyAuthor: false,
      expectedEntity: { entityType: 'project_request', entityId: request.id },
    });

    expect(result).toEqual({ outcome: 'forbidden' });

    // A refusal is not an event: the row is untouched and nothing was appended.
    const raw = await rawNote(created.note.id);
    expect(raw?.deletedAt).toBeNull();
    const audits = await noteAuditRows(created.note.id);
    expect(audits.filter((a) => a.action === 'internal_note.deleted')).toHaveLength(0);

    // And it still lists.
    const notes = await internalNotesRepository.listForEntity({
      entityType: 'project_request',
      entityId: request.id,
    });
    expect(notes.map((n) => n.id)).toEqual([created.note.id]);
  });

  it('lets a NON-author delete when allowAnyAuthor is true, attributing it to the actor', async () => {
    const author = await staffUser();
    const superAdmin = await userFactory({ platformRole: 'super_admin' });
    const request = await projectRequestFactory();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: request.id,
      body: 'removed by a super admin',
      authorUserId: author.id,
    });

    const result = await internalNotesRepository.softDelete({
      noteId: created.note.id,
      actorUserId: superAdmin.id,
      allowAnyAuthor: true,
      expectedEntity: { entityType: 'project_request', entityId: request.id },
    });

    expect(result).toMatchObject({ outcome: 'deleted', noteId: created.note.id });

    const raw = await rawNote(created.note.id);
    expect(raw?.deletedAt).not.toBeNull();

    const audits = await noteAuditRows(created.note.id);
    const [deleted] = audits.filter((a) => a.action === 'internal_note.deleted');
    if (deleted === undefined) throw new Error('expected a delete audit row');
    // The ACTOR is recorded, not the author — the note keeps its own attribution.
    expect(deleted.actorUserId).toBe(superAdmin.id);
  });

  /**
   * Containment: the caller was authorized against ONE entity. A note id naming a different
   * one answers `not_found`, indistinguishably from a stale uuid — and it is checked BEFORE
   * the author arm, so a wrong-entity probe learns nothing about who wrote it either.
   */
  it('answers not_found when expectedEntity names a different request, leaving the row untouched', async () => {
    const author = await staffUser();
    const mine = await projectRequestFactory();
    const theirs = await projectRequestFactory();

    const created = await internalNotesRepository.create({
      entityType: 'project_request',
      entityId: mine.id,
      body: 'scoped to mine',
      authorUserId: author.id,
    });

    const result = await internalNotesRepository.softDelete({
      noteId: created.note.id,
      actorUserId: author.id,
      allowAnyAuthor: true,
      expectedEntity: { entityType: 'project_request', entityId: theirs.id },
    });

    expect(result).toEqual({ outcome: 'not_found' });

    const raw = await rawNote(created.note.id);
    expect(raw?.deletedAt).toBeNull();
    const audits = await noteAuditRows(created.note.id);
    expect(audits.filter((a) => a.action === 'internal_note.deleted')).toHaveLength(0);
  });

  it('answers not_found for an unknown note id', async () => {
    const actor = await staffUser();
    const request = await projectRequestFactory();

    await expect(
      internalNotesRepository.softDelete({
        noteId: randomUUID(),
        actorUserId: actor.id,
        allowAnyAuthor: true,
        expectedEntity: { entityType: 'project_request', entityId: request.id },
      })
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});
