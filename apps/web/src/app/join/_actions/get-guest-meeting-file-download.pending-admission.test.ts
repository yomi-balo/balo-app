import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-445 fix round 2 (S3). See `list-guest-meeting-files.pending-admission.test.ts` for the
 * full reasoning — this is that file's sibling for the download action. Does NOT mock
 * `@/lib/meetings/authorize-meeting-file-access`: the REAL gate runs against a REAL `pending`
 * subject, so this is proof, not inspection, that the gate's admission check protects this
 * action too.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'c0000000-0000-4000-8000-000000000003';
const CONTEXT_ID = 'e0000000-0000-4000-8000-000000000005';
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const mockFindInMeeting = vi.fn();
const mockMeetingFindById = vi.fn();
const mockListContexts = vi.fn();

// ⚠ NOT mocking `authorize-meeting-file-access` — the real gate runs, and denies on
// admission before any owner resolution, so the owner/relationship/role repositories are
// left unimplemented on purpose — a call to any of them would throw and fail loudly.
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { findInMeeting: (...args: unknown[]) => mockFindInMeeting(...args) },
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
  meetingsRepository: { findById: (...args: unknown[]) => mockMeetingFindById(...args) },
  meetingContextsRepository: { listByMeeting: (...args: unknown[]) => mockListContexts(...args) },
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

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  createPresignedMeetingFileDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

import { getGuestMeetingFileDownloadAction } from './get-guest-meeting-file-download';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN, fileId: FILE_ID };

/** A live guest row with a LOBBY-only seat — never admitted. */
const PENDING_SUBJECT = {
  guest: { id: GUEST_ID, accessScope: 'meeting' },
  meeting: { id: MEETING_ID, status: 'scheduled' },
  side: 'client',
  admission: 'pending',
};

describe('getGuestMeetingFileDownloadAction — S3, against the REAL gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
    mockCheckLimit.mockReturnValue(true);
    mockMeetingFindById.mockResolvedValue({ id: MEETING_ID, status: 'scheduled' });
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CONTEXT_ID }]);
    mockResolveSubject.mockResolvedValue(PENDING_SUBJECT);
  });

  it('refuses a PENDING (not-yet-admitted) guest with the collapsed literal, and never reaches the file repository or presigns', async () => {
    const result = await getGuestMeetingFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockFindInMeeting).not.toHaveBeenCalled();
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });
});
