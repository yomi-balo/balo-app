import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { meetingFiles, meetings, users } from '../schema';
import type { NewMeetingFile } from '../schema';
import { meetingFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  isTwoSidedParty,
  meetingFilesRepository,
  MEETING_FILE_LIST_LIMIT,
  type AddMeetingFileInput,
} from './meeting-files';

/**
 * BAL-423 — `meeting_files`, the FOURTH file scope.
 *
 * ⚠ SEVERAL TESTS BELOW END ON A REJECTED REPOSITORY CALL AND NOTHING FOLLOWS IT. That is
 * deliberate, and it is the `meeting-guests.integration.test.ts` discipline: the harness
 * holds each test inside ONE outer transaction, so a statement that fails on the
 * module-level `db` ABORTS it and every later statement answers `25P02` instead of the code
 * under assertion. RAW probes go through `expectConstraintViolation`, which runs them on
 * their own SAVEPOINT; REPOSITORY probes cannot (the repository writes through the
 * module-level `db`), so each is the LAST statement of its own `it`.
 */

/** A fresh, never-reused R2 key — the shape `generateMeetingFileKey` mints. */
function freshR2Key(): string {
  return `meeting-files/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
}

async function seedMeetingAndUploader(): Promise<{ meetingId: string; uploaderId: string }> {
  const { meeting } = await meetingFactory();
  const uploader = await userFactory();
  return { meetingId: meeting.id, uploaderId: uploader.id };
}

function addInput(
  meetingId: string,
  uploaderId: string,
  overrides: Partial<AddMeetingFileInput> = {}
): AddMeetingFileInput {
  return {
    meetingId,
    uploadedByUserId: uploaderId,
    party: 'client',
    source: 'chat',
    r2Key: freshR2Key(),
    fileName: 'kickoff-deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 24_576,
    ...overrides,
  };
}

/** A raw row payload — for the probes that must bypass the repository's types entirely. */
function rawFileRow(
  meetingId: string,
  uploaderId: string,
  overrides: Partial<NewMeetingFile> = {}
): NewMeetingFile {
  return {
    meetingId,
    uploadedByUserId: uploaderId,
    party: 'client',
    source: 'chat',
    r2Key: freshR2Key(),
    fileName: 'raw.pdf',
    contentType: 'application/pdf',
    sizeBytes: 100,
    ...overrides,
  };
}

// ── 1. add ───────────────────────────────────────────────────────────────────

describe('meetingFilesRepository.add', () => {
  it('persists one file against its meeting and its uploader', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();

    const row = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { fileName: 'architecture.pdf', sizeBytes: 2048 })
    );

    expect(row).toMatchObject({
      meetingId,
      uploadedByUserId: uploaderId,
      party: 'client',
      source: 'chat',
      fileName: 'architecture.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      deletedAt: null,
    });
    expect(row.id).toEqual(expect.any(String));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  /**
   * ⚠ THE ANTI-CROSS-PARTY CONTROL, AT THE STORAGE LAYER. `party` is whatever the gate
   * resolved as the actor's SIDE — never a request field — so BOTH sides must round-trip
   * exactly as handed in, with no normalisation and no default.
   */
  it('round-trips BOTH sides of `party` verbatim — the gate decides it, this layer stores it', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();

    const clientSide = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { party: 'client' })
    );
    const expertSide = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { party: 'expert' })
    );

    expect(clientSide.party).toBe('client');
    expect(expertSide.party).toBe('expert');
  });

  it('round-trips BOTH `source` labels — one store, two in-call entry points (D0)', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();

    const fromChat = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { source: 'chat' })
    );
    const fromFilesTab = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { source: 'files_tab' })
    );

    expect(fromChat.source).toBe('chat');
    expect(fromFilesTab.source).toBe('files_tab');
  });

  /**
   * The reused three-label `meeting_participant_party` enum is narrowed to two by CHECK
   * rather than by a new two-label type (see the schema docblock). `observer` is a REAL
   * label of the type — the database, not the TypeScript union, is what refuses it.
   */
  it('the CHECK refuses `observer`, a real label of the reused enum', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingFiles).values(rawFileRow(meetingId, uploaderId, { party: 'observer' }))
    );
  });

  it('rejects a duplicate `r2Key` with a RAW 23505 — the bare-insert contract, unisolated', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const collidingKey = freshR2Key();
    await meetingFilesRepository.add(addInput(meetingId, uploaderId, { r2Key: collidingKey }));

    await expect(
      meetingFilesRepository.add(addInput(meetingId, uploaderId, { r2Key: collidingKey }))
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an unknown `meetingId` with 23503 — the anchor FK is real', async () => {
    const { uploaderId } = await seedMeetingAndUploader();

    await expect(
      meetingFilesRepository.add(addInput(randomUUID(), uploaderId))
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an unknown `uploadedByUserId` with 23503', async () => {
    const { meetingId } = await seedMeetingAndUploader();

    await expect(
      meetingFilesRepository.add(addInput(meetingId, randomUUID()))
    ).rejects.toMatchObject({ code: '23503' });
  });
});

// ── 2. The two FK behaviours ─────────────────────────────────────────────────

describe('meeting_files FK behaviour', () => {
  /**
   * ATTRIBUTION IS `restrict` (ADR-1030). The uploader must survive their own departure
   * from the company or agency — rights sit on MEMBERSHIP and are re-derived at every gate
   * call, while this column records who actually shared the file. `delete-user.ts` must
   * therefore sweep or reassign, exactly as it already does for the guest attribution FKs.
   */
  it('`restrict` blocks hard-deleting an uploader who still owns a live file', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    await meetingFilesRepository.add(addInput(meetingId, uploaderId));

    await expectConstraintViolation('23503', (tx) =>
      tx.delete(users).where(eq(users.id, uploaderId))
    );
  });

  /**
   * ⚠ SOFT-DELETING THE MEETING TOUCHES NOTHING HERE. A CASCADE is a HARD-delete behaviour,
   * and D3's whole point is that files OUTLIVE their call: a `deleted_at` stamp on
   * `meetings` is a marker, not a DELETE. Callers that want "no files for a dead meeting"
   * get that from the GATE (`meetingsRepository.findById` filters `deleted_at IS NULL`),
   * never from the storage layer.
   */
  it('soft-deleting the meeting leaves the file row present and LIVE', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId));

    await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, meetingId));

    const [persisted] = await db.select().from(meetingFiles).where(eq(meetingFiles.id, file.id));
    expect(persisted?.deletedAt).toBeNull();
    await expect(meetingFilesRepository.listByMeeting(meetingId)).resolves.toHaveLength(1);
  });

  it('HARD-deleting the meeting cascades the file away — a file cannot outlive its calls ROW', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId));

    await db.delete(meetings).where(eq(meetings.id, meetingId));

    const rows = await db.select().from(meetingFiles).where(eq(meetingFiles.id, file.id));
    expect(rows).toEqual([]);
  });
});

// ── 3. listByMeeting ─────────────────────────────────────────────────────────

describe('meetingFilesRepository.listByMeeting', () => {
  it('returns BOTH sources in one list — D0s acceptance criterion, not an oversight', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    await meetingFilesRepository.add(addInput(meetingId, uploaderId, { source: 'chat' }));
    await meetingFilesRepository.add(addInput(meetingId, uploaderId, { source: 'files_tab' }));

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source).sort()).toEqual(['chat', 'files_tab']);
  });

  it('excludes soft-deleted rows', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const kept = await meetingFilesRepository.add(addInput(meetingId, uploaderId));
    const removed = await meetingFilesRepository.add(addInput(meetingId, uploaderId));
    await meetingFilesRepository.softDelete({ meetingId, fileId: removed.id });

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    expect(rows.map((row) => row.id)).toEqual([kept.id]);
  });

  it('excludes another meetings files — the containment that IS the whole IDOR story', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const other = await meetingFactory();
    const mine = await meetingFilesRepository.add(addInput(meetingId, uploaderId));
    await meetingFilesRepository.add(addInput(other.meeting.id, uploaderId));

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    expect(rows.map((row) => row.id)).toEqual([mine.id]);
  });
});

describe('meetingFilesRepository.listByMeeting — ordering and empties', () => {
  /**
   * ⚠ THE TIMESTAMPS ARE WRITTEN EXPLICITLY. `created_at` defaults to `now()`, which in
   * Postgres is TRANSACTION-START time — and the harness holds the whole test in ONE
   * transaction, so three repository inserts would share one identical timestamp and any
   * ordering assertion over them would be vacuous rather than wrong.
   */
  it('orders oldest-first', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const base = Date.UTC(2026, 7, 11, 9, 0, 0);
    const inserted = await db
      .insert(meetingFiles)
      .values([
        rawFileRow(meetingId, uploaderId, {
          fileName: 'third.pdf',
          createdAt: new Date(base + 2000),
        }),
        rawFileRow(meetingId, uploaderId, {
          fileName: 'first.pdf',
          createdAt: new Date(base),
        }),
        rawFileRow(meetingId, uploaderId, {
          fileName: 'second.pdf',
          createdAt: new Date(base + 1000),
        }),
      ])
      .returning();
    expect(inserted).toHaveLength(3);

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    expect(rows.map((row) => row.fileName)).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
  });

  it('answers [] for a meeting with no files, and for an unknown meeting id', async () => {
    const { meetingId } = await seedMeetingAndUploader();

    await expect(meetingFilesRepository.listByMeeting(meetingId)).resolves.toEqual([]);
    await expect(meetingFilesRepository.listByMeeting(randomUUID())).resolves.toEqual([]);
  });
});

describe('meetingFilesRepository.listByMeeting — the bound', () => {
  /**
   * ⚠ THE CAP IS REAL, AND IT IS ENFORCED IN SQL RATHER THAN BY A CALLER SLICING. Asserted
   * against the constant rather than a literal so raising one without the other cannot pass.
   * Seeded ONE row over the bound, in a single multi-row insert (the harness holds the whole
   * test in one transaction, so this is one statement, not `LIMIT + 1` round trips).
   */
  it('returns at most MEETING_FILE_LIST_LIMIT rows', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const base = Date.UTC(2026, 7, 11, 9, 0, 0);
    await db.insert(meetingFiles).values(
      Array.from({ length: MEETING_FILE_LIST_LIMIT + 1 }, (_unused, index) =>
        rawFileRow(meetingId, uploaderId, {
          fileName: `f${index}.pdf`,
          createdAt: new Date(base + index * 1000),
        })
      )
    );

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    expect(rows).toHaveLength(MEETING_FILE_LIST_LIMIT);
    // Oldest-first, so the row dropped is the NEWEST — which is exactly why the caller warns.
    expect(rows.at(0)?.fileName).toBe('f0.pdf');
    expect(rows.map((r) => r.fileName)).not.toContain(`f${MEETING_FILE_LIST_LIMIT}.pdf`);
  });
});

// ── 3b. findInMeeting ────────────────────────────────────────────────────────

/**
 * The MEETING-SCOPED single-row read (the download path). ⚠ It is NOT a `findById`: the
 * meeting is a term in the WHERE clause, so the containment is identical to
 * `listByMeeting(...).find(...)` while being O(1) — and, unlike that shape, it does not
 * silently depend on the list's cap.
 */
describe('meetingFilesRepository.findInMeeting', () => {
  it('returns the live row for a file OF THAT MEETING', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(
      addInput(meetingId, uploaderId, { fileName: 'brief.pdf' })
    );

    const found = await meetingFilesRepository.findInMeeting({ meetingId, fileId: file.id });

    expect(found?.id).toBe(file.id);
    expect(found?.fileName).toBe('brief.pdf');
    // The r2Key is available to the caller (it presigns with the STORED key).
    expect(found?.r2Key).toBe(file.r2Key);
  });

  /**
   * ⚠ THE CONTAINMENT, AS AN ASSERTION. A file uuid from ANOTHER meeting must answer exactly
   * what a stale uuid answers, so probing teaches nothing about which uuids exist.
   */
  it('returns undefined for a file belonging to ANOTHER meeting', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const other = await meetingFactory();
    const foreign = await meetingFilesRepository.add(addInput(other.meeting.id, uploaderId));

    await expect(
      meetingFilesRepository.findInMeeting({ meetingId, fileId: foreign.id })
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a soft-deleted file, and for an unknown id — the SAME answer', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId));
    await meetingFilesRepository.softDelete({ meetingId, fileId: file.id });

    await expect(
      meetingFilesRepository.findInMeeting({ meetingId, fileId: file.id })
    ).resolves.toBeUndefined();
    await expect(
      meetingFilesRepository.findInMeeting({ meetingId, fileId: randomUUID() })
    ).resolves.toBeUndefined();
  });

  /** ⚠ IT IS NOT BOUND BY `listByMeeting`'s CAP — a file past the cap is still downloadable. */
  it('resolves a row that falls PAST the list bound', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const base = Date.UTC(2026, 7, 11, 9, 0, 0);
    const inserted = await db
      .insert(meetingFiles)
      .values(
        Array.from({ length: MEETING_FILE_LIST_LIMIT + 1 }, (_unused, index) =>
          rawFileRow(meetingId, uploaderId, {
            fileName: `f${index}.pdf`,
            createdAt: new Date(base + index * 1000),
          })
        )
      )
      .returning();
    const newest = inserted.at(-1);
    expect(newest).toBeDefined();

    const listed = await meetingFilesRepository.listByMeeting(meetingId);
    expect(listed.map((r) => r.id)).not.toContain(newest?.id);

    await expect(
      meetingFilesRepository.findInMeeting({ meetingId, fileId: newest?.id ?? randomUUID() })
    ).resolves.toMatchObject({ id: newest?.id });
  });
});

// ── 3c. isTwoSidedParty ──────────────────────────────────────────────────────

/**
 * ⚠ THE PREDICATE THAT LETS A VIEW MODEL SAY "TWO-SIDED" IN THE TYPE. `party` reuses the
 * THREE-label `meeting_participant_party` enum narrowed by CHECK, so `$inferSelect` types it
 * wider than the database can hold. It lives HERE, beside `MeetingFileParty`, because a
 * `'use server'` module may export only async functions — see `list-meeting-files.ts`.
 */
describe('isTwoSidedParty', () => {
  it('accepts exactly the two labels the CHECK permits, and rejects the third', () => {
    expect(isTwoSidedParty('client')).toBe(true);
    expect(isTwoSidedParty('expert')).toBe(true);
    expect(isTwoSidedParty('observer')).toBe(false);
  });

  /** It must agree with the DATABASE, not just with itself. */
  it('rejects precisely the label the CHECK refuses at insert time', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    expect(isTwoSidedParty('observer')).toBe(false);

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingFiles).values(rawFileRow(meetingId, uploaderId, { party: 'observer' }))
    );
  });
});

// ── 4. softDelete ────────────────────────────────────────────────────────────

describe('meetingFilesRepository.softDelete', () => {
  it('stamps `deleted_at` and returns the stamped row', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId));

    const removed = await meetingFilesRepository.softDelete({ meetingId, fileId: file.id });

    expect(removed?.id).toBe(file.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);
    const [persisted] = await db
      .select()
      .from(meetingFiles)
      .where(and(eq(meetingFiles.id, file.id), isNull(meetingFiles.deletedAt)));
    expect(persisted).toBeUndefined();
  });

  /**
   * ⚠ THE SCOPE ARGUMENT IS THE CONTROL, NOT A CONVENIENCE. `softDelete` takes
   * `meetingId` alongside `fileId` for the same reason there is no `findById`: a caller
   * holding a file uuid from ANOTHER meeting must get the SAME answer as one holding a
   * stale uuid, so probing teaches nothing.
   */
  it('returns undefined for a file belonging to ANOTHER meeting, and does not touch it', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const other = await meetingFactory();
    const foreign = await meetingFilesRepository.add(addInput(other.meeting.id, uploaderId));

    const result = await meetingFilesRepository.softDelete({ meetingId, fileId: foreign.id });

    expect(result).toBeUndefined();
    const [persisted] = await db.select().from(meetingFiles).where(eq(meetingFiles.id, foreign.id));
    expect(persisted?.deletedAt).toBeNull();
  });

  it('returns undefined for an unknown file id, and is idempotent on an already-deleted row', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId));
    const first = await meetingFilesRepository.softDelete({ meetingId, fileId: file.id });

    await expect(
      meetingFilesRepository.softDelete({ meetingId, fileId: randomUUID() })
    ).resolves.toBeUndefined();
    await expect(
      meetingFilesRepository.softDelete({ meetingId, fileId: file.id })
    ).resolves.toBeUndefined();
    expect(first?.deletedAt).toBeInstanceOf(Date);
  });

  /**
   * ⚠⚠ A DELIBERATE PROPERTY, ASSERTED SO IT IS NEVER "FIXED". `meeting_file_key_idx` is
   * NON-partial, so a soft-deleted row keeps its `r2_key` RESERVED FOREVER. That is
   * correct: D3 deletes the R2 object best-effort and the delete can fail, so the key may
   * still name a live object. Making the index partial would let a retry mint a row whose
   * key collides with an object nobody can account for.
   */
  it('a soft-deleted rows `r2Key` can NEVER be re-inserted — the non-partial unique, on purpose', async () => {
    const { meetingId, uploaderId } = await seedMeetingAndUploader();
    const key = freshR2Key();
    const file = await meetingFilesRepository.add(addInput(meetingId, uploaderId, { r2Key: key }));
    await meetingFilesRepository.softDelete({ meetingId, fileId: file.id });

    await expect(
      meetingFilesRepository.add(addInput(meetingId, uploaderId, { r2Key: key }))
    ).rejects.toMatchObject({ code: '23505' });
  });
});
