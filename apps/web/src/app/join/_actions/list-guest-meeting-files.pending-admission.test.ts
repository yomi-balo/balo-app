import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-445 fix round 2 (S3). The orchestrator ruled the admission check belongs at the GATE
 * (`authorizeMeetingFileAccess`), not duplicated in each of the three guest read actions,
 * precisely because one chokepoint is harder to forget than three. That property — "this
 * action is actually protected by the gate's admission check" — was previously proven only
 * by reading the code: every other test in `list-guest-meeting-files.test.ts` fully mocks
 * `authorizeMeetingFileAccess`, so nothing there would fail if a future edit gave this action
 * (or the gate) a guest short-circuit that skipped the admission check.
 *
 * This file is deliberately separate and does NOT mock `@/lib/meetings/authorize-meeting-file-
 * access` — the REAL gate runs, fed a REAL `pending` subject. Only the gate's own transitive
 * `@balo/db` reads are stubbed, so the assertion is genuinely load-bearing: a `pending` guest
 * must be refused, and — because the whole point of "gate before repository" is that the
 * repository call never happens — `meetingFilesRepository.listByMeeting` must never fire.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'b0000000-0000-4000-8000-000000000002';
const CONTEXT_ID = 'e0000000-0000-4000-8000-000000000005';
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const mockListByMeeting = vi.fn();
const mockMeetingFindById = vi.fn();
const mockListContexts = vi.fn();

// ⚠ NOT mocking `authorize-meeting-file-access` — the real gate runs. Its OWN `@balo/db`
// reads (meeting + context resolution) are stubbed here; the admission check denies before
// any owner resolution, so `resolveMeetingContextOwner` / `partyMembershipsRepository` /
// `expertsRepository` / `requestExpertRelationshipsRepository` are never reached and are
// left unimplemented on purpose — a call to any of them would throw and fail the test loudly.
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { listByMeeting: (...args: unknown[]) => mockListByMeeting(...args) },
  MEETING_FILE_LIST_LIMIT: 200,
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

import { listGuestMeetingFilesAction } from './list-guest-meeting-files';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN };

/** A live guest row with a LOBBY-only seat — never admitted. */
const PENDING_SUBJECT = {
  guest: { id: GUEST_ID, accessScope: 'meeting' },
  meeting: { id: MEETING_ID, status: 'scheduled' },
  side: 'client',
  admission: 'pending',
};

describe('listGuestMeetingFilesAction — S3, against the REAL gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
    mockCheckLimit.mockReturnValue(true);
    mockMeetingFindById.mockResolvedValue({ id: MEETING_ID, status: 'scheduled' });
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CONTEXT_ID }]);
    mockResolveSubject.mockResolvedValue(PENDING_SUBJECT);
  });

  it('refuses a PENDING (not-yet-admitted) guest with the collapsed literal, and never reaches the file repository', async () => {
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockListByMeeting).not.toHaveBeenCalled();
  });
});
