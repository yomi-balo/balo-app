import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationFile, MeetingFile } from '@balo/db';

/**
 * BAL-421 §D4 — unit tests for THE FILE MERGE (`meeting_files` ∪ `conversation_files`).
 *
 * ⚠⚠ EVERY FIXTURE ON BOTH SIDES CARRIES A REAL-LOOKING `r2Key`, AND THAT IS THE POINT. It is
 * the exact object locator the presigner signs, `CaseFileRowView` has no field for it, and
 * TypeScript's excess-property checking does NOT apply to spreads — so the day someone
 * "simplifies" the field-by-field build into `{ ...file, origin }`, every type stays green and
 * the browser starts receiving object keys. The leak assertions serialize the WHOLE output and
 * hunt for the secret, so they cannot be satisfied by a type alone.
 *
 * ⚠ `@balo/shared/parties` IS REAL — `personDisplayName` is the actual first-name-only rule
 * under test. Only `@balo/db` is mocked, in the factory-literal style of
 * `_actions/resolve-case.test.ts`.
 */

vi.mock('server-only', () => ({}));

// ⚠ `vi.hoisted` IS REQUIRED, NOT STYLE — a `vi.mock` factory hoists above every top-level
// declaration, so a plain `const` would be in its TDZ when the factory runs.
const { MEETING_FILE_LIST_LIMIT } = vi.hoisted(() => ({ MEETING_FILE_LIST_LIMIT: 200 }));

const mockListByMeeting = vi.fn();
const mockListFiles = vi.fn();
const mockFindNamesByIds = vi.fn();

vi.mock('@balo/db', () => ({
  MEETING_FILE_LIST_LIMIT,
  // The real two-sided narrowing: `meeting_files.party` reuses a THREE-label enum narrowed by
  // a CHECK, so `observer` is representable in the type and impossible in the table.
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
  meetingFilesRepository: { listByMeeting: (...a: unknown[]) => mockListByMeeting(...a) },
  conversationsRepository: { listFiles: (...a: unknown[]) => mockListFiles(...a) },
  usersRepository: { findNamesByIds: (...a: unknown[]) => mockFindNamesByIds(...a) },
}));

import {
  loadCaseFiles,
  CASE_FILE_MEETING_FAN_OUT,
  type CaseFileMeetingRef,
} from './load-case-files';
import { log } from '@/lib/logging';

const VIEWER_ID = 'u0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'u0000000-0000-4000-8000-000000000002';
const SECOND_OTHER_ID = 'u0000000-0000-4000-8000-000000000003';
const CONVERSATION_ID = 'cv000000-0000-4000-8000-000000000004';
const MEETING_A = 'm0000000-0000-4000-8000-00000000000a';
const MEETING_B = 'm0000000-0000-4000-8000-00000000000b';

/** The exact object locators the presigner signs. Neither may ever reach a view row. */
const MEETING_R2_KEY = 'meetings/m-a/1f2e3d4c-SUPERSECRETOBJECTKEY/deck.pdf';
const CONVERSATION_R2_KEY = 'conversations/cv-4/9a8b7c6d-ANOTHERSECRETKEY/notes.pdf';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

interface MeetingFileOverrides {
  id: string;
  meetingId?: string;
  uploadedByUserId?: string;
  party?: string;
  createdAt?: Date;
  fileName?: string;
}

