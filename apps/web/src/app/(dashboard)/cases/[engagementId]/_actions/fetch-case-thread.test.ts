import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the case thread's "Show earlier messages" READ action.
 *
 * ⚠⚠ THIS ACTION IS ON `READ_ONLY_ALLOWLIST`, so it authenticates with BARE `requireUser()`.
 * `onboarding-mutation-gate.test.ts` proves the allowlist entry is honest by reading this
 * file's SOURCE for the substring — it cannot see which function actually ran. So the
 * session module is mocked with BOTH functions here and the suite asserts which one was
 * called, which is the property the source scan can only approximate.
 *
 * ⚠ THE OTHER TWO CLAIMS WORTH PINNING ARE BOTH DISCLOSURE-SHAPED:
 *   · `scope: { kind: 'full' }` is STATED, never defaulted — `{ kind: 'meeting' }` is the
 *     narrowed guest scope, and a repository default would put that filter one forgotten
 *     argument away from showing a meeting guest the whole case thread (or vice versa);
 *   · the uploader-name lookup is ONE batched `findNamesByIds` over the DISTINCT uploader
 *     set — never one query per file, which is an N+1 that grows with the thread.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000b001';
const USER_ID = 'u0000000-0000-4000-8000-00000000b002';
/** ⚠ Deliberately shares no bytes with the input: the thread comes from the GATE. */
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000bbeef';
const MSG_ID = 'a0000000-0000-4000-8000-00000000b009';

const UPLOADER_A = 'u0000000-0000-4000-8000-00000000b00a';
const UPLOADER_B = 'u0000000-0000-4000-8000-00000000b00b';

vi.mock('server-only', () => ({}));

const mockListMessagesPage = vi.fn();
const mockListFiles = vi.fn();
const mockFindNamesByIds = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    listMessagesPage: (...a: unknown[]) => mockListMessagesPage(...a),
    listFiles: (...a: unknown[]) => mockListFiles(...a),
  },
  usersRepository: { findNamesByIds: (...a: unknown[]) => mockFindNamesByIds(...a) },
}));

const mockRequireUser = vi.fn();
const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

import { fetchCaseThreadAction } from './fetch-case-thread';
import { log } from '@/lib/logging';

/** The read consumes `conversationId` alone — see the closed-case block at the bottom. */
const ACCESS = { conversationId: GATE_CONVERSATION_ID, conversationWritable: true };

const INPUT = { engagementId: ENGAGEMENT_ID, includeFiles: false };

function messageRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MSG_ID,
    conversationId: GATE_CONVERSATION_ID,
    senderUserId: UPLOADER_B,
    body: '<p>hello</p>',
    createdAt: new Date('2026-08-09T10:00:00Z'),
    updatedAt: new Date('2026-08-09T10:00:00Z'),
    deletedAt: null,
    senderFirstName: 'Priya',
    senderLastName: 'Nair',
    ...over,
  };
}

/** Repository order is OLDEST-FIRST; the panel reads newest-first. */
function fileRow(id: string, uploadedByUserId: string, day: string): Record<string, unknown> {
  return {
    id,
    conversationId: GATE_CONVERSATION_ID,
    uploadedByUserId,
    r2Key: `keys/${id}`,
    fileName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 100,
    createdAt: new Date(`2026-08-${day}T00:00:00Z`),
    updatedAt: new Date(`2026-08-${day}T00:00:00Z`),
    deletedAt: null,
  };
}

/** Three files so a reversal assertion cannot be satisfied by a two-element coincidence. */
const OLDEST_FIRST_FILES = [
  fileRow('f-oldest', UPLOADER_A, '01'),
  fileRow('f-middle', UPLOADER_B, '02'),
  fileRow('f-newest', UPLOADER_A, '03'),
];

function seed(): void {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: USER_ID });
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockListMessagesPage.mockResolvedValue({ messages: [messageRow()], hasEarlier: false });
  mockListFiles.mockResolvedValue([]);
  mockFindNamesByIds.mockResolvedValue([]);
}

beforeEach(() => {
  seed();
});

