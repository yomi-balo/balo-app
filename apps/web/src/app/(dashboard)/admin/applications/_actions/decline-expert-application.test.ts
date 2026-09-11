import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { mockDecideApplication } = vi.hoisted(() => ({ mockDecideApplication: vi.fn() }));
vi.mock('@balo/db', () => ({
  expertsRepository: { decideApplication: (...a: unknown[]) => mockDecideApplication(...a) },
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

const ADMIN = { id: 'admin-1', firstName: 'Dana', lastName: null, platformRole: 'admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };
const SUBMITTED_AT = new Date('2026-01-01T00:00:00.000Z');

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
    profile: {},
    previousStatus: 'submitted',
    applicantUserId: APPLICANT_ID,
    submittedAt: SUBMITTED_AT,
    auditEventId: AUDIT_ID,
  });
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
      ['correlationId', 'expertProfileId', 'reason', 'userId'].sort()
    );
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
});
