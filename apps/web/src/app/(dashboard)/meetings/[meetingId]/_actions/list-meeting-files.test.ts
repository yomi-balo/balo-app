import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const CHAT_FILE_ID = 'c0000000-0000-4000-8000-000000000003';
const TAB_FILE_ID = 'c0000000-0000-4000-8000-000000000004';
const CREATED_AT = new Date('2026-08-11T10:00:00Z');

vi.mock('server-only', () => ({}));

const LIST_LIMIT = 200;

const mockListByMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { listByMeeting: (...args: unknown[]) => mockListByMeeting(...args) },
  MEETING_FILE_LIST_LIMIT: 200,
  // ⚠ The REAL predicate, not a stub. It moved OUT of this action into `@balo/db` because a
  // `'use server'` module may export only async functions — see the action's docblock.
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

import { listMeetingFilesAction } from './list-meeting-files';
import { log } from '@/lib/logging';

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CHAT_FILE_ID,
    meetingId: MEETING_ID,
    uploadedByUserId: USER_ID,
    party: 'client',
    source: 'chat',
    r2Key: `meeting-files/${MEETING_ID}/${USER_ID}/leaf`,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

const VALID_INPUT = { meetingId: MEETING_ID };

describe('listMeetingFilesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue({ id: USER_ID });
    mockAuthorize.mockResolvedValue({ ok: true, side: 'client' });
    mockListByMeeting.mockResolvedValue([]);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('rejects a malformed meetingId before the gate', async () => {
    const result = await listMeetingFilesAction({ meetingId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('maps a gate denial to generic copy and never reads files', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This meeting is no longer available.' });
    expect(mockListByMeeting).not.toHaveBeenCalled();
  });

  it('returns [] for a meeting with no files', async () => {
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: true, files: [] });
    expect(mockListByMeeting).toHaveBeenCalledWith(MEETING_ID);
  });

  /**
   * ⚠⚠ D0's ACCEPTANCE CRITERION. The chat paperclip and the Files-tab drop-zone write to
   * ONE table; listing a meeting's files must return BOTH, distinguishable only by `source`.
   */
  it('returns BOTH in-call sources in one list, in repository order', async () => {
    mockListByMeeting.mockResolvedValue([
      row({ id: CHAT_FILE_ID, source: 'chat', party: 'client' }),
      row({ id: TAB_FILE_ID, source: 'files_tab', party: 'expert', fileName: 'notes.txt' }),
    ]);
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      files: [
        {
          id: CHAT_FILE_ID,
          meetingId: MEETING_ID,
          fileName: 'deck.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1234,
          party: 'client',
          source: 'chat',
          uploadedByUserId: USER_ID,
          createdAtIso: CREATED_AT.toISOString(),
        },
        {
          id: TAB_FILE_ID,
          meetingId: MEETING_ID,
          fileName: 'notes.txt',
          contentType: 'application/pdf',
          sizeBytes: 1234,
          party: 'expert',
          source: 'files_tab',
          uploadedByUserId: USER_ID,
          createdAtIso: CREATED_AT.toISOString(),
        },
      ],
    });
  });

  it('never projects the r2Key across the serialization boundary', async () => {
    mockListByMeeting.mockResolvedValue([row({})]);
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
    const [file] = result.success ? result.files : [];
    expect(file).not.toHaveProperty('r2Key');
  });

  /**
   * The CHECK `meeting_file_party_two_sided` makes a third label unrepresentable. If one ever
   * appeared it would be a CORRUPT row, and the fail-closed answer is to DROP it rather than
   * coerce it to a side — guessing an attribution is worse than omitting the file.
   */
  it('drops (and warns about) a row whose party is not two-sided', async () => {
    mockListByMeeting.mockResolvedValue([
      row({ id: CHAT_FILE_ID, party: 'observer' }),
      row({ id: TAB_FILE_ID, party: 'expert' }),
    ]);
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
    expect(result.success ? result.files.map((f) => f.id) : []).toEqual([TAB_FILE_ID]);
    expect(log.warn).toHaveBeenCalledWith(
      'Dropping meeting file with a non-two-sided party',
      expect.objectContaining({ fileId: CHAT_FILE_ID, party: 'observer' })
    );
  });

  it('works for an expert-side reader too (one gate, both sides)', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, side: 'expert' });
    mockListByMeeting.mockResolvedValue([row({})]);
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
  });

  // ══ S6 — THE BOUND, AND THE REFUSAL TO TRUNCATE SILENTLY ════════════════════════════════
  describe('the list bound', () => {
    /**
     * ⚠ NO SILENT CAPS. The repository bounds the read, and the order is OLDEST-FIRST, so
     * hitting the bound drops the NEWEST files — the ones a live call most wants. A cap that
     * truncated quietly would read as "these are all the files" when it is not. When BAL-132
     * needs more, it adds keyset pagination, never a bigger number.
     */
    it('warns when the returned count reaches the bound', async () => {
      mockListByMeeting.mockResolvedValue(
        Array.from({ length: LIST_LIMIT }, (_unused, index) =>
          row({ id: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}` })
        )
      );

      const result = await listMeetingFilesAction(VALID_INPUT);

      expect(result).toMatchObject({ success: true });
      expect(result.success ? result.files : []).toHaveLength(LIST_LIMIT);
      expect(log.warn).toHaveBeenCalledWith(
        'Meeting file list hit its bound — newest files were truncated',
        expect.objectContaining({ meetingId: MEETING_ID, limit: LIST_LIMIT })
      );
    });

    it('does NOT warn below the bound', async () => {
      mockListByMeeting.mockResolvedValue([row({})]);
      await listMeetingFilesAction(VALID_INPUT);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  it('logs an error and returns friendly copy when the read throws', async () => {
    mockListByMeeting.mockRejectedValue(new Error('DB down'));
    const result = await listMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Could not load files. Please try again.' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to list meeting files',
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID, error: 'DB down' })
    );
  });
});