/** A FULL `meeting_files` row — `r2Key` included, exactly as the repository hands one over. */
function meetingFile(over: MeetingFileOverrides): MeetingFile {
  return {
    meetingId: MEETING_A,
    uploadedByUserId: VIEWER_ID,
    party: 'client',
    source: 'files_tab',
    r2Key: MEETING_R2_KEY,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as MeetingFile;
}

interface ConversationFileOverrides {
  id: string;
  uploadedByUserId?: string;
  createdAt?: Date;
  fileName?: string;
}

/** A FULL `conversation_files` row — `r2Key` included. */
function conversationFile(over: ConversationFileOverrides): ConversationFile {
  return {
    conversationId: CONVERSATION_ID,
    uploadedByUserId: VIEWER_ID,
    r2Key: CONVERSATION_R2_KEY,
    fileName: 'notes.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as ConversationFile;
}

function meetingRef(
  meetingId: string,
  ordinal: number | null,
  occurredAtIso: string
): CaseFileMeetingRef {
  return { meetingId, ordinal, occurredAt: new Date(occurredAtIso) };
}

const REF_A = meetingRef(MEETING_A, 3, '2026-07-01T09:00:00Z');
const REF_B = meetingRef(MEETING_B, 4, '2026-07-08T09:00:00Z');

function seed(
  config: {
    meetingFiles?: Record<string, MeetingFile[]>;
    conversationFiles?: ConversationFile[];
    names?: Array<{ id: string; firstName: string | null; lastName: string | null }>;
  } = {}
): void {
  vi.clearAllMocks();
  const byMeeting = config.meetingFiles ?? {};
  mockListByMeeting.mockImplementation((meetingId: unknown) =>
    Promise.resolve(typeof meetingId === 'string' ? (byMeeting[meetingId] ?? []) : [])
  );
  mockListFiles.mockResolvedValue(config.conversationFiles ?? []);
  mockFindNamesByIds.mockResolvedValue(config.names ?? []);
}

function load(
  meetings: readonly CaseFileMeetingRef[],
  viewerUserId = VIEWER_ID
): ReturnType<typeof loadCaseFiles> {
  return loadCaseFiles({ meetings, conversationId: CONVERSATION_ID, viewerUserId });
}

/** The meeting ids the fan-out actually queried, in call order. */
function fannedOutMeetingIds(): string[] {
  return mockListByMeeting.mock.calls.map((call) => {
    const [meetingId] = call as [unknown];
    return typeof meetingId === 'string' ? meetingId : '';
  });
}

beforeEach(() => {
  seed();
});

// ── 1. the secret-leak boundary ──────────────────────────────────────────────────────────

describe('loadCaseFiles — `r2Key` is STRUCTURALLY ABSENT from every row', () => {
  it('emits no r2Key key and no r2Key VALUE, from either source', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1' })] },
      conversationFiles: [conversationFile({ id: 'cf-1' })],
    });

    const result = await load([REF_A]);

    expect(result.files).toHaveLength(2);
    for (const file of result.files) {
      expect('r2Key' in file).toBe(false);
    }
    // A type cannot police a spread; a serialized search can.
    const serialized = JSON.stringify(result.files);
    expect(serialized).not.toContain(MEETING_R2_KEY);
    expect(serialized).not.toContain(CONVERSATION_R2_KEY);
    expect(serialized).not.toContain('SUPERSECRETOBJECTKEY');
    expect(serialized).not.toContain('ANOTHERSECRETKEY');
  });

  it('carries no email address anywhere (ADR-1044)', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1', uploadedByUserId: OTHER_ID })] },
      names: [{ id: OTHER_ID, firstName: 'Dana', lastName: 'Okafor' }],
    });

    const result = await load([REF_A]);

    expect(result.files).toHaveLength(1);
    expect(JSON.stringify(result.files)).not.toContain('@');
  });
});

// ── 2. the discriminated union ───────────────────────────────────────────────────────────

