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

  describe('error handling', () => {
    it('returns a retryable error and logs when the request write throws', async () => {
      mockFindOrCreatePending.mockRejectedValue(new Error('DB error'));
      const result = await requestJoinCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      });
      expect(vi.mocked(log.error)).toHaveBeenCalled();
    });
  });
});
