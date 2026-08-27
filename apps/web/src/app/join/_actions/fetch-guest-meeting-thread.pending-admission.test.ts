import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-445 fix round 2 (S3). See `list-guest-meeting-files.pending-admission.test.ts` for the
 * full reasoning — this is that file's sibling for the thread action, which reaches the gate
 * indirectly via `resolveMeetingChatAccess`. Neither `@/lib/meetings/meeting-chat-anchor` nor
 * `@/lib/meetings/authorize-meeting-file-access` is mocked here: the REAL gate runs against a
 * REAL `pending` subject, at the first statement of `resolveMeetingChatAccess`, before any
 * conversation lookup.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = '11111111-2222-4333-8444-555555555555';
const CONTEXT_ID = 'e0000000-0000-4000-8000-000000000005';
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const mockListMessagesPage = vi.fn();
const mockFindByContext = vi.fn();
const mockMeetingFindById = vi.fn();
const mockListContexts = vi.fn();

// ⚠ NOT mocking `meeting-chat-anchor` or `authorize-meeting-file-access` — both run for real.
// The gate denies on admission before `resolveMeetingChatAccess` reads a conversation at all,
// so `conversationsRepository.findByContext` / `listContexts` are left as plain spies that
// must never fire.
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    listMessagesPage: (...args: unknown[]) => mockListMessagesPage(...args),
    findByContext: (...args: unknown[]) => mockFindByContext(...args),
  },
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

import { fetchGuestMeetingThreadAction } from './fetch-guest-meeting-thread';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN };

/** A live guest row with a LOBBY-only seat — never admitted. */
const PENDING_SUBJECT = {
  guest: { id: GUEST_ID, accessScope: 'meeting' },
  meeting: { id: MEETING_ID, status: 'scheduled' },
  side: 'client',
  admission: 'pending',
};

describe('fetchGuestMeetingThreadAction — S3, against the REAL gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
    mockCheckLimit.mockReturnValue(true);
    mockMeetingFindById.mockResolvedValue({ id: MEETING_ID, status: 'scheduled' });
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CONTEXT_ID }]);
    mockResolveSubject.mockResolvedValue(PENDING_SUBJECT);
  });

  it('refuses a PENDING (not-yet-admitted) guest with the collapsed literal, and never reaches the conversation repository', async () => {
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockFindByContext).not.toHaveBeenCalled();
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });
});