describe('loadCaseFiles — the union is DISCRIMINATED on `origin`', () => {
  it('gives a meeting file origin=meeting with ITS meetingId, and a conversation file null', async () => {
    seed({
      meetingFiles: {
        [MEETING_B]: [
          meetingFile({
            id: 'mf-1',
            meetingId: MEETING_B,
            createdAt: new Date('2026-07-08T10:00:00Z'),
          }),
        ],
      },
      conversationFiles: [
        conversationFile({ id: 'cf-1', createdAt: new Date('2026-07-01T10:00:00Z') }),
      ],
    });

    const [meetingRow, conversationRow] = await load([REF_B]).then((r) => r.files);
    if (meetingRow === undefined || conversationRow === undefined) {
      throw new Error('expected one row from each source');
    }

    expect(meetingRow).toMatchObject({
      origin: 'meeting',
      id: 'mf-1',
      meetingId: MEETING_B,
      fileName: 'deck.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      createdAtIso: '2026-07-08T10:00:00.000Z',
    });
    // ⚠ `null` BY CONSTRUCTION — the download action reads this to pick which gate applies.
    expect(conversationRow).toMatchObject({
      origin: 'conversation',
      id: 'cf-1',
      meetingId: null,
      fileName: 'notes.pdf',
      sizeBytes: 2048,
      createdAtIso: '2026-07-01T10:00:00.000Z',
    });
  });

  it('reads the conversation thread with the FULL scope, not the meeting scope', async () => {
    await load([]);
    expect(mockListFiles).toHaveBeenCalledWith(CONVERSATION_ID, { kind: 'full' });
  });
});

// ── 3. ordering ──────────────────────────────────────────────────────────────────────────

describe('loadCaseFiles — NEWEST FIRST across the MERGED set', () => {
  /**
   * ⚠ INTERLEAVED ACROSS BOTH SOURCES ON PURPOSE. A naive per-source concat (meeting rows then
   * conversation rows, each oldest-first as the repositories return them) passes a
   * single-source ordering test and fails this one.
   */
  it('interleaves the two sources by timestamp', async () => {
    seed({
      meetingFiles: {
        [MEETING_A]: [
          meetingFile({ id: 'mf-oldest', createdAt: new Date('2026-07-01T10:00:00Z') }),
          meetingFile({ id: 'mf-third', createdAt: new Date('2026-07-03T10:00:00Z') }),
        ],
      },
      conversationFiles: [
        conversationFile({ id: 'cf-second', createdAt: new Date('2026-07-02T10:00:00Z') }),
        conversationFile({ id: 'cf-newest', createdAt: new Date('2026-07-04T10:00:00Z') }),
      ],
    });

    const result = await load([REF_A]);

    expect(result.files.map((file) => file.id)).toEqual([
      'cf-newest',
      'mf-third',
      'cf-second',
      'mf-oldest',
    ]);
  });

  it('breaks an exact timestamp tie on id, so a refresh never reorders the card', async () => {
    const sameInstant = new Date('2026-07-05T10:00:00Z');
    seed({
      meetingFiles: {
        [MEETING_A]: [meetingFile({ id: 'zz-meeting', createdAt: sameInstant })],
      },
      conversationFiles: [conversationFile({ id: 'aa-conversation', createdAt: sameInstant })],
    });

    const result = await load([REF_A]);

    expect(result.files.map((file) => file.id)).toEqual(['aa-conversation', 'zz-meeting']);
  });

  it('returns an empty list and truncated=false for a case with no files at all', async () => {
    const result = await load([REF_A]);
    expect(result).toEqual({ files: [], truncated: false });
  });
});

// ── 4. fail-closed on a corrupt party ────────────────────────────────────────────────────

