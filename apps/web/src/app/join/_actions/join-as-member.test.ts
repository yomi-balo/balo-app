import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockPostMemberJoin = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@/lib/meetings/join-api-client', () => ({
  postMemberJoin: (...args: unknown[]) => mockPostMemberJoin(...args),
}));

import { joinAsMemberAction } from './join-as-member';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: true,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u555555555555455585555555555555555',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user-1', onboardingCompleted: true });
  mockPostMemberJoin.mockResolvedValue({ ok: true, data: GRANT });
});

describe('joinAsMemberAction — the onboarding gate', () => {
  it('⚠⚠ CALLS `requireOnboardedUser` — this is the arm that DOES gate', async () => {
    // Its two anonymous siblings deliberately do not, because their caller has no account by
    // definition. A member does, so the ordinary rule applies with no carve-out.
    await joinAsMemberAction({ meetingId: MEETING_ID });

    expect(mockRequireOnboardedUser).toHaveBeenCalled();
  });

  it('refuses a signed-out session WITHOUT calling the api', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(joinAsMemberAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: 'Please sign in and try again.',
    });
    expect(mockPostMemberJoin).not.toHaveBeenCalled();
  });

  it('refuses an UN-ONBOARDED session', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));

    const result = await joinAsMemberAction({ meetingId: MEETING_ID });

    expect(result.success).toBe(false);
    expect(mockPostMemberJoin).not.toHaveBeenCalled();
  });

  it('gates BEFORE validating — an unauthenticated caller learns nothing about shape', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    const result = await joinAsMemberAction({ meetingId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Please sign in and try again.' });
  });
});

describe('joinAsMemberAction — the grant', () => {
  it('returns the grant, isOwner included', async () => {
    await expect(joinAsMemberAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: true,
      grant: GRANT,
    });
  });

  it('⚠ NEVER sends an `isOwner` opinion — it only receives one', async () => {
    // A web-layer opinion about who may host, especially one derived from `activeMode` or a
    // lens, is the comparison ADR-1029 forbids. The api resolves it per actor from
    // `hasEngagementCapability(HOST_MEETINGS)`.
    await joinAsMemberAction({ meetingId: MEETING_ID });

    expect(mockPostMemberJoin).toHaveBeenCalledWith(MEETING_ID);
    expect(mockPostMemberJoin).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-uuid meeting id', async () => {
    const result = await joinAsMemberAction({ meetingId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockPostMemberJoin).not.toHaveBeenCalled();
  });
});

describe('joinAsMemberAction — failures', () => {
  it.each([
    ['meeting_not_found', 404],
    ['meeting_not_open_for_join', 409],
    ['meeting_not_provisioned', 409],
  ])('collapses `%s` into the uniform refusal', async (code, status) => {
    mockPostMemberJoin.mockResolvedValue({ ok: false, status, code });

    await expect(joinAsMemberAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: "This meeting isn't available to join.",
    });
  });

  it('⚠ distinguishes a 503 as RETRYABLE — an outage is a fact about us, not about the meeting', async () => {
    mockPostMemberJoin.mockResolvedValue({
      ok: false,
      status: 503,
      code: 'meeting_token_unavailable',
    });

    const result = await joinAsMemberAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: false,
      error: "We couldn't set up your call room just now. Please try again in a moment.",
    });
  });

  it('never echoes the api code or the meeting id', async () => {
    mockPostMemberJoin.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    const result = await joinAsMemberAction({ meetingId: MEETING_ID });

    expect(JSON.stringify(result)).not.toContain('meeting_not_found');
    expect(JSON.stringify(result)).not.toContain(MEETING_ID);
  });
});