describe('fetchCaseThreadAction — it authenticates as a READ', () => {
  it('uses BARE requireUser, never requireOnboardedUser', async () => {
    await fetchCaseThreadAction(INPUT);
    // A pre-onboarding session may legitimately read; promoting this to the onboarded gate
    // would 401 a real reader, and would also make the allowlist entry a lie.
    expect(mockRequireUser).toHaveBeenCalledTimes(1);
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before the tenancy gate runs', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await fetchCaseThreadAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor before any repository read', async () => {
    const result = await fetchCaseThreadAction({
      ...INPUT,
      before: { createdAtIso: 'not-a-date', id: MSG_ID },
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate for the session user', async () => {
    await fetchCaseThreadAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('refuses a gate denial with the shared literal, reading nothing', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await fetchCaseThreadAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    expect(mockListMessagesPage).not.toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it('maps a repository failure to friendly copy and logs the cause', async () => {
    mockListMessagesPage.mockRejectedValue(new Error('boom'));
    expect(await fetchCaseThreadAction(INPUT)).toEqual({
      success: false,
      error: 'Could not load this conversation. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to fetch case conversation thread',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, userId: USER_ID, error: 'boom' })
    );
  });
});

describe('fetchCaseThreadAction — the page query is fully STATED', () => {
  it('reads the GATE conversation with scope FULL and no cursor, by default', async () => {
    await fetchCaseThreadAction(INPUT);
    expect(mockListMessagesPage).toHaveBeenCalledWith({
      conversationId: GATE_CONVERSATION_ID,
      // ⚠ `{ kind: 'meeting' }` is the meeting-level GUEST scope. Stating `full` here is what
      // keeps that narrowing from ever being reached by a repository default.
      scope: { kind: 'full' },
      before: undefined,
      limit: 30,
    });
  });

  it('never reads a conversation named by the caller', async () => {
    await fetchCaseThreadAction(INPUT);
    const [call] = mockListMessagesPage.mock.calls;
    if (call === undefined) {
      throw new Error('expected the message page to have been read');
    }
    const [args] = call as [{ conversationId: string }];
    expect(args.conversationId).not.toBe(ENGAGEMENT_ID);
  });

  it('converts the keyset cursor ISO string into a real Date', async () => {
    await fetchCaseThreadAction({
      ...INPUT,
      before: { createdAtIso: '2026-08-09T10:00:00.000Z', id: MSG_ID },
    });
    expect(mockListMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { createdAt: new Date('2026-08-09T10:00:00.000Z'), id: MSG_ID },
      })
    );
  });

  it('maps rows through the shared view mapper', async () => {
    expect(await fetchCaseThreadAction(INPUT)).toEqual({
      success: true,
      messages: [
        expect.objectContaining({
          id: MSG_ID,
          bodyHtml: '<p>hello</p>',
          senderName: 'Priya Nair',
          createdAtIso: '2026-08-09T10:00:00.000Z',
        }),
      ],
      hasEarlier: false,
    });
  });

  it('reports hasEarlier straight from the repository', async () => {
    mockListMessagesPage.mockResolvedValue({ messages: [], hasEarlier: true });
    const result = await fetchCaseThreadAction(INPUT);
    expect(result).toMatchObject({ success: true, hasEarlier: true });
  });
});

describe('fetchCaseThreadAction — the files side-car', () => {
  it('does not touch the files table at all when includeFiles is false', async () => {
    const result = await fetchCaseThreadAction(INPUT);
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockFindNamesByIds).not.toHaveBeenCalled();
    // No `files` KEY at all — not `files: undefined`, which the panel would still destructure.
    expect(Object.keys(result)).not.toContain('files');
  });

  it('reads files on the GATE conversation with the scope stated', async () => {
    mockListFiles.mockResolvedValue(OLDEST_FIRST_FILES);
    await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    expect(mockListFiles).toHaveBeenCalledWith(GATE_CONVERSATION_ID, { kind: 'full' });
  });

  it('REVERSES the repository order — the panel reads newest-first', async () => {
    mockListFiles.mockResolvedValue(OLDEST_FIRST_FILES);
    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    expect(result).toMatchObject({ success: true });
    if (!result.success) {
      throw new Error('expected the thread read to succeed');
    }
    // Three files, so this cannot pass by a symmetric two-element coincidence.
    expect(result.files?.map((file) => file.id)).toEqual(['f-newest', 'f-middle', 'f-oldest']);
  });

  it('resolves uploader names with ONE batched query over the DISTINCT uploaders', async () => {
    mockListFiles.mockResolvedValue(OLDEST_FIRST_FILES);
    mockFindNamesByIds.mockResolvedValue([
      { id: UPLOADER_A, firstName: 'Dana', lastName: 'Whitfield' },
      { id: UPLOADER_B, firstName: 'Priya', lastName: 'Nair' },
    ]);

    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });

    // Three files, TWO uploaders (A twice) ⇒ one call, two ids. An N+1 would be three calls.
    expect(mockFindNamesByIds).toHaveBeenCalledTimes(1);
    expect(mockFindNamesByIds).toHaveBeenCalledWith([UPLOADER_A, UPLOADER_B]);
    if (!result.success) {
      throw new Error('expected the thread read to succeed');
    }
    expect(result.files?.map((file) => file.uploadedByName)).toEqual([
      'Dana Whitfield',
      'Priya Nair',
      'Dana Whitfield',
    ]);
  });

  it('falls back to Participant for an uploader the batch did not return', async () => {
    mockListFiles.mockResolvedValue([fileRow('f-only', UPLOADER_A, '01')]);
    mockFindNamesByIds.mockResolvedValue([]);
    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    if (!result.success) {
      throw new Error('expected the thread read to succeed');
    }
    expect(result.files?.[0]?.uploadedByName).toBe('Participant');
  });

  it('skips the name query entirely for a thread with zero files', async () => {
    mockListFiles.mockResolvedValue([]);
    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    expect(mockFindNamesByIds).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, files: [] });
  });

  it('never leaks the R2 key into a client-bound file view', async () => {
    mockListFiles.mockResolvedValue(OLDEST_FIRST_FILES);
    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    expect(JSON.stringify(result)).not.toContain('keys/f-newest');
  });
});

/**
 * ⚠⚠ NO WRITABILITY CHECK, DELIBERATELY. A CLOSED case is fully READABLE — read access and
 * write access are separate questions, and only `postCaseMessageAction` composes
 * `conversationWritable`. A guard added here would blank the thread on every resolved case.
 */
describe('fetchCaseThreadAction — a CLOSED case is fully readable', () => {
  it('returns messages AND files for a non-writable thread', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      ...ACCESS,
      engagementStatus: 'completed',
      conversationWritable: false,
    });
    mockListFiles.mockResolvedValue(OLDEST_FIRST_FILES);

    const result = await fetchCaseThreadAction({ ...INPUT, includeFiles: true });
    expect(result).toMatchObject({ success: true });
    if (!result.success) {
      throw new Error('expected a closed case to stay readable');
    }
    expect(result.messages).toHaveLength(1);
    expect(result.files).toHaveLength(3);
  });
});