describe('loadCaseFiles — a non-two-sided party is DROPPED, never coerced', () => {
  it('omits the row and warns, keeping every two-sided sibling', async () => {
    seed({
      meetingFiles: {
        [MEETING_A]: [
          meetingFile({ id: 'mf-client', party: 'client' }),
          meetingFile({ id: 'mf-observer', party: 'observer' }),
          meetingFile({ id: 'mf-expert', party: 'expert' }),
        ],
      },
    });

    const result = await load([REF_A]);

    expect(result.files.map((file) => file.id).sort()).toEqual(['mf-client', 'mf-expert']);
    expect(log.warn).toHaveBeenCalledWith('Dropping case file with a non-two-sided party', {
      meetingId: MEETING_A,
      fileId: 'mf-observer',
      party: 'observer',
    });
  });

  it('does not warn when every row is two-sided', async () => {
    seed({ meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1', party: 'expert' })] } });
    await load([REF_A]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ── 5. bounds, and never silently ────────────────────────────────────────────────────────

describe('loadCaseFiles — the bounds are REPORTED, never silent', () => {
  it('fans out over at most CASE_FILE_MEETING_FAN_OUT meetings and says so', async () => {
    const meetings = Array.from({ length: CASE_FILE_MEETING_FAN_OUT + 1 }, (_unused, index) =>
      // index 0 is the OLDEST — it is the one the cap must drop.
      meetingRef(
        `m-${String(index).padStart(2, '0')}`,
        index + 1,
        `2026-07-${10 + index}T09:00:00Z`
      )
    );

    const result = await load(meetings);

    expect(mockListByMeeting).toHaveBeenCalledTimes(CASE_FILE_MEETING_FAN_OUT);
    expect(result.truncated).toBe(true);
    // ⚠ THE CAP DROPS THE OLDEST CONSULTATIONS — the newest 20 are what got queried.
    const queried = fannedOutMeetingIds();
    expect(queried).not.toContain('m-00');
    expect(queried).toContain('m-20');
    expect([...queried].sort()).toEqual(
      meetings
        .slice(1)
        .map((ref) => ref.meetingId)
        .sort()
    );
  });

  it('does NOT truncate at exactly the fan-out bound', async () => {
    const meetings = Array.from({ length: CASE_FILE_MEETING_FAN_OUT }, (_unused, index) =>
      meetingRef(
        `m-${String(index).padStart(2, '0')}`,
        index + 1,
        `2026-07-${10 + index}T09:00:00Z`
      )
    );

    const result = await load(meetings);

    expect(mockListByMeeting).toHaveBeenCalledTimes(CASE_FILE_MEETING_FAN_OUT);
    expect(result.truncated).toBe(false);
  });

  /**
   * ⚠ THE COUNTER-INTUITIVE ONE. `listByMeeting` is capped OLDEST-FIRST, so hitting the cap
   * drops the NEWEST files — precisely the ones a viewer is looking for.
   */
  it('truncates when ONE meeting returns exactly MEETING_FILE_LIST_LIMIT rows, and warns', async () => {
    const capped = Array.from({ length: MEETING_FILE_LIST_LIMIT }, (_unused, index) =>
      meetingFile({
        id: `mf-${String(index).padStart(3, '0')}`,
        createdAt: new Date(2026, 6, 1, 0, index),
      })
    );
    seed({ meetingFiles: { [MEETING_A]: capped } });

    const result = await load([REF_A]);

    expect(result.files).toHaveLength(MEETING_FILE_LIST_LIMIT);
    expect(result.truncated).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('Case file merge hit the per-meeting file cap', {
      meetingId: MEETING_A,
      limit: MEETING_FILE_LIST_LIMIT,
    });
  });

  it('does NOT truncate one row below the per-meeting cap', async () => {
    const underCap = Array.from({ length: MEETING_FILE_LIST_LIMIT - 1 }, (_unused, index) =>
      meetingFile({ id: `mf-${index}`, createdAt: new Date(2026, 6, 1, 0, index) })
    );
    seed({ meetingFiles: { [MEETING_A]: underCap } });

    const result = await load([REF_A]);

    expect(result.truncated).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ── 6. uploader labels ───────────────────────────────────────────────────────────────────

describe('loadCaseFiles — uploader labels, in ONE batched query', () => {
  it('resolves the DISTINCT non-viewer uploader set across BOTH sources in one call', async () => {
    seed({
      meetingFiles: {
        [MEETING_A]: [
          meetingFile({ id: 'mf-1', uploadedByUserId: OTHER_ID }),
          meetingFile({ id: 'mf-2', uploadedByUserId: OTHER_ID }),
          meetingFile({ id: 'mf-3', uploadedByUserId: VIEWER_ID }),
        ],
      },
      conversationFiles: [
        conversationFile({ id: 'cf-1', uploadedByUserId: SECOND_OTHER_ID }),
        conversationFile({ id: 'cf-2', uploadedByUserId: OTHER_ID }),
      ],
      names: [
        { id: OTHER_ID, firstName: 'Dana', lastName: 'Okafor' },
        { id: SECOND_OTHER_ID, firstName: 'Amara', lastName: 'Chen' },
      ],
    });

    await load([REF_A]);

    expect(mockFindNamesByIds).toHaveBeenCalledTimes(1);
    const firstCall = mockFindNamesByIds.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('expected exactly one batched name lookup');
    }
    const [ids] = firstCall as [string[]];
    // DISTINCT, and the VIEWER is excluded — their own uploads render "You".
    expect([...ids].sort()).toEqual([OTHER_ID, SECOND_OTHER_ID].sort());
  });

  it('costs ZERO name lookups when every file is the viewer’s own, labelling them "You"', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1' })] },
      conversationFiles: [conversationFile({ id: 'cf-1' })],
    });

    const result = await load([REF_A]);

    expect(mockFindNamesByIds).not.toHaveBeenCalled();
    expect(result.files.map((file) => file.uploaderLabel)).toEqual(['You', 'You']);
  });

  it('labels a counterparty by FIRST NAME ONLY — the surname never crosses the boundary', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1', uploadedByUserId: OTHER_ID })] },
      names: [{ id: OTHER_ID, firstName: 'Dana', lastName: 'Okafor' }],
    });

    const result = await load([REF_A]);

    const [row] = result.files;
    if (row === undefined) throw new Error('expected one merged row');
    expect(row.uploaderLabel).toBe('Dana');
    expect(JSON.stringify(result.files)).not.toContain('Okafor');
  });

  it('falls back to "Someone" for an uploader the batch did not resolve', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1', uploadedByUserId: OTHER_ID })] },
      names: [],
    });

    const result = await load([REF_A]);

    const [row] = result.files;
    if (row === undefined) throw new Error('expected one merged row');
    expect(row.uploaderLabel).toBe('Someone');
  });

  it('falls back to "Someone" for a resolved person with no first name', async () => {
    seed({
      meetingFiles: { [MEETING_A]: [meetingFile({ id: 'mf-1', uploadedByUserId: OTHER_ID })] },
      names: [{ id: OTHER_ID, firstName: null, lastName: 'Okafor' }],
    });

    const result = await load([REF_A]);

    const [row] = result.files;
    if (row === undefined) throw new Error('expected one merged row');
    expect(row.uploaderLabel).toBe('Someone');
  });
});

// ── 7. provenance labels ─────────────────────────────────────────────────────────────────

describe('loadCaseFiles — sourceLabel', () => {
  it('numbers a consultation, drops the number for a cancelled one, and names the thread', async () => {
    seed({
      meetingFiles: {
        [MEETING_A]: [meetingFile({ id: 'mf-a', createdAt: new Date('2026-07-03T10:00:00Z') })],
        [MEETING_B]: [
          meetingFile({
            id: 'mf-b',
            meetingId: MEETING_B,
            createdAt: new Date('2026-07-02T10:00:00Z'),
          }),
        ],
      },
      conversationFiles: [
        conversationFile({ id: 'cf-1', createdAt: new Date('2026-07-01T10:00:00Z') }),
      ],
    });

    const result = await load([REF_A, meetingRef(MEETING_B, null, '2026-07-08T09:00:00Z')]);

    expect(result.files.map((file) => [file.id, file.sourceLabel])).toEqual([
      ['mf-a', 'Consultation 3'],
      // `null` ordinal ⇒ cancelled ⇒ the label carries NO number rather than a wrong one.
      ['mf-b', 'Consultation'],
      ['cf-1', 'Conversation'],
    ]);
  });
});
