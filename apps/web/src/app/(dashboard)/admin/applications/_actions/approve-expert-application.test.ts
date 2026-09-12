import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const APPLICANT_ID = 'b0000000-0000-4000-8000-000000000002';
const AUDIT_ID = 'b0000000-0000-4000-8000-000000000003';

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

import { approveExpertApplicationAction } from './approve-expert-application';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', firstName: 'Dana', lastName: null, platformRole: 'admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };

const SUBMITTED_AT = new Date('2026-01-01T00:00:00.000Z');

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

describe('approveExpertApplicationAction', () => {
  it('refuses a signed-out caller with the generic denial and never calls the repository', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('denied');
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('refuses a caller WITHOUT review_expert_applications, with the SAME string as the signed-out arm', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const signedOut = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    const notHolder = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(signedOut.success).toBe(false);
    expect(notHolder.success).toBe(false);
    if (!signedOut.success && !notHolder.success) {
      expect(notHolder.error).toBe(signedOut.error);
    }
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('rejects an unknown key (.strict)', async () => {
    const result = await approveExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      // @ts-expect-error — deliberately malformed input for the strict-schema test
      hax: 1,
    });
    expect(result.success).toBe(false);
    expect(mockDecideApplication).not.toHaveBeenCalled();
  });

  it('maps not_pending to code not_pending, and not_found to code gone', async () => {
    mockDecideApplication.mockResolvedValue({ outcome: 'not_pending', currentStatus: 'approved' });
    const notPending = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(notPending.success).toBe(false);
    if (!notPending.success) expect(notPending.code).toBe('not_pending');

    mockDecideApplication.mockResolvedValue({ outcome: 'not_found' });
    const gone = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(gone.success).toBe(false);
    if (!gone.success) expect(gone.code).toBe('gone');
  });

  it('publishes expert.approved AFTER the repository resolves, with the audit id as correlationId and the repository-returned applicant user id', async () => {
    const calls: string[] = [];
    mockDecideApplication.mockImplementation(async () => {
      calls.push('repository');
      return {
        outcome: 'decided',
        profile: {},
        previousStatus: 'submitted',
        applicantUserId: APPLICANT_ID,
        submittedAt: SUBMITTED_AT,
        auditEventId: AUDIT_ID,
      };
    });
    mockPublish.mockImplementation(() => {
      calls.push('publish');
    });

    await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });

    expect(calls).toEqual(['repository', 'publish']);
    expect(mockPublish).toHaveBeenCalledWith('expert.approved', {
      correlationId: AUDIT_ID,
      userId: APPLICANT_ID,
      expertProfileId: PROFILE_ID,
    });
  });

  it('does not publish when the repository returns not_pending or not_found', async () => {
    mockDecideApplication.mockResolvedValue({ outcome: 'not_pending', currentStatus: 'approved' });
    await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(mockPublish).not.toHaveBeenCalled();

    mockDecideApplication.mockResolvedValue({ outcome: 'not_found' });
    await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs and revalidates on success, with days_waiting derived from submittedAt', async () => {
    const result = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(log.info).toHaveBeenCalledWith(
      'Expert application approved',
      expect.objectContaining({
        expertProfileId: PROFILE_ID,
        actorUserId: ADMIN.id,
        applicantUserId: APPLICANT_ID,
        auditEventId: AUDIT_ID,
      })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/admin/applications');
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/applications/${PROFILE_ID}`);
    expect(result).toEqual({
      success: true,
      analytics: { decision: 'approved', days_waiting: expect.any(Number) },
      decidedByLabel: 'Dana @ Balo',
    });
  });

  it('log.error fires and a generic failure is returned when the repository throws', async () => {
    mockDecideApplication.mockRejectedValue(new Error('DB down'));
    const result = await approveExpertApplicationAction({ expertProfileId: PROFILE_ID });
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to approve expert application',
      expect.objectContaining({
        expertProfileId: PROFILE_ID,
        actorUserId: ADMIN.id,
        error: 'DB down',
      })
    );
  });
});
