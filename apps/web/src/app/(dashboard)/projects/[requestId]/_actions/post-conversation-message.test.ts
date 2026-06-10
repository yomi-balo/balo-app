import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000004';
const CREATED_AT = new Date('2026-06-10T10:00:00Z');

vi.mock('server-only', () => ({}));

const mockPostMessage = vi.fn();
const mockMarkThreadRead = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    postMessage: (...args: unknown[]) => mockPostMessage(...args),
    markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockPublishConversation = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  publishConversationEvent: (...args: unknown[]) => mockPublishConversation(...args),
}));

const mockPublishNotification = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotification(...args),
}));

import { postConversationMessageAction } from './post-conversation-message';
import { log } from '@/lib/logging';

const USER = {
  id: 'user-client',
  firstName: 'Dana',
  lastName: 'Whitfield',
  companyId: 'company-1',
  platformRole: 'user',
};

const ACCESS_OK = {
  ok: true,
  ctx: { lens: 'client' },
  request: { id: REQUEST_ID, title: 'CPQ implementation', createdByUserId: 'user-client' },
  relationship: { id: REL_ID, expertProfileId: EXPERT_PROFILE_ID },
  recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
};

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID, body: 'Hello Priya' };

describe('postConversationMessageAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(ACCESS_OK);
    mockPostMessage.mockImplementation((input: { body: string }) =>
      Promise.resolve({
        id: MESSAGE_ID,
        relationshipId: REL_ID,
        senderUserId: USER.id,
        body: input.body,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        deletedAt: null,
      })
    );
    mockMarkThreadRead.mockResolvedValue({ lastReadAt: CREATED_AT });
    mockPublishConversation.mockResolvedValue(undefined);
    mockPublishNotification.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid input (bad uuid)', async () => {
    const result = await postConversationMessageAction({
      ...VALID_INPUT,
      relationshipId: 'nope',
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('returns the access guard error verbatim on denial', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only bodies after sanitisation', async () => {
    const result = await postConversationMessageAction({ ...VALID_INPUT, body: '   \n\n ' });
    expect(result).toEqual({ success: false, error: 'Type a message first.' });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('rejects bodies over the plain-text limit', async () => {
    const result = await postConversationMessageAction({
      ...VALID_INPUT,
      body: 'a'.repeat(4001),
    });
    expect(result).toEqual({
      success: false,
      error: 'Keep your message under 4000 characters.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('persists sanitised HTML (entities escaped, paragraphs wrapped)', async () => {
    const result = await postConversationMessageAction({
      ...VALID_INPUT,
      body: '<script>alert(1)</script>\n\nNext line',
    });
    expect(result.success).toBe(true);
    const persisted = mockPostMessage.mock.calls[0]?.[0] as { body: string };
    expect(persisted.body).not.toContain('<script>');
    expect(persisted.body).toContain('&lt;script&gt;');
    expect(persisted.body).toContain('<p>Next line</p>');
  });

  it('returns the message view, publishes realtime + notification, and marks read', async () => {
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      message: {
        id: MESSAGE_ID,
        relationshipId: REL_ID,
        bodyHtml: '<p>Hello Priya</p>',
        senderUserId: USER.id,
        senderName: 'Dana Whitfield',
        createdAtIso: CREATED_AT.toISOString(),
      },
    });
    expect(mockPublishConversation).toHaveBeenCalledWith(
      REL_ID,
      'message',
      expect.objectContaining({ id: MESSAGE_ID })
    );
    expect(mockPublishNotification).toHaveBeenCalledWith(
      'project.message_posted',
      expect.objectContaining({
        correlationId: MESSAGE_ID,
        projectRequestId: REQUEST_ID,
        relationshipId: REL_ID,
        recipientRole: 'expert',
        expertProfileId: EXPERT_PROFILE_ID,
        recipientId: undefined,
        senderName: 'Dana Whitfield',
        preview: 'Hello Priya',
      })
    );
    expect(mockMarkThreadRead).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      userId: USER.id,
      at: CREATED_AT,
    });
    expect(log.info).toHaveBeenCalledWith('Conversation message posted', expect.any(Object));
  });

  it('routes the notification to the client when the sender is the expert', async () => {
    mockResolveAccess.mockResolvedValue({
      ...ACCESS_OK,
      ctx: { lens: 'expert' },
      recipient: { role: 'client', userId: 'user-client' },
    });
    await postConversationMessageAction(VALID_INPUT);
    expect(mockPublishNotification).toHaveBeenCalledWith(
      'project.message_posted',
      expect.objectContaining({
        recipientRole: 'client',
        recipientId: 'user-client',
        expertProfileId: undefined,
      })
    );
  });

  it('still succeeds when the notification publish rejects (fire-and-forget)', async () => {
    mockPublishNotification.mockRejectedValue(new Error('engine down'));
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('still succeeds when the read watermark write fails', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('db hiccup'));
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result.success).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      'Failed to advance read watermark after post',
      expect.any(Object)
    );
  });

  it('maps repo failures to a friendly error and logs', async () => {
    mockPostMessage.mockRejectedValue(new Error('insert failed'));
    const result = await postConversationMessageAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not send your message. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to post conversation message',
      expect.objectContaining({ error: 'insert failed' })
    );
  });
});
