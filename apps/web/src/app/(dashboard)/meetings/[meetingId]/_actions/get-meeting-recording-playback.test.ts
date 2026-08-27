import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const RECORDING_ID = 'c0000000-0000-4000-8000-000000000003';
const FOREIGN_RECORDING_ID = 'c0000000-0000-4000-8000-00000000dead';
/** A DIFFERENT meeting id than `MEETING_ID`, so the "gate's id, not parsed input" test is falsifiable. */
const GATE_MEETING_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockFindInMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  meetingRecordingsRepository: {
    findInMeeting: (...args: unknown[]) => mockFindInMeeting(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockSignedPlaybackUrl = vi.fn();
vi.mock('@/lib/mux/playback', () => ({
  signedPlaybackUrl: (...args: unknown[]) => mockSignedPlaybackUrl(...args),
}));

import { getMeetingRecordingPlaybackAction } from './get-meeting-recording-playback';
import { log } from '@/lib/logging';

const RECORDING_ROW = {
  id: RECORDING_ID,
  meetingId: GATE_MEETING_ID,
  status: 'ready',
  muxPlaybackId: 'pb_1',
  durationSeconds: 600,
};

const VALID_INPUT = { meetingId: MEETING_ID, recordingId: RECORDING_ID };

/** ⚠ The SAME copy for a foreign id and a soft-deleted one — no existence oracle. */
const UNAVAILABLE = { success: false, error: 'This recording is no longer available.' };

describe('getMeetingRecordingPlaybackAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue({ id: USER_ID });
    // ⚠ The gate returns a meeting id DIFFERENT from the parsed input, so a caller that (wrongly)
    // threaded the parsed `meetingId` instead of `access.meeting.id` is caught.
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: { id: GATE_MEETING_ID, status: 'ended' },
    });
    mockFindInMeeting.mockResolvedValue(RECORDING_ROW);
    mockSignedPlaybackUrl.mockResolvedValue('https://stream.mux.example/signed.m3u8');
  });

  it('rejects when not signed in, and never calls the gate', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid recordingId before the gate', async () => {
    const result = await getMeetingRecordingPlaybackAction({ ...VALID_INPUT, recordingId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('maps a gate denial to generic copy and never reads the recording', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This meeting is no longer available.' });
    expect(mockFindInMeeting).not.toHaveBeenCalled();
    expect(mockSignedPlaybackUrl).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE WHOLE IDOR STORY FOR `recordingId`: `findInMeeting` scopes by the GATE-VALIDATED
   * meeting, so a foreign id never resolves and `signedPlaybackUrl` is never reached.
   */
  it('returns the "no longer available" copy for a FOREIGN or soft-deleted recordingId', async () => {
    mockFindInMeeting.mockResolvedValue(undefined);
    const result = await getMeetingRecordingPlaybackAction({
      ...VALID_INPUT,
      recordingId: FOREIGN_RECORDING_ID,
    });
    expect(result).toEqual(UNAVAILABLE);
    expect(mockSignedPlaybackUrl).not.toHaveBeenCalled();
  });

  it('refuses a not-yet-ready recording', async () => {
    mockFindInMeeting.mockResolvedValue({ ...RECORDING_ROW, status: 'ingesting' });
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This recording is not ready yet.' });
    expect(mockSignedPlaybackUrl).not.toHaveBeenCalled();
  });

  it('refuses a `ready` row with a null muxPlaybackId, with the same literal', async () => {
    mockFindInMeeting.mockResolvedValue({ ...RECORDING_ROW, status: 'ready', muxPlaybackId: null });
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This recording is not ready yet.' });
    expect(mockSignedPlaybackUrl).not.toHaveBeenCalled();
  });

  it("scopes the read to the GATE'S meeting id, not the parsed input", async () => {
    await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(mockFindInMeeting).toHaveBeenCalledWith({
      meetingId: GATE_MEETING_ID,
      recordingId: RECORDING_ID,
    });
    expect(mockFindInMeeting).toHaveBeenCalledOnce();
  });

  it('returns the signed URL on the happy path', async () => {
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({ success: true, url: 'https://stream.mux.example/signed.m3u8' });
  });

  it('threads the duration-aware TTL: 2700s duration -> a 3600s TTL request', async () => {
    mockFindInMeeting.mockResolvedValue({ ...RECORDING_ROW, durationSeconds: 2700 });
    await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(mockSignedPlaybackUrl).toHaveBeenCalledWith('pb_1', 3600);
  });

  it('logs an error and returns friendly copy when signing throws, with no secret in the payload', async () => {
    mockSignedPlaybackUrl.mockRejectedValue(new Error('Mux down'));
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: "Couldn't load this recording. Please try again.",
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to mint meeting recording playback URL',
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID, recordingId: RECORDING_ID })
    );
    const [, payload] = vi.mocked(log.error).mock.calls[0] ?? [];
    const serialisedPayload = JSON.stringify(payload);
    expect(serialisedPayload).not.toContain('url');
    expect(serialisedPayload).not.toContain('token');
    expect(serialisedPayload).not.toContain('muxPlaybackId');
  });

  it('works for an expert-side reader too (one gate, both sides)', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'expert',
      meeting: { id: GATE_MEETING_ID, status: 'ended' },
    });
    const result = await getMeetingRecordingPlaybackAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true });
  });
});
