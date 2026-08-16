import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-437 — posting from the in-call composer.
 *
 * ⚠⚠ THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE is that `sentDuringMeetingId` reaches
 * `postMessage`. That one argument IS acceptance criterion #1 — it is what marks a message as
 * said during THIS call while still living in the engagement's durable thread — and it is the
 * only line that distinguishes this action from `postCaseMessageAction`, which explicitly
 * passes none.
 *
 * ⚠ THE SANITISER CHAIN (`plainMessageToHtml` → `sanitizeProjectHtml` → `htmlToPlainText`) IS
 * **REAL** HERE. It is the security boundary for stored HTML, and a mocked sanitiser proves
 * nothing. Only `@balo/db`, the session, the gate and the transport are mocked.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MESSAGE_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CREATED_AT = new Date('2026-08-14T09:00:00.000Z');

const {
  mockRequireOnboardedUser,
  mockResolveChatAccess,
  mockPostMessage,
  mockMarkThreadRead,
  mockPublishConversationEvent,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockResolveChatAccess: vi.fn(),
  mockPostMessage: vi.fn(),
  mockMarkThreadRead: vi.fn(),
  mockPublishConversationEvent: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    postMessage: mockPostMessage,
    markThreadRead: mockMarkThreadRead,
  },
}));
vi.mock('@/lib/realtime/ably-server', () => ({
  publishConversationEvent: (...args: unknown[]) => {
    mockPublishConversationEvent(...args);
    return Promise.resolve();
  },
}));

import { postMeetingMessageAction } from './post-meeting-message';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({
    id: USER_ID,
    firstName: 'Dana',
    lastName: 'Okoro',
  });
  mockResolveChatAccess.mockResolvedValue({
    ok: true,
    side: 'client',
    meetingId: MEETING_ID,
    anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: true },
  });
  mockPostMessage.mockResolvedValue({
    id: MESSAGE_ID,
    body: '<p>Hello</p>',
    createdAt: CREATED_AT,
  });
  mockMarkThreadRead.mockResolvedValue({});
});

describe('postMeetingMessageAction — ⚠⚠ the meeting stamp (acceptance criterion #1)', () => {
  it('passes `sentDuringMeetingId` EQUAL TO THE MEETING ID', async () => {
    await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        senderUserId: USER_ID,
        sentDuringMeetingId: MEETING_ID,
      })
    );
  });

  it('⚠ writes into the ENGAGEMENT’s conversation — never a per-meeting thread', async () => {
    await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    const [call] = mockPostMessage.mock.calls;
    expect((call?.[0] as { conversationId: string }).conversationId).toBe(CONVERSATION_ID);
  });
});

describe('postMeetingMessageAction — ⚠ the sanitiser boundary', () => {
  it('sanitises BEFORE persist — the stored body is the escaped HTML', async () => {
    await postMeetingMessageAction({
      meetingId: MEETING_ID,
      body: '<script>alert(1)</script> hi',
    });

    const [call] = mockPostMessage.mock.calls;
    const stored = (call?.[0] as { body: string }).body;
    expect(stored).not.toContain('<script>');
    expect(stored).toContain('hi');
  });

  it('refuses whitespace-only text after the strip', async () => {
    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: '   ' });

    expect(result).toEqual({ success: false, error: 'Type a message first.' });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('refuses over-limit PLAIN text, and Zod refuses the coarse raw bound', async () => {
    const overPlain = await postMeetingMessageAction({
      meetingId: MEETING_ID,
      body: 'a'.repeat(4001),
    });
    expect(overPlain).toMatchObject({ success: false });
    expect(overPlain.success === false ? overPlain.error : '').toMatch(/under 4000 characters/);

    const overRaw = await postMeetingMessageAction({
      meetingId: MEETING_ID,
      body: 'a'.repeat(20001),
    });
    expect(overRaw).toEqual({ success: false, error: 'Invalid request.' });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('postMeetingMessageAction — the transport and the post-commit block', () => {
  it('⚠⚠ publishes on the CONVERSATION channel, so the dashboard thread is not left stale', async () => {
    await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(mockPublishConversationEvent).toHaveBeenCalledTimes(1);
    const [conversationId, name, payload] = mockPublishConversationEvent.mock.calls[0] ?? [];
    expect(conversationId).toBe(CONVERSATION_ID);
    expect(name).toBe('message');
    expect(payload).toMatchObject({ id: MESSAGE_ID, conversationId: CONVERSATION_ID });
  });

  it('⚠ a `markThreadRead` throw does NOT fail the delivered message', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('watermark hiccup'));

    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toMatchObject({ success: true, message: { id: MESSAGE_ID } });
    expect(mockPublishConversationEvent).toHaveBeenCalledTimes(1);
  });

  it('returns the view model the panel appends optimistically', async () => {
    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toEqual({
      success: true,
      message: {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        bodyHtml: '<p>Hello</p>',
        senderUserId: USER_ID,
        senderName: 'Dana Okoro',
        createdAtIso: CREATED_AT.toISOString(),
      },
    });
  });
});

describe('postMeetingMessageAction — refusals', () => {
  it('unauthenticated ⇒ the shipped literal', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('⚠⚠ a CLOSED thread is refused with the SHIPPED case-surface sentence — one wording', async () => {
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      side: 'client',
      meetingId: MEETING_ID,
      anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: false },
    });

    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toEqual({
      success: false,
      error: 'This case is closed, so the conversation is read-only.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('a denied gate and a no-anchor meeting answer the same literal', async () => {
    mockResolveChatAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toEqual({
      success: false,
      error: 'This conversation is no longer available.',
    });
  });

  it('a persist throw becomes friendly copy and publishes nothing', async () => {
    mockPostMessage.mockRejectedValue(new Error('db down'));

    const result = await postMeetingMessageAction({ meetingId: MEETING_ID, body: 'Hello' });

    expect(result).toEqual({
      success: false,
      error: 'Could not send your message. Please try again.',
    });
    expect(mockPublishConversationEvent).not.toHaveBeenCalled();
  });
});
