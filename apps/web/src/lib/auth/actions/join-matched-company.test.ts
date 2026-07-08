import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos, `@/lib/auth/session`, and the server-derivation helper are
// mocked so the action's own guards / fail-closed logic are exercised in
// isolation (`resolveActionableCompanyForSession` has its own unit test).
// `@/lib/logging` is globally mocked in test/setup.ts.

const { mockFindOrCreateMembership, mockUsersUpdate, mockResolveActionable } = vi.hoisted(() => ({
  mockFindOrCreateMembership: vi.fn(),
  mockUsersUpdate: vi.fn(),
  mockResolveActionable: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyMembershipsRepository: { findOrCreateDomainMembership: mockFindOrCreateMembership },
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

import { joinMatchedCompanyAction } from './join-matched-company';

// ── Tests ───────────────────────────────────────────────────────

describe('joinMatchedCompanyAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreateMembership.mockResolvedValue({ outcome: 'joined', membershipId: 'mem-1' });
    mockUsersUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    mockResolveActionable.mockResolvedValue({ partyId: 'company-1', mode: 'auto' });
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
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockResolveActionable).not.toHaveBeenCalled();
      expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
    });

    it('rejects when onboarding is already completed', async () => {
      (mockSessionObj.user as Record<string, unknown>).onboardingCompleted = true;
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({ success: false, error: 'Onboarding already completed' });
      expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed', () => {
    it('returns a retryable error and writes nothing when no actionable company is found', async () => {
      mockResolveActionable.mockResolvedValue(null);
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't add you to that workspace just now. Please try again.",
      });
      expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns a retryable error when the mode drifted to request (mode mismatch)', async () => {
      mockResolveActionable.mockResolvedValue({ partyId: 'company-1', mode: 'request' });
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't add you to that workspace just now. Please try again.",
      });
      expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('creates the membership with the server-derived party and self-actor (no client id path)', async () => {
      await joinMatchedCompanyAction();
      expect(mockFindOrCreateMembership).toHaveBeenCalledWith({
        partyType: 'company',
        partyId: 'company-1',
        userId: 'user-1',
        actorUserId: 'user-1',
      });
    });

    it('completes onboarding in client mode, saves the session, and returns the dashboard redirect', async () => {
      const result = await joinMatchedCompanyAction();
      expect(mockUsersUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.activeMode).toBe('client');
      expect(user.onboardingCompleted).toBe(true);
      expect(mockSave).toHaveBeenCalledOnce();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });

    it('treats an already_member outcome as success', async () => {
      mockFindOrCreateMembership.mockResolvedValue({
        outcome: 'already_member',
        membershipId: 'mem-1',
      });
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });
  });

  describe('error handling', () => {
    it('returns a retryable error and logs when the membership write throws (no session save)', async () => {
      mockFindOrCreateMembership.mockRejectedValue(new Error('DB error'));
      const result = await joinMatchedCompanyAction();
      expect(result).toEqual({
        success: false,
        error: "We couldn't add you to that workspace just now. Please try again.",
      });
      expect(mockSave).not.toHaveBeenCalled();
      expect(vi.mocked(log.error)).toHaveBeenCalled();
    });
  });
});
