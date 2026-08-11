import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'c0000000-0000-4000-8000-000000000003';
const FOREIGN_FILE_ID = 'c0000000-0000-4000-8000-00000000dead';
const KEY = `meeting-files/${MEETING_ID}/${USER_ID}/d0000000-0000-4000-8000-000000000004`;

vi.mock('server-only', () => ({}));

const mockFindInMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { findInMeeting: (...args: unknown[]) => mockFindInMeeting(...args) },
  // ⚠ The REAL predicate, not a stub — the point of this test is that the download path and
  // the LIST path agree about which rows exist, and a stub could not show that.
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

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  createPresignedMeetingFileDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

import { getMeetingFileDownloadAction } from './get-meeting-file-download';
import { log } from '@/lib/logging';

const FILE_ROW = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  r2Key: KEY,
  fileName: 'deck.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
  party: 'client',
  source: 'chat',
  uploadedByUserId: USER_ID,
};

const VALID_INPUT = { meetingId: MEETING_ID, fileId: FILE_ID };

/** ⚠ The SAME copy for a foreign id and a soft-deleted one — no existence oracle. */
const UNAVAILABLE = { success: false, error: 'This file is no longer available.' };

describe('getMeetingFileDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue({ id: USER_ID });
    // ⚠ The gate returns the MEETING ROW, and the download reads `access.meeting.id` off it
    // rather than re-using the parsed input.
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: { id: MEETING_ID, status: 'ended' },
    });
    mockFindInMeeting.mockResolvedValue(FILE_ROW);
    mockPresignDownload.mockResolvedValue('https://signed.example/get');
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('rejects a malformed input before the gate', async () => {
    const result = await getMeetingFileDownloadAction({ ...VALID_INPUT, fileId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('maps a gate denial to generic copy and never reads the file', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This meeting is no longer available.' });
    expect(mockFindInMeeting).not.toHaveBeenCalled();
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE WHOLE IDOR STORY FOR `fileId`: the lookup is `findInMeeting`, which puts the
   * GATE-VALIDATED meeting in the WHERE CLAUSE — so a file belonging to another meeting
   * simply never resolves, and it returns the SAME copy as a soft-deleted one, so probing
   * learns nothing about which uuids exist. The containment was never the array scan the
   * previous shape used; it was always the meeting predicate.
   */
  it('returns the same "no longer available" copy for a FOREIGN fileId', async () => {
    mockFindInMeeting.mockResolvedValue(undefined);
    const result = await getMeetingFileDownloadAction({
      ...VALID_INPUT,
      fileId: FOREIGN_FILE_ID,
    });
    expect(result).toEqual(UNAVAILABLE);
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('returns the SAME copy for a soft-deleted file (findInMeeting excludes it)', async () => {
    mockFindInMeeting.mockResolvedValue(undefined);
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual(UNAVAILABLE);
  });

  /**
   * ⚠⚠ CONTAINMENT AT O(1), AND SCOPED TO **THE GATE'S** MEETING ROW — not to the parsed
   * input. They are the same value today (the gate looked the meeting up BY that input), but
   * reading it off the gate result is what keeps that true if the gate ever resolves a
   * meeting by any other route. Docblock and code must name the same thing.
   */
  it('scopes the single-row read to `access.meeting.id`, not to the parsed input', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: { id: MEETING_ID, status: 'ended' },
    });
    await getMeetingFileDownloadAction(VALID_INPUT);
    expect(mockFindInMeeting).toHaveBeenCalledWith({ meetingId: MEETING_ID, fileId: FILE_ID });
    expect(mockFindInMeeting).toHaveBeenCalledOnce();
  });

  /**
   * ⚠⚠ THE TWO READ PATHS MUST AGREE ABOUT WHICH ROWS EXIST. `list-meeting-files.ts` DROPS a
   * row whose `party` is outside the two-sided CHECK — it is corrupt, and guessing an
   * attribution is worse than omitting the file. Without this branch that same row would be
   * invisible in the list yet still downloadable by anyone holding its id: two read paths
   * disagreeing is precisely how a fail-closed posture becomes a bypass. Same copy as a
   * missing file, so the two stay indistinguishable to a prober.
   */
  it('refuses a CORRUPT row (non-two-sided party) with the same copy, as the list does', async () => {
    mockFindInMeeting.mockResolvedValue({ ...FILE_ROW, party: 'observer' });
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual(UNAVAILABLE);
    expect(mockPresignDownload).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Refusing to download a meeting file with a non-two-sided party',
      expect.objectContaining({ fileId: FILE_ID, party: 'observer' })
    );
  });

  it('allows an EXPERT-party row (the predicate accepts both sides, not just client)', async () => {
    mockFindInMeeting.mockResolvedValue({ ...FILE_ROW, party: 'expert' });
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
  });

  it('presigns with the STORED r2Key and STORED fileName', async () => {
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
    expect(mockPresignDownload).toHaveBeenCalledWith(KEY, 'deck.pdf');
  });

  it('works for an expert-side reader too (one gate, both sides)', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'expert',
      meeting: { id: MEETING_ID, status: 'ended' },
    });
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
  });

  it('logs an error and returns friendly copy when presigning throws', async () => {
    mockPresignDownload.mockRejectedValue(new Error('R2 down'));
    const result = await getMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not download this file. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign meeting file download',
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID, fileId: FILE_ID })
    );
  });
});
