import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockCredentialLive = vi.fn();
vi.mock('@/lib/api/balo-api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/balo-api-client')>(
    '@/lib/api/balo-api-client'
  );
  return {
    isExpiredCredentialFailure: actual.isExpiredCredentialFailure,
    viewerApiCredentialIsLive: () => mockCredentialLive(),
  };
});

const mockPostStart = vi.fn();
vi.mock('@/lib/call-now/call-now-api-client', () => ({
  postStartCallNow: (...a: unknown[]) => mockPostStart(...a),
}));

import { startCallNowAction } from './start-call-now';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'm0000000-0000-4000-8000-000000000002';
const RING_ID = 'r0000000-0000-4000-8000-000000000003';
const IN_PLACE_ID = 'a0000000-0000-4000-8000-000000000004';

const USER = { id: 'u0000000-0000-4000-8000-000000000005' };

function refusal(status: number, code: string) {
  return { ok: false, status, code };
}

describe('startCallNowAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockCredentialLive.mockResolvedValue(true);
    mockPostStart.mockResolvedValue({
      ok: true,
      data: { ringId: RING_ID, meetingId: MEETING_ID, placement: 'new_meeting', expiresAt: 'x' },
    });
  });

  it('starts the call and returns the ids, logging the business event', async () => {
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: true,
      meetingId: MEETING_ID,
      ringId: RING_ID,
    });
    expect(mockPostStart).toHaveBeenCalledWith(ENGAGEMENT_ID, {});
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('Call now started', {
      engagementId: ENGAGEMENT_ID,
      meetingId: MEETING_ID,
      placement: 'new_meeting',
    });
  });

  it('sends the same-day meeting id when one is chosen', async () => {
    await startCallNowAction({ engagementId: ENGAGEMENT_ID, inPlaceOfMeetingId: IN_PLACE_ID });
    expect(mockPostStart).toHaveBeenCalledWith(ENGAGEMENT_ID, { inPlaceOfMeetingId: IN_PLACE_ID });
  });

  it.each([
    ['a missing id', {}],
    ['a non-uuid id', { engagementId: 'nope' }],
    ['an unknown key', { engagementId: ENGAGEMENT_ID, extra: true }],
    ['a non-uuid in-place id', { engagementId: ENGAGEMENT_ID, inPlaceOfMeetingId: 'x' }],
  ])('refuses %s as invalid without any api call', async (_label, input) => {
    await expect(startCallNowAction(input)).resolves.toEqual({ ok: false, code: 'invalid' });
    expect(mockPostStart).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session before the credential pre-flight and the api', async () => {
    mockRequireUser.mockResolvedValue({ ...USER, isImpersonating: true });
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: false,
      code: 'impersonation_refused',
    });
    expect(mockCredentialLive).not.toHaveBeenCalled();
    expect(mockPostStart).not.toHaveBeenCalled();
  });

  it('answers session_expired when the credential is dead, with no api call', async () => {
    mockCredentialLive.mockResolvedValue(false);
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: false,
      code: 'session_expired',
    });
    expect(mockPostStart).not.toHaveBeenCalled();
  });

  it.each([['account_on_hold'], ['booking_unfunded'], ['booking_reserved']])(
    'maps the 409 %s refusal to the funding step',
    async (fundingCode) => {
      mockPostStart.mockResolvedValue(refusal(409, fundingCode));
      await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
        ok: false,
        code: 'funding',
        fundingCode,
      });
    }
  );

  it.each([
    [503, 'booking_funding_unavailable', 'funding_unavailable'],
    [409, 'call_now_unavailable', 'unavailable'],
    [404, 'case_not_found', 'unavailable'],
    [400, 'in_place_not_allowed', 'invalid'],
    [409, 'in_place_not_eligible', 'in_place_not_eligible'],
    [503, 'venue_unavailable', 'venue_unavailable'],
    [429, 'rate_limited', 'rate_limited'],
    [401, 'token_expired', 'session_expired'],
  ])('maps %i %s to %s', async (status, code, expected) => {
    mockPostStart.mockResolvedValue(refusal(status, code));
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: false,
      code: expected,
    });
  });

  it('warns and answers failed for a refusal it does not know', async () => {
    mockPostStart.mockResolvedValue(refusal(500, 'something_new'));
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: false,
      code: 'failed',
    });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Call now start refused with an unrecognised code',
      expect.objectContaining({ code: 'something_new', status: 500 })
    );
  });

  it('logs the error and answers failed when the hop throws', async () => {
    mockPostStart.mockRejectedValue(new Error('network'));
    await expect(startCallNowAction({ engagementId: ENGAGEMENT_ID })).resolves.toEqual({
      ok: false,
      code: 'failed',
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'Call now start failed',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'network' })
    );
  });
});
