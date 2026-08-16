import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-437 — the in-call thread read.
 *
 * ⚠⚠ THE SCOPE ASSERTION IS THE POINT OF THIS FILE. `{ kind: 'full' }` is half of ruling R3: a
 * MEMBER in the call reads the whole engagement thread, not just what was said in this meeting.
 * The `{ kind: 'meeting' }` narrowing exists for GUESTS and belongs to BAL-445 — and because
 * `listMessagesPage`'s `scope` is a required parameter, the only way it could go wrong is a
 * caller passing the wrong one. So the argument is asserted, not the behaviour behind it.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MESSAGE_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CREATED_AT = new Date('2026-08-14T09:00:00.000Z');

const { mockRequireUser, mockResolveChatAccess, mockListMessagesPage } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockResolveChatAccess: vi.fn(),
  mockListMessagesPage: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: mockRequireUser }));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@balo/db', () => ({
  conversationsRepository: { listMessagesPage: mockListMessagesPage },
}));

import { fetchMeetingThreadAction } from './fetch-meeting-thread';

function row(id = MESSAGE_ID): Record<string, unknown> {
  return {
    id,
    conversationId: CONVERSATION_ID,
    body: '<p>Hello</p>',
    senderUserId: USER_ID,
    senderFirstName: 'Dana',
    senderLastName: 'Okoro',
    createdAt: CREATED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: USER_ID });
  mockResolveChatAccess.mockResolvedValue({
    ok: true,
    side: 'client',
    meetingId: MEETING_ID,
    anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: true },
  });
  mockListMessagesPage.mockResolvedValue({ messages: [row()], hasEarlier: false });
});

describe('fetchMeetingThreadAction — ⚠⚠ the read scope', () => {
  it('passes `{ kind: "full" }` — a MEMBER reads the whole thread, not just this call', async () => {
    await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(mockListMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION_ID, scope: { kind: 'full' } })
    );
  });

  it('⚠ never passes the guest `{ kind: "meeting" }` narrowing — that is BAL-445’s', async () => {
    await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    const [call] = mockListMessagesPage.mock.calls;
    expect((call?.[0] as { scope: { kind: string } }).scope.kind).not.toBe('meeting');
  });
});

describe('fetchMeetingThreadAction — the page', () => {
  it('maps rows through the shipped view mapper and reports the viewer + writability', async () => {
    const result = await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: true,
      hasEarlier: false,
      viewerUserId: USER_ID,
      writable: true,
      messages: [
        {
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          bodyHtml: '<p>Hello</p>',
          senderUserId: USER_ID,
          senderName: 'Dana Okoro',
          createdAtIso: CREATED_AT.toISOString(),
        },
      ],
    });
  });

  it('forwards the keyset cursor as a Date + id pair', async () => {
    await fetchMeetingThreadAction({
      meetingId: MEETING_ID,
      before: { createdAtIso: CREATED_AT.toISOString(), id: MESSAGE_ID },
    });

    expect(mockListMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ before: { createdAt: CREATED_AT, id: MESSAGE_ID } })
    );
  });

  it('⚠⚠ a CLOSED thread is still READ — `writable: false` is reported, not refused', async () => {
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      side: 'client',
      meetingId: MEETING_ID,
      anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: false },
    });

    const result = await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(result).toMatchObject({ success: true, writable: false });
    expect(mockListMessagesPage).toHaveBeenCalledTimes(1);
  });
});

describe('fetchMeetingThreadAction — refusals', () => {
  it('unauthenticated ⇒ the shipped literal', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));

    const result = await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('⚠ a DENIED gate and a NO-ANCHOR meeting answer the SAME literal', async () => {
    const denied = { ok: false, code: 'meeting_not_found' };
    const noAnchor = { ok: true, side: 'client', meetingId: MEETING_ID, anchor: null };

    mockResolveChatAccess.mockResolvedValueOnce(denied);
    const a = await fetchMeetingThreadAction({ meetingId: MEETING_ID });
    mockResolveChatAccess.mockResolvedValueOnce(noAnchor);
    const b = await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(a).toEqual({ success: false, error: 'This conversation is no longer available.' });
    expect(b).toEqual(a);
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('a bad cursor is refused by Zod before any read', async () => {
    const result = await fetchMeetingThreadAction({
      meetingId: MEETING_ID,
      before: { createdAtIso: 'yesterday', id: MESSAGE_ID },
    });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('a repository throw becomes friendly copy', async () => {
    mockListMessagesPage.mockRejectedValue(new Error('db down'));

    const result = await fetchMeetingThreadAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: false,
      error: 'Could not load this conversation. Please try again.',
    });
  });
});
