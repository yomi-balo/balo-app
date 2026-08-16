import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-437 — the in-call Ably token endpoint.
 *
 * ⚠⚠ THE CLAIM THIS FILE EXISTS TO HOLD: the capability list is EXACTLY the channels this
 * actor's gate resolved — one when the meeting has no conversation anchor, two when it does —
 * and no member's grant is widened to make room for a future guest.
 *
 * ⚠ `mintSubscribeOnlyToken` IS **REAL** HERE, NOT MOCKED. Its subscribe-only / no-wildcard
 * assertions live in its own suite, but the CHANNEL LIST is this action's decision, and mocking
 * the minter would let a wrong list pass unnoticed. Only Ably itself is stubbed.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const {
  mockRequireOnboardedUser,
  mockResolveChatAccess,
  mockIsRealtimeConfigured,
  mockCreateTokenRequest,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockResolveChatAccess: vi.fn(),
  mockIsRealtimeConfigured: vi.fn(),
  mockCreateTokenRequest: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: mockIsRealtimeConfigured,
  getAblyRest: () => ({ auth: { createTokenRequest: mockCreateTokenRequest } }),
}));

import { createMeetingRealtimeTokenAction } from './create-meeting-realtime-token';

function capabilityKeys(): string[] {
  const [call] = mockCreateTokenRequest.mock.calls;
  const [params] = call ?? [];
  return Object.keys(
    JSON.parse((params as { capability: string }).capability) as Record<string, unknown>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockCreateTokenRequest.mockResolvedValue({ keyName: 'app.key', mac: 'sig' });
  mockResolveChatAccess.mockResolvedValue({
    ok: true,
    side: 'client',
    meetingId: MEETING_ID,
    anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: true },
  });
});

describe('createMeetingRealtimeTokenAction — ⚠⚠ the channel list', () => {
  it('grants BOTH channels when the meeting has a conversation anchor', async () => {
    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toMatchObject({ success: true });
    expect(capabilityKeys()).toEqual([`meeting:${MEETING_ID}`, `conversation:${CONVERSATION_ID}`]);
  });

  it('⚠⚠ grants EXACTLY the meeting channel when there is NO anchor — no placeholder', async () => {
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      side: 'client',
      meetingId: MEETING_ID,
      anchor: null,
    });

    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toMatchObject({ success: true });
    expect(capabilityKeys()).toEqual([`meeting:${MEETING_ID}`]);
  });

  it('⚠ the namespace is SINGULAR — `meeting:`, never `meetings:` (Ably matches literally)', async () => {
    await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(capabilityKeys()[0]).toMatch(/^meeting:/);
    expect(capabilityKeys()[0]).not.toMatch(/^meetings:/);
  });

  it('⚠⚠ subscribe-only, no wildcard — restated at the ACTION level', async () => {
    await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    const [call] = mockCreateTokenRequest.mock.calls;
    const serialised = (call?.[0] as { capability: string }).capability;
    expect(serialised).not.toContain('*');
    expect(serialised).not.toContain('publish');
    expect(serialised).not.toContain('presence');
  });

  /**
   * ⚠⚠ THE 15-MINUTE TTL IS ONLY A REAL BOUND ON A REVOKED MEMBERSHIP IF THE GATE IS RE-RUN.
   * ably-js re-invokes `authCallback` on every refresh, which re-enters this action — so what
   * has to be proved is that EVERY entry pays for the full tenancy decision, not that the gate
   * was called once. A single-call assertion would stay green under a module-level cache, which
   * is exactly the change that would silently turn the TTL into "until the process restarts".
   *
   * ⚠ `withWritability: false` IS PART OF THE PINNED CALL SHAPE, and it narrows the RESULT, never
   * the DECISION: it skips only the engagement arm's composer/lifecycle read (`anchor.writable`
   * comes back `null`), and the relationship arm's status read — the one that decides whether
   * there is an anchor to grant a `conversation:` channel for at all — is never skipped. That
   * split is pinned in `meeting-chat-anchor.test.ts`; asserting the flag here is what stops it
   * being quietly widened to skip the status read too.
   */
  it('re-runs the FULL gate on every call — which is what bounds a revoked membership', async () => {
    await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });
    await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(mockResolveChatAccess).toHaveBeenCalledTimes(2);
    for (const [args] of mockResolveChatAccess.mock.calls) {
      expect(args).toEqual({
        meetingId: MEETING_ID,
        userId: USER_ID,
        withWritability: false,
      });
    }
  });

  it('⚠⚠ a membership revoked BETWEEN refreshes is refused on the next one — the bound is real', async () => {
    await expect(
      createMeetingRealtimeTokenAction({ meetingId: MEETING_ID })
    ).resolves.toMatchObject({ success: true });

    // The revocation lands while the first token is still inside its TTL. The next refresh is
    // the first moment the platform gets to notice, and it must refuse rather than re-mint.
    mockResolveChatAccess.mockResolvedValue({ ok: false, code: 'not_a_participant' });
    mockCreateTokenRequest.mockClear();

    await expect(createMeetingRealtimeTokenAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: 'You do not have access to this call.',
    });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });
});

describe('createMeetingRealtimeTokenAction — refusals', () => {
  it('unauthenticated ⇒ the shipped literal, and no gate call', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
  });

  it('a non-uuid meetingId is refused by Zod before the gate', async () => {
    const result = await createMeetingRealtimeTokenAction({ meetingId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveChatAccess).not.toHaveBeenCalled();
  });

  it('⚠ a DENIED gate answers ONE literal — never which shape it was', async () => {
    mockResolveChatAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: 'You do not have access to this call.' });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('⚠ unconfigured ⇒ `{ disabled: true }` — a DEGRADATION, not a denial', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);

    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, disabled: true });
  });

  it('an unexpected throw becomes friendly copy, never a stack on the wire', async () => {
    mockResolveChatAccess.mockRejectedValue(new Error('db down'));

    const result = await createMeetingRealtimeTokenAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: 'Could not connect live updates.' });
  });
});
