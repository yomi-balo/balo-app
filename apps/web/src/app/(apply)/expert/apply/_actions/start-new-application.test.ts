import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';
const VERTICAL_ID = 'vertical-1';
const AUDIT_EVENT_ID = 'a0000000-0000-4000-8000-00000000AUD1';

// ── Mocks ────────────────────────────────────────────────────────

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockReopenApplication = vi.fn();
const mockGetSalesforceVertical = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    reopenApplication: (...args: unknown[]) => mockReopenApplication(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { startNewApplicationAction } from './start-new-application';
import { revalidatePath } from 'next/cache';
import { reopenCooldownError } from './declined-application-copy';

// ── Tests ────────────────────────────────────────────────────────

describe('startNewApplicationAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = {
      user: { id: USER_ID, onboardingCompleted: true, email: 'test@example.com' },
      save: mockSave,
    };
    mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(startNewApplicationAction()).rejects.toThrow('Unauthorized');
      expect(mockReopenApplication).not.toHaveBeenCalled();
    });
  });

  describe('ownership — no caller-supplied identity', () => {
    it('resolves the applicant from the session, ignoring a stray argument', async () => {
      mockReopenApplication.mockResolvedValue({
        outcome: 'reopened',
        expertProfileId: PROFILE_ID,
        auditEventId: AUDIT_EVENT_ID,
        archivedDecisionId: 'decision-1',
        decidedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      // @ts-expect-error — exercising a caller that ignores the action's real (no-arg) signature.
      await startNewApplicationAction({ expertProfileId: 'someone-elses-profile' });

      expect(mockReopenApplication).toHaveBeenCalledWith({
        applicantUserId: USER_ID,
        verticalId: VERTICAL_ID,
        now: expect.any(Date),
      });
    });
  });

  describe('outcome mapping', () => {
    it('reopened → success, alreadyOpen:false, daysSinceDecision from the archived decidedAt', async () => {
      const now = new Date('2026-02-10T00:00:00.000Z');
      vi.useFakeTimers().setSystemTime(now);
      mockReopenApplication.mockResolvedValue({
        outcome: 'reopened',
        expertProfileId: PROFILE_ID,
        auditEventId: AUDIT_EVENT_ID,
        archivedDecisionId: 'decision-1',
        decidedAt: new Date('2026-02-01T00:00:00.000Z'), // 9 whole days before `now`
      });

      const result = await startNewApplicationAction();

      expect(result).toEqual({ success: true, alreadyOpen: false, daysSinceDecision: 9 });
      expect(revalidatePath).toHaveBeenCalledWith('/expert/apply');
      vi.useRealTimers();
    });

    it('not_rejected with currentStatus draft → alreadyOpen:true, not an error (double click / second tab)', async () => {
      mockReopenApplication.mockResolvedValue({ outcome: 'not_rejected', currentStatus: 'draft' });

      const result = await startNewApplicationAction();

      expect(result).toEqual({ success: true, alreadyOpen: true });
    });

    it('not_rejected with another status → failure, code not_rejected', async () => {
      mockReopenApplication.mockResolvedValue({
        outcome: 'not_rejected',
        currentStatus: 'submitted',
      });

      const result = await startNewApplicationAction();

      expect(result.success).toBe(false);
      expect(result).toMatchObject({ code: 'not_rejected' });
    });

    it('cooldown_active → failure, availableOn formatted, error from reopenCooldownError', async () => {
      mockReopenApplication.mockResolvedValue({
        outcome: 'cooldown_active',
        availableAt: new Date('2026-12-09T00:00:00.000Z'),
      });

      const result = await startNewApplicationAction();

      expect(result).toEqual({
        success: false,
        code: 'cooldown_active',
        availableOn: '9 Dec 2026',
        error: reopenCooldownError('9 Dec 2026'),
      });
    });

    it('not_found → failure, code not_found', async () => {
      mockReopenApplication.mockResolvedValue({ outcome: 'not_found' });

      const result = await startNewApplicationAction();

      expect(result).toEqual({
        success: false,
        code: 'not_found',
        error: 'We could not find an application to restart.',
      });
    });
  });

  describe('error handling', () => {
    it('returns a generic failure when the repository throws', async () => {
      mockReopenApplication.mockRejectedValue(new Error('DB connection failed'));

      const result = await startNewApplicationAction();

      expect(result).toEqual({
        success: false,
        code: 'failed',
        error: 'Something went wrong starting your new application. Please try again.',
      });
    });
  });
});
