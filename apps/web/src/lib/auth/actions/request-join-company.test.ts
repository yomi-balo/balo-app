import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repo, `@/lib/auth/session`, and the server-derivation helper are
// mocked so the action's guards / fail-closed logic are exercised in isolation.
// `@/lib/logging` is globally mocked in test/setup.ts.

const { mockFindOrCreatePending, mockUsersUpdate, mockResolveActionable } = vi.hoisted(() => ({
  mockFindOrCreatePending: vi.fn(),
  mockUsersUpdate: vi.fn(),
  mockResolveActionable: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyJoinRequestsRepository: { findOrCreatePending: mockFindOrCreatePending },
  usersRepository: { update: mockUsersUpdate },
}));

vi.mock('@/lib/domain-join/resolve-actionable-company', () => ({
  resolveActionableCompanyForSession: mockResolveActionable,
}));

// Detect-only engine → the FRESH-request notification + analytics are owned by
// THIS action (BAL-371 / S3). Both are mocked so the publish/count branches can be
// asserted in isolation.
const mockPublish = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const { mockEmitJoinRequestCreated } = vi.hoisted(() => ({ mockEmitJoinRequestCreated: vi.fn() }));
vi.mock('@/lib/analytics/party-join', () => ({
  emitJoinRequestCreated: (...a: unknown[]) => mockEmitJoinRequestCreated(...a),
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { requestJoinCompanyAction } from './request-join-company';

// ── Tests ───────────────────────────────────────────────────────

describe('requestJoinCompanyAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreatePending.mockResolvedValue({ outcome: 'created', request: { id: 'req-1' } });
    mockUsersUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    mockResolveActionable.mockResolvedValue({ partyId: 'company-1', mode: 'request' });
    mockSessionObj = {
      user: {
        id: 'user-1',
        email: 'founder@acme.io',
        activeMode: 'client',
        onboardingCompleted: false,
      },
      save: mockSave,
    };
  });

  describe('authentication guards', () => {
    it('returns Unauthorized when there is no session user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockResolveActionable).not.toHaveBeenCalled();
      expect(mockFindOrCreatePending).not.toHaveBeenCalled();
    });

    it('rejects when onboarding is already completed', async () => {
      (mockSessionObj.user as Record<string, unknown>).onboardingCompleted = true;
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({ success: false, error: 'Onboarding already completed' });
      expect(mockFindOrCreatePending).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed', () => {
    it('returns a "nothing was changed" error when no actionable company is found', async () => {
      mockResolveActionable.mockResolvedValue(null);
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      });
      expect(mockFindOrCreatePending).not.toHaveBeenCalled();
    });

    it('returns a "nothing was changed" error when the mode is auto (mode mismatch)', async () => {
      mockResolveActionable.mockResolvedValue({ partyId: 'company-1', mode: 'auto' });
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      });
      expect(mockFindOrCreatePending).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('re-derives the actionable company from (session.user.id, session.user.email) — BAL-348', async () => {
      await requestJoinCompanyAction();
      expect(mockResolveActionable).toHaveBeenCalledWith('user-1', 'founder@acme.io');
    });

    it('files a pending request against the server-derived party and does NOT complete onboarding', async () => {
      const result = await requestJoinCompanyAction();
      expect(mockFindOrCreatePending).toHaveBeenCalledWith({
        partyType: 'company',
        partyId: 'company-1',
        userId: 'user-1',
      });
      expect(result).toEqual({ success: true, data: { status: 'pending' } });
      // The user is still waiting — onboarding is NOT completed here.
      expect(mockUsersUpdate).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('treats an already_pending outcome as success', async () => {
      mockFindOrCreatePending.mockResolvedValue({
        outcome: 'already_pending',
        request: { id: 'req-1' },
      });
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({ success: true, data: { status: 'pending' } });
    });
  });

  describe('notification + analytics', () => {
    it('publishes join_request_created and counts it on a FRESH request', async () => {
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({ success: true, data: { status: 'pending' } });
      expect(mockPublish).toHaveBeenCalledWith('party.join_request_created', {
        correlationId: 'req-1',
        partyType: 'company',
        partyId: 'company-1',
        userId: 'user-1',
      });
      expect(mockEmitJoinRequestCreated).toHaveBeenCalledWith('company', 'user-1');
    });

    it('does NOT publish or count on an idempotent already_pending re-consent', async () => {
      mockFindOrCreatePending.mockResolvedValue({
        outcome: 'already_pending',
        request: { id: 'req-1' },
      });
      const result = await requestJoinCompanyAction();
      // Still success (pending), but no re-notify / re-count.
      expect(result).toEqual({ success: true, data: { status: 'pending' } });
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockEmitJoinRequestCreated).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns a retryable error and logs when the request write throws', async () => {
      mockFindOrCreatePending.mockRejectedValue(new Error('DB error'));
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      });
      expect(vi.mocked(log.error)).toHaveBeenCalled();
      // A failed write must never publish or count a request.
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockEmitJoinRequestCreated).not.toHaveBeenCalled();
    });
  });
});
