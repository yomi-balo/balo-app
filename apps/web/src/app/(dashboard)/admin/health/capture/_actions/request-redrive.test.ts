import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-560 fix round 1 (security F2) — the LIVE-ROW platform gate this action now runs after its
 * synchronous session check. Mocked to GRANT by default, so every pre-existing case below still
 * exercises exactly what it did before: the session gate is still what decides them. The helper's
 * own behaviour (override revoked / widened / row suspended / non-staff role) is covered
 * exhaustively in `lib/authz/live-platform-capability.test.ts`; what the suites here pin is that
 * the action CALLS it and honours a denial.
 */
const mockActorHoldsLive = vi.fn<(userId: string, capability: string) => Promise<boolean>>(
  async () => true
);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: string) =>
    mockActorHoldsLive(userId, capability),
}));

const { mockRequireOnboardedUser, mockRequestAdminRedrive } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockRequestAdminRedrive: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/api/admin-redrive', () => ({ requestAdminRedrive: mockRequestAdminRedrive }));

import { requestRedrive } from './request-redrive';

const SUPER_ADMIN = { id: 'user_1', platformRole: 'super_admin', onboardingCompleted: true };
const RECORDING_ID = '11111111-1111-4111-8111-111111111111';

describe('requestRedrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a platform admin (not super_admin) is refused, fail-closed, before any api call', async () => {
    mockRequireOnboardedUser.mockResolvedValue({
      id: 'user_1',
      platformRole: 'admin',
      onboardingCompleted: true,
    });

    const result = await requestRedrive({ kind: 'recording-ingest', entityId: RECORDING_ID });

    expect(result).toEqual({
      success: false,
      reason: 'forbidden',
      error: 'You do not have permission to do this.',
    });
    expect(mockRequestAdminRedrive).not.toHaveBeenCalled();
  });

  it('super_admin succeeds, and the outcome carries the jobId', async () => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);
    mockRequestAdminRedrive.mockResolvedValue({
      ok: true,
      result: {
        kind: 'recording-ingest',
        entityId: RECORDING_ID,
        auditEventId: 'audit-1',
        jobId: 'recording-ingest--rec-1--redrive-audit-1',
      },
    });

    const result = await requestRedrive({ kind: 'recording-ingest', entityId: RECORDING_ID });

    expect(result).toEqual({ success: true, jobId: 'recording-ingest--rec-1--redrive-audit-1' });
    expect(mockRequestAdminRedrive).toHaveBeenCalledWith('recording-ingest', RECORDING_ID);
  });

  // ⚠ BAL-560/F2 — the cookie still grants; the LIVE row does not. A Server Action never runs
  // `checkSessionDrift`, so this is the only thing enforcing a revoked override on this path.
  it('BAL-560/F2: denies when the LIVE row has revoked the override', async () => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);
    mockActorHoldsLive.mockResolvedValueOnce(false);

    const result = await requestRedrive({ kind: 'recording-ingest', entityId: RECORDING_ID });

    expect(result).toMatchObject({ success: false, reason: 'forbidden' });
    expect(mockRequestAdminRedrive).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).toHaveBeenCalledWith(SUPER_ADMIN.id, 'redrive_job');
  });

  it('invalid input (unknown kind) is refused before any api call', async () => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);

    const result = await requestRedrive({ kind: 'not-a-kind', entityId: RECORDING_ID });

    expect(result).toEqual({
      success: false,
      reason: 'invalid',
      error: 'That re-drive request is not valid.',
    });
    expect(mockRequestAdminRedrive).not.toHaveBeenCalled();
  });

  it.each([
    ['not_redrivable', 'This row already moved — refresh the page to see its current state.'],
    [
      'enqueue_failed',
      'The re-drive was recorded but could not be queued. An engineer has been notified.',
    ],
    ['unavailable', 'Could not re-drive right now. Try again in a moment.'],
  ] as const)('maps api reason %s to its distinct copy', async (reason, expectedError) => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);
    mockRequestAdminRedrive.mockResolvedValue({ ok: false, reason });

    const result = await requestRedrive({ kind: 'recording-ingest', entityId: RECORDING_ID });

    expect(result).toEqual({ success: false, reason, error: expectedError });
  });

  it('an unexpected throw is caught, logged, and reports unavailable', async () => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);
    mockRequestAdminRedrive.mockRejectedValue(new Error('network down'));

    const result = await requestRedrive({ kind: 'recording-ingest', entityId: RECORDING_ID });

    expect(result).toEqual({
      success: false,
      reason: 'unavailable',
      error: 'Could not re-drive right now. Try again in a moment.',
    });
  });
});
