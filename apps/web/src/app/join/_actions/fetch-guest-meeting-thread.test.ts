import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-445 — the GUEST in-call thread read. The scope assertion is the point: `access.scope` is
 * STATED, never defaulted or re-derived as `{ kind: 'meeting', … }` inline here.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MESSAGE_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CREATED_AT = new Date('2026-08-14T09:00:00.000Z');
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const {
  mockCheckLimit,
  mockHeaders,
  mockResolveSubject,
  mockResolveChatAccess,
  mockListMessagesPage,
} = vi.hoisted(() => ({
  mockCheckLimit: vi.fn(),
  mockHeaders: vi.fn(),
  mockResolveSubject: vi.fn(),
  mockResolveChatAccess: vi.fn(),
  mockListMessagesPage: vi.fn(),
}));

vi.mock('@/lib/rate-limit/memory-window', () => ({ checkMemoryLimit: mockCheckLimit }));
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));
vi.mock('@/lib/meetings/resolve-meeting-guest', () => ({
  resolveMeetingGuestSubject: mockResolveSubject,
}));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@balo/db', () => ({
  conversationsRepository: { listMessagesPage: mockListMessagesPage },
}));

import { fetchGuestMeetingThreadAction } from './fetch-guest-meeting-thread';
import { log } from '@/lib/logging';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

function row(id = MESSAGE_ID): Record<string, unknown> {
  return {
    id,
    conversationId: CONVERSATION_ID,
    body: '<p>Hello</p>',
    senderUserId: 'some-user',
    senderFirstName: 'Dana',
    senderLastName: 'Okoro',
    createdAt: CREATED_AT,
  };
}

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN };
const SUBJECT = { guest: { id: GUEST_ID, accessScope: 'meeting' }, meeting: { id: MEETING_ID } };
const ENGAGEMENT_SCOPE = { kind: 'engagement-does-not-exist' }; // sentinel to prove pass-through
const MEETING_SCOPE = { kind: 'meeting', meetingId: MEETING_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaders.mockResolvedValue(new Headers());
  mockCheckLimit.mockReturnValue(true);
  mockResolveSubject.mockResolvedValue(SUBJECT);
  mockResolveChatAccess.mockResolvedValue({
    ok: true,
    viewer: 'guest',
    scope: MEETING_SCOPE,
    anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: null },
    meetingId: MEETING_ID,
  });
  mockListMessagesPage.mockResolvedValue({ messages: [row()], hasEarlier: false });
});

describe('fetchGuestMeetingThreadAction', () => {
  it('refuses when throttled, before resolving the token', async () => {
    mockCheckLimit.mockReturnValue(false);
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveSubject).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable token', async () => {
    mockResolveSubject.mockResolvedValue(null);
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ F7 (fix-round-1) — a SECOND rate limit, keyed on the RESOLVED `guest.id`, runs after
   * `resolveMeetingGuestSubject` and before the gate.
   */
  it('refuses on the SECOND (guest-id-keyed) limit, even when the IP-keyed one allows it', async () => {
    mockCheckLimit.mockImplementation((key: string) => !key.includes(':gid:'));
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
  });

  it('keys the second limiter on the RESOLVED guest id, distinctly from the IP key', async () => {
    await fetchGuestMeetingThreadAction(VALID_INPUT);
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
    await fetchGuestMeetingThreadAction(VALID_INPUT);
    const keys = mockCheckLimit.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toContain(GUEST_ID);
    expect(keys.some((key) => key === `guest-thread:gid:${GUEST_ID}`)).toBe(true);
  });

  it('passes a GUEST actor to resolveMeetingChatAccess', async () => {
    await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(mockResolveChatAccess).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: SUBJECT },
    });
  });

  it('refuses a gate denial with the collapsed literal', async () => {
    mockResolveChatAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('refuses NO ANCHOR with the same collapsed literal', async () => {
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      scope: MEETING_SCOPE,
      anchor: null,
      meetingId: MEETING_ID,
    });
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
  });

  /**
   * ⚠⚠ THE SCOPE ASSERTION IS THE POINT. Whatever `resolveMeetingChatAccess` returned as
   * `scope` is passed straight through — never `{ kind: 'meeting', … }` written inline here.
   */
  it('passes access.scope straight through to listMessagesPage — never re-derived', async () => {
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      scope: ENGAGEMENT_SCOPE,
      anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: null },
      meetingId: MEETING_ID,
    });
    await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(mockListMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: ENGAGEMENT_SCOPE })
    );
  });

  it('returns messages with no viewerUserId and no writable field', async () => {
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true, hasEarlier: false });
    expect(result).not.toHaveProperty('viewerUserId');
    expect(result).not.toHaveProperty('writable');
  });

  it('maps a repository throw to the collapsed literal and logs the shape', async () => {
    mockListMessagesPage.mockRejectedValue(new Error('db down'));
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` now runs INSIDE the `try`, so
   * a throw FROM THE RESOLVER ITSELF is logged and collapsed too, rather than escaping.
   */
  it('maps a throw FROM resolveMeetingGuestSubject itself to the collapsed literal', async () => {
    mockResolveSubject.mockRejectedValue(new Error('resolver blew up'));
    const result = await fetchGuestMeetingThreadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });
});
