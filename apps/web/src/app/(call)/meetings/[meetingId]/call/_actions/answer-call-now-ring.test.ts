import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireOnboardedUser,
  mockCredentialLive,
  mockPostAnswerRing,
  mockGetCallNowRing,
  mockResolveCaseAccess,
  mockLog,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockCredentialLive: vi.fn(),
  mockPostAnswerRing: vi.fn(),
  mockGetCallNowRing: vi.fn(),
  mockResolveCaseAccess: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/api/balo-api-client', () => ({ viewerApiCredentialIsLive: mockCredentialLive }));
vi.mock('@/lib/call-now/call-now-api-client', () => ({
  postAnswerRing: mockPostAnswerRing,
  getCallNowRing: mockGetCallNowRing,
}));
vi.mock('@/lib/cases/resolve-case-access', () => ({ resolveCaseAccess: mockResolveCaseAccess }));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { answerCallNowRingAction } from './answer-call-now-ring';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GRANT = { roomUrl: 'https://balo.daily.co/x', token: 'jwt', isOwner: false };

function refusal(status: number, code: string): Record<string, unknown> {
  return { ok: false, status, code, detail: { reason: null, suggestedTopUpMinor: null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockCredentialLive.mockResolvedValue(true);
  mockPostAnswerRing.mockResolvedValue({ ok: true, data: GRANT });
  mockGetCallNowRing.mockResolvedValue({
    ok: true,
    data: { engagementId: ENGAGEMENT_ID, meetingId: MEETING_ID },
  });
  mockResolveCaseAccess.mockResolvedValue({
    engagementId: ENGAGEMENT_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
});

describe('answerCallNowRingAction', () => {
  it('commits the ring and returns the join grant', async () => {
    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: true,
      grant: GRANT,
    });
    expect(mockPostAnswerRing).toHaveBeenCalledWith(RING_ID);
    expect(mockLog.info).toHaveBeenCalledWith('Call now answered', { ringId: RING_ID });
  });

  it('gates on an onboarded user before anything else', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(answerCallNowRingAction({ ringId: RING_ID })).rejects.toThrow('Unauthorized');
    expect(mockPostAnswerRing).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid ring id', { ringId: 'nope' }],
    ['an extra key', { ringId: RING_ID, inPlaceOfMeetingId: RING_ID }],
  ])('refuses %s as invalid without calling the api', async (_label, input) => {
    await expect(answerCallNowRingAction(input as { ringId: string })).resolves.toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(mockPostAnswerRing).not.toHaveBeenCalled();
  });

  it('⚠ refuses an impersonated session BEFORE the credential pre-flight, with no api call', async () => {
    mockRequireOnboardedUser.mockResolvedValue({
      id: USER_ID,
      isImpersonating: true,
      impersonatorUserId: 'staff-1',
    });

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'impersonation_refused',
    });
    expect(mockCredentialLive).not.toHaveBeenCalled();
    expect(mockPostAnswerRing).not.toHaveBeenCalled();
  });

  it('answers session_expired when the viewer credential is dead, with no api call', async () => {
    mockCredentialLive.mockResolvedValue(false);

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'session_expired',
    });
    expect(mockPostAnswerRing).not.toHaveBeenCalled();
  });

  it.each(['account_on_hold', 'booking_unfunded', 'booking_reserved'] as const)(
    '409 %s is a funding refusal carrying the case and the expert for the pre-flight',
    async (code) => {
      mockPostAnswerRing.mockResolvedValue(refusal(409, code));

      await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
        ok: false,
        code: 'funding',
        fundingCode: code,
        engagementId: ENGAGEMENT_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
    }
  );

  it('⚠ a funding refusal carries neither the ring’s meeting nor the api’s top-up figure', async () => {
    mockPostAnswerRing.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'booking_unfunded',
      detail: { suggestedTopUpMinor: 4500 },
    });

    const result = await answerCallNowRingAction({ ringId: RING_ID });

    expect(result).toMatchObject({ code: 'funding', expertProfileId: EXPERT_PROFILE_ID });
    expect(result).not.toHaveProperty('suggestedTopUpMinor');
    expect(result).not.toHaveProperty('meetingId');
  });

  it('a funding refusal whose case cannot be read is unavailable, never a half-built request', async () => {
    mockPostAnswerRing.mockResolvedValue(refusal(409, 'booking_unfunded'));
    mockResolveCaseAccess.mockResolvedValue(null);

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'unavailable',
    });
  });

  it('503 booking_funding_unavailable maps to funding_unavailable', async () => {
    mockPostAnswerRing.mockResolvedValue(refusal(503, 'booking_funding_unavailable'));

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'funding_unavailable',
    });
  });

  it('409 ring_not_ringing names the case so the room can go back to it', async () => {
    mockPostAnswerRing.mockResolvedValue(refusal(409, 'ring_not_ringing'));

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
  });

  it('ring_not_ringing without a readable ring still answers ring_not_ringing', async () => {
    mockPostAnswerRing.mockResolvedValue(refusal(409, 'ring_not_ringing'));
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'ring_not_ringing',
    });
  });

  it.each([
    [429, 'rate_limited', 'rate_limited'],
    [401, 'unauthenticated', 'session_expired'],
    [500, 'request_failed', 'failed'],
    [0, 'request_failed', 'failed'],
    [404, 'ring_not_found', 'unavailable'],
    [409, 'meeting_not_open_for_join', 'unavailable'],
  ] as const)('(%i, %s) → %s', async (status, code, expected) => {
    mockPostAnswerRing.mockResolvedValue(refusal(status, code));

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: expected,
    });
  });

  it('warns only on a refusal outside the known set', async () => {
    mockPostAnswerRing.mockResolvedValue(refusal(404, 'ring_not_found'));
    await answerCallNowRingAction({ ringId: RING_ID });
    expect(mockLog.warn).toHaveBeenCalledWith('Call now answer refused', {
      ringId: RING_ID,
      status: 404,
      code: 'ring_not_found',
    });

    mockLog.warn.mockClear();
    mockPostAnswerRing.mockResolvedValue(refusal(409, 'ring_not_ringing'));
    await answerCallNowRingAction({ ringId: RING_ID });
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('logs and answers failed when the hop throws', async () => {
    mockPostAnswerRing.mockRejectedValue(new Error('boom'));

    await expect(answerCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      code: 'failed',
    });
    expect(mockLog.error).toHaveBeenCalledWith(
      'Call now answer failed',
      expect.objectContaining({ ringId: RING_ID, error: 'boom' })
    );
  });
});
