import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const KEY = `meeting-files/${MEETING_ID}/${USER_ID}/c0000000-0000-4000-8000-000000000003`;

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

const MAX_BYTES = 10 * 1024 * 1024;

const mockPresign = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  MEETING_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  MAX_MEETING_FILE_BYTES: 10 * 1024 * 1024,
  createPresignedMeetingFileUpload: (...args: unknown[]) => mockPresign(...args),
}));

import { requestMeetingFileUploadAction } from './request-meeting-file-upload';
import { log } from '@/lib/logging';

const VALID_INPUT = {
  meetingId: MEETING_ID,
  contentType: 'application/pdf',
  fileName: 'deck.pdf',
  sizeBytes: 4096,
};

const GENERIC_DENIAL = { success: false, error: 'This meeting is no longer available.' };

describe('requestMeetingFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
    mockAuthorize.mockResolvedValue({ ok: true, side: 'client' });
    mockPresign.mockResolvedValue({ presignedUrl: 'https://signed.example/put', key: KEY });
  });

  it('rejects when not signed in (or not onboarded) without touching the gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    const result = await requestMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('rejects a malformed input before the gate', async () => {
    const result = await requestMeetingFileUploadAction({ ...VALID_INPUT, meetingId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('maps a gate denial to generic copy and NEVER presigns', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await requestMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual(GENERIC_DENIAL);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  /**
   * ⚠ ORDERING: the content-type check runs AFTER the gate, so a non-participant cannot
   * learn from the response whether a type is acceptable — nor anything else about a
   * guessed meetingId.
   */
  it('rejects a disallowed content type only AFTER the gate has passed', async () => {
    const result = await requestMeetingFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockAuthorize).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('rejects a disallowed content type when the gate DENIES, with the denial copy (gate wins)', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await requestMeetingFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(result).toEqual(GENERIC_DENIAL);
  });

  it('presigns with the gate-validated meeting and the SESSION user, never client input', async () => {
    const result = await requestMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, presignedUrl: 'https://signed.example/put', key: KEY });
    expect(mockPresign).toHaveBeenCalledWith(MEETING_ID, USER_ID, 'application/pdf', 4096);
  });

  // ══ S2 — THE CAP IS BOUND INTO THE SIGNATURE ════════════════════════════════════════════
  describe('declared size', () => {
    /**
     * ⚠⚠ WHY THE ACTION TAKES A CLIENT-DECLARED SIZE AT ALL. It is not trusted — it becomes
     * the PUT's SIGNED `ContentLength`, so R2 rejects a body of any other length at the edge.
     * A client that lies does not get a bigger upload; it gets a credential its own bytes
     * cannot satisfy. Without this the 10 MB cap was advisory until the post-hoc HEAD at
     * confirm, and one valid presigned URL would let its holder park an arbitrarily large
     * object in the bucket — billable, never confirmed, therefore unreachable by every read
     * path and never deleted — simply by never calling confirm.
     */
    it('passes the declared size through to be signed as ContentLength', async () => {
      await requestMeetingFileUploadAction({ ...VALID_INPUT, sizeBytes: 999 });
      expect(mockPresign).toHaveBeenCalledWith(MEETING_ID, USER_ID, 'application/pdf', 999);
    });

    it('rejects an over-cap size AFTER the gate, and never presigns', async () => {
      const result = await requestMeetingFileUploadAction({
        ...VALID_INPUT,
        sizeBytes: MAX_BYTES + 1,
      });
      expect(result).toEqual({
        success: false,
        error: 'This file is too large. Please choose a smaller file.',
      });
      expect(mockAuthorize).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
      expect(mockPresign).not.toHaveBeenCalled();
    });

    it('accepts exactly the cap (the boundary is inclusive)', async () => {
      const result = await requestMeetingFileUploadAction({
        ...VALID_INPUT,
        sizeBytes: MAX_BYTES,
      });
      expect(result).toMatchObject({ success: true });
      expect(mockPresign).toHaveBeenCalledWith(MEETING_ID, USER_ID, 'application/pdf', MAX_BYTES);
    });

    /** ⚠ THE GATE STILL WINS — an over-cap size must not leak that the meeting exists. */
    it('answers the DENIAL copy for an over-cap size when the gate denies', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
      const result = await requestMeetingFileUploadAction({
        ...VALID_INPUT,
        sizeBytes: MAX_BYTES + 1,
      });
      expect(result).toEqual(GENERIC_DENIAL);
    });

    it.each([
      { label: 'zero', sizeBytes: 0 },
      { label: 'negative', sizeBytes: -1 },
      { label: 'fractional', sizeBytes: 1.5 },
    ])('rejects a $label size at the schema, before the gate', async ({ sizeBytes }) => {
      const result = await requestMeetingFileUploadAction({ ...VALID_INPUT, sizeBytes });
      expect(result).toEqual({ success: false, error: 'Invalid request.' });
      expect(mockAuthorize).not.toHaveBeenCalled();
    });
  });

  it('logs an error and returns friendly copy when presigning throws', async () => {
    mockPresign.mockRejectedValue(new Error('R2 down'));
    const result = await requestMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: "File sharing isn't available right now." });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign meeting file upload',
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID, error: 'R2 down' })
    );
  });
});
