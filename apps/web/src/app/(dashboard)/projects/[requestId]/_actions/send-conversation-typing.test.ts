import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PROJECT-REQUEST typing relay. ⚠⚠ Its gate is `readConversationAccess` — the same
 * `authorizeThread` core `postConversationMessageAction` runs — and never the writing variant,
 * which would mint a conversation row for a typing signal.
 */

vi.mock('server-only', () => ({}));

const {
  mockRequireOnboardedUser,
  mockReadAccess,
  mockResolveAccess,
  mockPublishTypingSignal,
  mockCheckSharedRateLimit,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockReadAccess: vi.fn(),
  mockResolveAccess: vi.fn(),
  mockPublishTypingSignal: vi.fn(),
  mockCheckSharedRateLimit: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  readConversationAccess: mockReadAccess,
  resolveConversationAccess: mockResolveAccess,
}));
vi.mock('@/lib/realtime/ably-server', () => ({ publishTypingSignal: mockPublishTypingSignal }));
vi.mock('@/lib/rate-limit/shared-counter', () => ({
  checkSharedRateLimit: mockCheckSharedRateLimit,
}));

import { sendConversationTypingAction } from './send-conversation-typing';
import { TYPING_DENIED } from '@/lib/realtime/relay-typing-signal';

const REQUEST_ID = 'a0000000-0000-4000-8000-00000000a001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-00000000a003';
const USER = { id: 'u0000000-0000-4000-8000-00000000a002' };
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000beef';
const INPUT = {
  requestId: REQUEST_ID,
  relationshipId: RELATIONSHIP_ID,
  signal: 'started' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockReadAccess.mockResolvedValue({ ok: true, conversationId: GATE_CONVERSATION_ID });
  mockPublishTypingSignal.mockResolvedValue(undefined);
  mockCheckSharedRateLimit.mockResolvedValue({ allowed: true });
});

describe('sendConversationTypingAction', () => {
  it('⚠⚠ publishes on the GATE’s conversation, as the session user', async () => {
    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: true });
    expect(mockReadAccess).toHaveBeenCalledWith(USER, REQUEST_ID, RELATIONSHIP_ID);
    expect(mockPublishTypingSignal).toHaveBeenCalledWith(GATE_CONVERSATION_ID, USER.id, 'started');
  });

  it('⚠⚠ never uses the WRITING gate — a typing signal must not mint a conversation', async () => {
    await sendConversationTypingAction(INPUT);

    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('a denied thread (wrong lens, other expert’s thread, closed) publishes nothing', async () => {
    // ⚠ The denial carries a conversation id here on purpose: the action must decide on `ok`,
    // never on whether an id happens to be present.
    mockReadAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access.',
      conversationId: GATE_CONVERSATION_ID,
    });

    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('an UNPROVISIONED thread publishes nothing — there is nobody subscribed to it', async () => {
    mockReadAccess.mockResolvedValue({ ok: true, conversationId: undefined });

    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('⚠ an IMPERSONATED session publishes nothing and reads nothing', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ ...USER, isImpersonating: true });

    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockReadAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('⚠⚠ throttled ⇒ TYPING_DENIED, and the read-access gate is not called', async () => {
    mockCheckSharedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockCheckSharedRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckSharedRateLimit).toHaveBeenCalledWith('typing-signal', USER);
    expect(mockReadAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller before any read', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await sendConversationTypingAction(INPUT);

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockReadAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['a free-text signal', { ...INPUT, signal: 'message' }],
    ['a missing relationship', { requestId: REQUEST_ID, signal: 'started' }],
    ['an extra key', { ...INPUT, conversationId: GATE_CONVERSATION_ID }],
  ])('rejects %s before any read', async (_label, input) => {
    const result = await sendConversationTypingAction(input as never);

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockReadAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });
});
