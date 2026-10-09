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

const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const APPLICANT_ID = 'b0000000-0000-4000-8000-000000000002';
const AUDIT_ID = 'b0000000-0000-4000-8000-000000000003';
const NOTE_TEXT = 'The certifications listed could not be verified against the issuer.';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockDecideApplication, mockPlatformSettingsGet } = vi.hoisted(() => ({
  mockDecideApplication: vi.fn(),
  mockPlatformSettingsGet: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { decideApplication: (...a: unknown[]) => mockDecideApplication(...a) },
  platformSettingsRepository: { get: (...a: unknown[]) => mockPlatformSettingsGet(...a) },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { DECLINE_NOTE_MIN_LENGTH } from '../_lib/decline-copy';
import { declineExpertApplicationAction } from './decline-expert-application';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import { reapplyAvailableAt } from '@balo/shared/experts';
import { formatLongUtc } from '@/lib/format/utc-date';

const ADMIN = { id: 'admin-1', firstName: 'Dana', lastName: null, platformRole: 'admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };
const SUBMITTED_AT = new Date('2026-01-01T00:00:00.000Z');
const DECIDED_AT = new Date('2026-01-08T00:00:00.000Z');

const VALID_INPUT = {
  expertProfileId: PROFILE_ID,
  reason: 'credentials_unverified' as const,
  note: NOTE_TEXT,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockDecideApplication.mockResolvedValue({
    outcome: 'decided',
    profile: { decidedAt: DECIDED_AT },
    previousStatus: 'submitted',
    applicantUserId: APPLICANT_ID,
    submittedAt: SUBMITTED_AT,
    auditEventId: AUDIT_ID,
  });
  // N mocked as 30, so the "call-time read" test can prove the live value (not a hard-coded 60)
  // drives the published date.
  mockPlatformSettingsGet.mockResolvedValue({ value: 30, source: 'stored' });
});

describe('declineExpertApplicationAction', () => {
  it('refuses a signed-out caller with the generic denial and never calls the repository', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await declineExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('denied');
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('refuses a caller WITHOUT review_expert_applications, with the SAME string as the signed-out arm', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const signedOut = await declineExpertApplicationAction(VALID_INPUT);
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    const notHolder = await declineExpertApplicationAction(VALID_INPUT);
    expect(signedOut.success).toBe(false);
    expect(notHolder.success).toBe(false);
    if (!signedOut.success && !notHolder.success) {
      expect(notHolder.error).toBe(signedOut.error);
    }
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  /*
    FIX ROUND F11 — THE TOKEN-IDENTITY PIN LIVES IN
    `_shared/require-application-reviewer.test.ts`, NOT HERE.

    A test at this level cannot discriminate the two tokens: both are in
    `PLATFORM_STAFF_BUNDLE`, so no `platformRole` string holds one without the other, and a
    role-driven "resolves REVIEW_EXPERT_APPLICATIONS, not VIEW_PLATFORM_ADMIN" case stays green
    under exactly the mutation it names. The version that used to sit here was that test; it has
    been replaced by an ARGUMENT assertion on the shared helper both actions call.
  */

  it('rejects an unknown key (.strict)', async () => {
    const result = await declineExpertApplicationAction({
      ...VALID_INPUT,
      // @ts-expect-error — deliberately malformed input for the strict-schema test
      hax: 1,
    });
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  /**
   * FIX ROUND F14 — THE SHEET AND THE SERVER SHARE ONE NUMBER, STRUCTURALLY.
   *
   * Both bounds are expressed in terms of `DECLINE_NOTE_MIN_LENGTH`, the same constant the
   * sheet enables Confirm on. MUTATION-PROVEN: hard-code `.min(20)` in the action's schema and
   * the "exactly at the minimum" case goes red; hard-code `.min(1)` and the "one short" case
   * does. Either mutation used to leave the whole suite green.
   */
  it('rejects a note one character short of DECLINE_NOTE_MIN_LENGTH', async () => {
    const result = await declineExpertApplicationAction({
      ...VALID_INPUT,
      note: 'x'.repeat(DECLINE_NOTE_MIN_LENGTH - 1),
    });
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('accepts a note of exactly DECLINE_NOTE_MIN_LENGTH — the length the sheet enables Confirm at', async () => {
    const result = await declineExpertApplicationAction({
      ...VALID_INPUT,
      note: 'x'.repeat(DECLINE_NOTE_MIN_LENGTH),
    });
    expect(result.success).toBe(true);
    expect(mockDecideApplication).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'x'.repeat(DECLINE_NOTE_MIN_LENGTH) })
    );
  });

  it('rejects a note over 2000 characters', async () => {
    const result = await declineExpertApplicationAction({
      ...VALID_INPUT,
      note: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('rejects an invented reason', async () => {
    const result = await declineExpertApplicationAction({
      ...VALID_INPUT,
      // @ts-expect-error — deliberately malformed input for the enum test
      reason: 'not-a-real-reason',
    });
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('maps not_pending to code not_pending, and not_found to code gone', async () => {
    mockDecideApplication.mockResolvedValue({ outcome: 'not_pending', currentStatus: 'rejected' });
    const notPending = await declineExpertApplicationAction(VALID_INPUT);
    expect(notPending.success).toBe(false);
    if (!notPending.success) expect(notPending.code).toBe('not_pending');

    mockDecideApplication.mockResolvedValue({ outcome: 'not_found' });
    const gone = await declineExpertApplicationAction(VALID_INPUT);
    expect(gone.success).toBe(false);
    if (!gone.success) expect(gone.code).toBe('gone');
  });

  it('publishes expert.application_declined with a compound colon-free correlationId containing the audit id', async () => {
    await declineExpertApplicationAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, payload] = mockPublish.mock.calls[0] as [string, { correlationId: string }];
    expect(payload.correlationId).toMatch(
      /^expert-application-declined\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/
    );
    expect(payload.correlationId).not.toContain(':');
    expect(payload.correlationId).toContain(AUDIT_ID);
  });

  it('the decline publish payload has NO note field', async () => {
    await declineExpertApplicationAction(VALID_INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(
      ['correlationId', 'expertProfileId', 'reapplyAvailableDate', 'reason', 'userId'].sort()
    );
  });

  /**
   * The cooldown is read at CALL TIME, not hard-coded. `platformSettingsRepository.get` is
   * mocked to 30 here (the default-60 registry value would make this test pass even on a
   * hard-coded 30 OR a hard-coded 60 picked at random, so the suite also pins 30 explicitly).
   */
  it('publishes reapplyAvailableDate computed from the call-time cooldown read', async () => {
    mockPlatformSettingsGet.mockResolvedValue({ value: 30, source: 'stored' });
    await declineExpertApplicationAction(VALID_INPUT);
    expect(mockPlatformSettingsGet).toHaveBeenCalledWith('expert_reapply_cooldown_days');
    const [, payload] = mockPublish.mock.calls[0] as [string, { reapplyAvailableDate: string }];
    const expected = formatLongUtc(reapplyAvailableAt(DECIDED_AT, 30) ?? DECIDED_AT);
    expect(payload.reapplyAvailableDate).toBe(expected);
  });

  /**
   * MUTATION-PROOF (contract): revert the action to omit the cooldown read (hard-code the
   * published date to today, or any fixed N) and this goes red, because 30 and 7 disagree.
   */
  it('a different cooldown value produces a different published date', async () => {
    mockPlatformSettingsGet.mockResolvedValue({ value: 7, source: 'stored' });
    await declineExpertApplicationAction(VALID_INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, { reapplyAvailableDate: string }];
    const expectedFor7 = formatLongUtc(reapplyAvailableAt(DECIDED_AT, 7) ?? DECIDED_AT);
    const expectedFor30 = formatLongUtc(reapplyAvailableAt(DECIDED_AT, 30) ?? DECIDED_AT);
    expect(payload.reapplyAvailableDate).toBe(expectedFor7);
    expect(payload.reapplyAvailableDate).not.toBe(expectedFor30);
  });

  it('log.info for a decline records the reason but NEVER the note', async () => {
    await declineExpertApplicationAction(VALID_INPUT);
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(NOTE_TEXT);
    expect(log.info).toHaveBeenCalledWith(
      'Expert application declined',
      expect.objectContaining({ reason: 'credentials_unverified' })
    );
  });

  it('does not publish when the repository returns not_pending or not_found', async () => {
    mockDecideApplication.mockResolvedValue({ outcome: 'not_pending', currentStatus: 'rejected' });
    await declineExpertApplicationAction(VALID_INPUT);
    expect(mockPublish).not.toHaveBeenCalled();

    mockDecideApplication.mockResolvedValue({ outcome: 'not_found' });
    await declineExpertApplicationAction(VALID_INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs and revalidates on success', async () => {
    const result = await declineExpertApplicationAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith('/admin/applications');
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/applications/${PROFILE_ID}`);
    expect(result).toEqual({
      success: true,
      analytics: {
        decision: 'declined',
        days_waiting: expect.any(Number),
        reason: 'credentials_unverified',
      },
      decidedByLabel: 'Dana @ Balo',
    });
  });

  it('log.error fires and a generic failure is returned when the repository throws', async () => {
    mockDecideApplication.mockRejectedValue(new Error('DB down'));
    const result = await declineExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to decline expert application',
      expect.objectContaining({
        expertProfileId: PROFILE_ID,
        actorUserId: ADMIN.id,
        error: 'DB down',
      })
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(NOTE_TEXT);
  });

  /**
   * The cooldown read happens BEFORE the decline commits: a read failure must fail before any
   * write, so a retry still finds the application pending rather than already declined with no
   * notification sent.
   */
  it('reads the cooldown setting before deciding, and never decides when that read rejects', async () => {
    mockPlatformSettingsGet.mockRejectedValue(new Error('settings unavailable'));
    const result = await declineExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
