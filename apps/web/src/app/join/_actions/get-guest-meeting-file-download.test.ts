import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'c0000000-0000-4000-8000-000000000003';
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

vi.mock('server-only', () => ({}));

const mockFindInMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { findInMeeting: (...args: unknown[]) => mockFindInMeeting(...args) },
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

const mockResolveSubject = vi.fn();
vi.mock('@/lib/meetings/resolve-meeting-guest', () => ({
  resolveMeetingGuestSubject: (...a: unknown[]) => mockResolveSubject(...a),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  createPresignedMeetingFileDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

import { getGuestMeetingFileDownloadAction } from './get-guest-meeting-file-download';
import { log } from '@/lib/logging';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN, fileId: FILE_ID };
const SUBJECT = { guest: { id: GUEST_ID, accessScope: 'meeting' }, meeting: { id: MEETING_ID } };
const GATE_MEETING = { id: MEETING_ID };
const FILE_ROW = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  party: 'client',
  r2Key: `meeting-files/${MEETING_ID}/leaf`,
  fileName: 'deck.pdf',
};

describe('getGuestMeetingFileDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
    mockCheckLimit.mockReturnValue(true);
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'meeting',
      meeting: GATE_MEETING,
    });
    mockFindInMeeting.mockResolvedValue(FILE_ROW);
    mockPresignDownload.mockResolvedValue('https://r2.test/presigned');
  });

  it('refuses when throttled', async () => {
    mockCheckLimit.mockReturnValue(false);
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveSubject).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable token', async () => {
    mockResolveSubject.mockResolvedValue(null);
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
  });

  /**
   * ⚠⚠ F7 (fix-round-1) — a SECOND rate limit, keyed on the RESOLVED `guest.id`, runs after
   * `resolveMeetingGuestSubject` and before the gate.
   */
  it('refuses on the SECOND (guest-id-keyed) limit, even when the IP-keyed one allows it', async () => {
    mockCheckLimit.mockImplementation((key: string) => !key.includes(':gid:'));
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('keys the second limiter on the RESOLVED guest id, distinctly from the IP key', async () => {
    await getGuestMeetingFileDownloadAction(VALID_INPUT);
    const keys = mockCheckLimit.mock.calls.map((call) => call[0] as string);
    expect(keys.some((key) => key.includes(GUEST_ID))).toBe(true);
    expect(keys).toHaveLength(2);
  });

  /**
   * ⚠⚠ S1 (fix-round-2) regression — see `list-guest-meeting-files.test.ts`'s sibling for the
   * full collision this closes.
   */
  it('S1 — a hostile X-Forwarded-For cannot forge the guest-id-keyed bucket', async () => {
    mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': `id:${GUEST_ID}` }));
    await getGuestMeetingFileDownloadAction(VALID_INPUT);
    const keys = mockCheckLimit.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toContain(GUEST_ID);
    expect(keys.some((key) => key === `guest-file-download:gid:${GUEST_ID}`)).toBe(true);
  });

  it('refuses a gate denial and never looks up the file', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockFindInMeeting).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the GATE meeting id, never the parsed input', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'meeting',
      meeting: { id: 'gate-resolved-id' },
    });
    await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(mockFindInMeeting).toHaveBeenCalledWith({
      meetingId: 'gate-resolved-id',
      fileId: FILE_ID,
    });
  });

  it('refuses a missing/foreign/soft-deleted file with the same literal', async () => {
    mockFindInMeeting.mockResolvedValue(undefined);
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('refuses a corrupt (non-two-sided) party row with the same literal, and logs it', async () => {
    mockFindInMeeting.mockResolvedValue({ ...FILE_ROW, party: 'observer' });
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.warn).toHaveBeenCalled();
  });

  it('presigns the STORED key and STORED name', async () => {
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(mockPresignDownload).toHaveBeenCalledWith(FILE_ROW.r2Key, FILE_ROW.fileName, {
      expiresInSeconds: 60,
    });
    expect(result).toEqual({ success: true, url: 'https://r2.test/presigned' });
  });

  /**
   * ⚠⚠ F8/Presign-residual (fix-round-1) — a guest download's presign window is SHORTER than
   * the member action's 300s: a guest download is always an immediate click, and R1 makes
   * "removing a guest is immediate and total" the load-bearing justification for having no
   * session at all.
   */
  it('⚠ presigns a SHORTER window than the member action (60s, not 300s)', async () => {
    await getGuestMeetingFileDownloadAction(VALID_INPUT);
    const [, , opts] = mockPresignDownload.mock.calls.at(-1) as [
      string,
      string,
      { expiresInSeconds: number },
    ];
    expect(opts.expiresInSeconds).toBe(60);
    expect(opts.expiresInSeconds).toBeLessThan(300);
  });

  it('maps a throw to the collapsed literal', async () => {
    mockPresignDownload.mockRejectedValue(new Error('r2 down'));
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` now runs INSIDE the `try`, so
   * a throw FROM THE RESOLVER ITSELF is logged and collapsed too, rather than escaping.
   */
  it('maps a throw FROM resolveMeetingGuestSubject itself to the collapsed literal', async () => {
    mockResolveSubject.mockRejectedValue(new Error('resolver blew up'));
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });
});
