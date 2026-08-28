import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * BAL-439 §9.4 — THE REVOCATION GUARANTEE. Does NOT mock `@/lib/meetings/resolve-meeting-guest`
 * (nor `resolve-guest-recap-access`, nor the file-access gate) — only
 * `meetingGuestsRepository.findLiveByTokenHash` is stubbed. Calling `loadGuestRecap` TWICE with
 * the SAME token and asserting the repository was hit TWICE is the test that would fail the
 * day somebody adds a cookie, a `cache()` wrapper, or an in-memory subject cache anywhere on
 * this path: the per-request re-read of a LIVE-only row IS "removing a guest is immediate and
 * total" (R1).
 */

vi.mock('server-only', () => ({}));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000003';

const {
  mockFindByTokenHash,
  mockMeetingFindById,
  mockListContexts,
  mockTranscriptFindByMeetingId,
} = vi.hoisted(() => ({
  mockFindByTokenHash: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockListContexts: vi.fn(),
  mockTranscriptFindByMeetingId: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingGuestsRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindByTokenHash(...a),
  },
  meetingsRepository: { findById: (...a: unknown[]) => mockMeetingFindById(...a) },
  meetingContextsRepository: { listByMeeting: (...a: unknown[]) => mockListContexts(...a) },
  transcriptsRepository: {
    findByMeetingId: (...a: unknown[]) => mockTranscriptFindByMeetingId(...a),
  },
  transcriptArtifactsRepository: { findByTranscriptAndKind: vi.fn() },
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

import { loadGuestRecap } from './load-guest-recap';

const MEETING_ROW = {
  id: MEETING_ID,
  status: 'ended',
  scheduledStart: new Date('2026-08-01T10:00:00.000Z'),
  scheduledEnd: new Date('2026-08-01T11:00:00.000Z'),
  startedAt: null,
  endedAt: null,
};

const LIVE_ROW = {
  guest: {
    id: 'e0000000-0000-4000-8000-00000000000e',
    tokenHash: TOKEN_HASH,
    party: 'client',
    accessScope: 'meeting',
    meetingId: MEETING_ID,
    admission: 'admitted',
  },
  meeting: MEETING_ROW,
};

function loadOnce(): ReturnType<typeof loadGuestRecap> {
  return loadGuestRecap({
    rawToken: RAW_TOKEN,
    meetingId: MEETING_ID,
    clientIpHash: 'f'.repeat(64),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReturnValue(true);
  mockMeetingFindById.mockResolvedValue(MEETING_ROW);
  mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CASE_CONTEXT_ID }]);
  mockTranscriptFindByMeetingId.mockResolvedValue(undefined);
});

describe('loadGuestRecap — the revocation guarantee (R1)', () => {
  it('⚠⚠ a token that resolved LIVE, then REVOKED, denies on the very next request — nothing is cached', async () => {
    mockFindByTokenHash.mockResolvedValueOnce(LIVE_ROW);

    const first = await loadOnce();
    expect(first).not.toBeNull();

    // Revoked: the SAME token hash now resolves to no live row.
    mockFindByTokenHash.mockResolvedValueOnce(undefined);

    const second = await loadOnce();
    expect(second).toBeNull();

    expect(mockFindByTokenHash).toHaveBeenCalledTimes(2);
    expect(mockFindByTokenHash).toHaveBeenNthCalledWith(1, TOKEN_HASH);
    expect(mockFindByTokenHash).toHaveBeenNthCalledWith(2, TOKEN_HASH);
  });
});
