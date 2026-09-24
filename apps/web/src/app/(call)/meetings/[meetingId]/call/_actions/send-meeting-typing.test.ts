import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The IN-CALL typing relay. ⚠⚠ Its gate is `postMeetingMessageAction`'s: `resolveMeetingChatAccess`
 * WITH writability, an anchor, and `writable === true` — `null` means NOT resolved, never open.
 */

vi.mock('server-only', () => ({}));

const { mockRequireOnboardedUser, mockResolveChatAccess, mockPublishTypingSignal } = vi.hoisted(
  () => ({
    mockRequireOnboardedUser: vi.fn(),
    mockResolveChatAccess: vi.fn(),
    mockPublishTypingSignal: vi.fn(),
  })
);
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@/lib/realtime/ably-server', () => ({ publishTypingSignal: mockPublishTypingSignal }));

import { sendMeetingTypingAction } from './send-meeting-typing';
import { TYPING_DENIED } from '@/lib/realtime/relay-typing-signal';

const MEETING_ID = 'f0000000-0000-4000-8000-00000000a001';
const USER_ID = 'u0000000-0000-4000-8000-00000000a002';
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000beef';

function anchored(writable: boolean | null): unknown {
  return { ok: true, anchor: { conversationId: GATE_CONVERSATION_ID, writable } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveChatAccess.mockResolvedValue(anchored(true));
  mockPublishTypingSignal.mockResolvedValue(undefined);
});

describe('sendMeetingTypingAction', () => {
  it('⚠⚠ publishes on the ANCHOR’s conversation, as the session user — never on meeting:{id}', async () => {
    const result = await sendMeetingTypingAction({ meetingId: MEETING_ID, signal: 'started' });

    expect(result).toEqual({ success: true });
    expect(mockPublishTypingSignal).toHaveBeenCalledWith(GATE_CONVERSATION_ID, USER_ID, 'started');
  });

  it('⚠ runs the gate WITH writability — the post gate, not the token action’s cheaper read', async () => {
    await sendMeetingTypingAction({ meetingId: MEETING_ID, signal: 'started' });

    const [call] = mockResolveChatAccess.mock.calls;
    const [args] = call ?? [];
    expect(args).toEqual({ meetingId: MEETING_ID, actor: { kind: 'member', userId: USER_ID } });
    expect(args).not.toHaveProperty('withWritability');
  });

  it.each([
    ['a denied gate', { ok: false }],
    ['a meeting with no thread anchor', { ok: true, anchor: null }],
    ['a read-only thread', anchored(false)],
    ['an UNRESOLVED writability (null means not writable)', anchored(null)],
  ])('%s publishes nothing, with the one denial literal', async (_label, access) => {
    mockResolveChatAccess.mockResolvedValue(access);

    const result = await sendMeetingTypingAction({ meetingId: MEETING_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller (including every guest) before any read', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await sendMeetingTypingAction({ meetingId: MEETING_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
  });

  it('⚠ an IMPERSONATED session publishes nothing and reads nothing', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, isImpersonating: true });

    const result = await sendMeetingTypingAction({ meetingId: MEETING_ID, signal: 'started' });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it.each([
    ['a free-text signal', { meetingId: MEETING_ID, signal: 'message' }],
    ['a non-uuid meeting id', { meetingId: 'nope', signal: 'started' }],
    ['an extra key', { meetingId: MEETING_ID, signal: 'started', conversationId: 'x' }],
  ])('rejects %s before any read', async (_label, input) => {
    const result = await sendMeetingTypingAction(input as never);

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });
});
