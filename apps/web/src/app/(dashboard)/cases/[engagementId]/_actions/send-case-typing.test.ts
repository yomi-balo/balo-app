import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CASE typing relay. ⚠⚠ Its gate must be `postCaseMessageAction`'s — `resolveCaseAccess`
 * plus `conversationWritable` — and the channel must come from the GATE, never from input: the
 * gate's conversation id shares no bytes with anything the caller sends.
 */

vi.mock('server-only', () => ({}));

const {
  mockRequireOnboardedUser,
  mockResolveCaseAccess,
  mockPublishTypingSignal,
  mockCheckSharedRateLimit,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockResolveCaseAccess: vi.fn(),
  mockPublishTypingSignal: vi.fn(),
  mockCheckSharedRateLimit: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/cases/resolve-case-access', () => ({ resolveCaseAccess: mockResolveCaseAccess }));
vi.mock('@/lib/realtime/ably-server', () => ({ publishTypingSignal: mockPublishTypingSignal }));
vi.mock('@/lib/rate-limit/shared-counter', () => ({
  checkSharedRateLimit: mockCheckSharedRateLimit,
}));

import { sendCaseTypingAction } from './send-case-typing';
import { TYPING_DENIED } from '@/lib/realtime/relay-typing-signal';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000a001';
const USER_ID = 'u0000000-0000-4000-8000-00000000a002';
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000beef';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue({
    conversationId: GATE_CONVERSATION_ID,
    conversationWritable: true,
  });
  mockPublishTypingSignal.mockResolvedValue(undefined);
  mockCheckSharedRateLimit.mockResolvedValue({ allowed: true });
});

describe('sendCaseTypingAction', () => {
  it.each(['started', 'stopped'] as const)(
    '⚠⚠ publishes `%s` on the GATE’s conversation, as the session user',
    async (signal) => {
      const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal });

      expect(result).toEqual({ success: true });
      expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
      expect(mockPublishTypingSignal).toHaveBeenCalledWith(GATE_CONVERSATION_ID, USER_ID, signal);
    }
  );

  it('⚠⚠ a CLOSED case (not writable) publishes nothing — typing needs the POST gate', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      conversationId: GATE_CONVERSATION_ID,
      conversationWritable: false,
    });

    const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('a denied gate publishes nothing, with the same literal as a closed case', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);

    const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('⚠ an IMPERSONATED session publishes nothing and reads nothing', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, isImpersonating: true });

    const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('⚠⚠ throttled ⇒ TYPING_DENIED, and the case-access gate is not called', async () => {
    mockCheckSharedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockCheckSharedRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckSharedRateLimit).toHaveBeenCalledWith('typing-signal', { id: USER_ID });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller before any read', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await sendCaseTypingAction({ engagementId: ENGAGEMENT_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it.each([
    ['a free-text signal', { engagementId: ENGAGEMENT_ID, signal: 'message' }],
    ['a non-uuid id', { engagementId: 'nope', signal: 'started' }],
    ['an extra key', { engagementId: ENGAGEMENT_ID, signal: 'started', conversationId: 'x' }],
  ])('rejects %s before any read', async (_label, input) => {
    const result = await sendCaseTypingAction(input as never);

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });
});
