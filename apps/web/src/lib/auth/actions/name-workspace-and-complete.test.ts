import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────

const { mockUpdateName, mockPromote, mockFindById, mockUsersUpdate, mockPublish, mockEmitOrg } =
  vi.hoisted(() => ({
    mockUpdateName: vi.fn(),
    mockPromote: vi.fn(),
    mockFindById: vi.fn(),
    mockUsersUpdate: vi.fn(),
    mockPublish: vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve()),
    mockEmitOrg: vi.fn(),
  }));

vi.mock('@balo/db', () => ({
  companiesRepository: { updateName: mockUpdateName, promoteToOrganization: mockPromote },
  usersRepository: { findById: mockFindById, update: mockUsersUpdate },
}));

// `@balo/shared/domains` runs for REAL (never the session copy): gmail.com →
// freemail, acme.io → corporate. Only the DB email drives the promote gate.
vi.mock('@/lib/notifications/publish', () => ({ publishNotificationEvent: mockPublish }));
vi.mock('@/lib/analytics/org-intent', () => ({ emitOrgCreatedAtIntent: mockEmitOrg }));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { nameWorkspaceAndCompleteAction } from './name-workspace-and-complete';

const RETRYABLE = "We couldn't save that just now. Please try again.";

// ── Tests ───────────────────────────────────────────────────────

describe('nameWorkspaceAndCompleteAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateName.mockResolvedValue({ id: 'company-1', name: 'Acme Corp' });
    mockUsersUpdate.mockResolvedValue({});
    mockPublish.mockResolvedValue(undefined);
    mockSave.mockResolvedValue(undefined);
    // DEFAULT: freemail + verified → the personal-rename path (keeps the guard /
    // success-path suites unchanged). Corporate cases override per-test.
    mockFindById.mockResolvedValue({ id: 'user-1', email: 'jane@gmail.com', emailVerified: true });
    mockSessionObj = {
      user: {
        id: 'user-1',
        companyId: 'company-1',
        companyName: 'Personal Workspace',
        companyRole: 'owner',
        activeMode: 'client',
        onboardingCompleted: false,
      },
      save: mockSave,
    };
  });

  describe('input validation', () => {
    it('rejects an empty / whitespace-only name without touching the DB', async () => {
      const result = await nameWorkspaceAndCompleteAction('   ');
      expect(result).toEqual({ success: false, error: 'Enter a name for your workspace' });
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockPromote).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
    });

    it('rejects a name longer than 120 characters', async () => {
      const result = await nameWorkspaceAndCompleteAction('a'.repeat(121));
      expect(result).toEqual({ success: false, error: 'That name is too long' });
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
    });
  });

  describe('authentication guards', () => {
    it('returns Unauthorized when there is no session user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
    });

    it('rejects when onboarding is already completed', async () => {
      (mockSessionObj.user as Record<string, unknown>).onboardingCompleted = true;
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Onboarding already completed' });
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
    });

    it('rejects a non-owner member without touching the DB (least-privilege)', async () => {
      (mockSessionObj.user as Record<string, unknown>).companyRole = 'member';
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockPromote).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
    });
  });

  describe('personal workspace path (freemail / unverified)', () => {
    it('renames the company with the trimmed name (freemail default)', async () => {
      await nameWorkspaceAndCompleteAction('  Acme Corp  ');
      expect(mockUpdateName).toHaveBeenCalledWith('company-1', 'Acme Corp');
      expect(mockPromote).not.toHaveBeenCalled();
    });

    it('completes onboarding in client mode', async () => {
      await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(mockUsersUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
    });

    it('refreshes the session and saves it, then returns the dashboard redirect', async () => {
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.onboardingCompleted).toBe(true);
      expect(user.activeMode).toBe('client');
      expect(user.companyName).toBe('Acme Corp'); // sourced from the returned row
      expect(mockSave).toHaveBeenCalledOnce();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });

    it('stays personal (never promotes) for a VERIFIED CORPORATE email that is nonetheless unverified-gated', async () => {
      // Corporate domain but the DB says the email is NOT verified → stays personal.
      mockFindById.mockResolvedValue({ id: 'user-1', email: 'a@acme.io', emailVerified: false });

      const result = await nameWorkspaceAndCompleteAction('Acme');

      expect(mockPromote).not.toHaveBeenCalled();
      expect(mockUpdateName).toHaveBeenCalledWith('company-1', 'Acme');
      expect(mockEmitOrg).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });

    it('does not emit or publish anything on the freemail path', async () => {
      await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(mockEmitOrg).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('corporate + verified → promote to organization', () => {
    beforeEach(() => {
      mockFindById.mockResolvedValue({ id: 'user-1', email: 'a@acme.io', emailVerified: true });
    });

    it('promotes with the extracted domain and does NOT call updateName', async () => {
      mockPromote.mockResolvedValue({
        outcome: 'promoted',
        company: { id: 'company-1', name: 'Acme' },
      });

      const result = await nameWorkspaceAndCompleteAction('Acme');

      expect(mockPromote).toHaveBeenCalledWith({
        companyId: 'company-1',
        name: 'Acme',
        domain: 'acme.io',
        actorUserId: 'user-1',
      });
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });

    it('emits org_created_at_intent and publishes company.provisioned (post-commit)', async () => {
      mockPromote.mockResolvedValue({
        outcome: 'promoted',
        company: { id: 'company-1', name: 'Acme' },
      });

      await nameWorkspaceAndCompleteAction('Acme');

      expect(mockEmitOrg).toHaveBeenCalledWith('company', 'corporate', 'user-1');
      expect(mockPublish).toHaveBeenCalledWith('company.provisioned', {
        correlationId: 'company-1',
        companyId: 'company-1',
        ownerUserId: 'user-1',
      });
    });

    it('caches the promoted org name in the session and completes onboarding', async () => {
      mockPromote.mockResolvedValue({
        outcome: 'promoted',
        company: { id: 'company-1', name: 'Acme' },
      });

      await nameWorkspaceAndCompleteAction('Acme');

      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.companyName).toBe('Acme');
      expect(user.onboardingCompleted).toBe(true);
      expect(user.activeMode).toBe('client');
      expect(mockUsersUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
      expect(mockSave).toHaveBeenCalledOnce();
    });

    it('same-type conflict → retryable error, nothing changed (no completion)', async () => {
      mockPromote.mockResolvedValue({ outcome: 'domain_conflict_same_type' });

      const result = await nameWorkspaceAndCompleteAction('Acme');

      expect(result).toEqual({ success: false, error: RETRYABLE });
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockEmitOrg).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('other-type conflict → falls back to a personal rename (stays personal, no error)', async () => {
      mockPromote.mockResolvedValue({ outcome: 'domain_conflict_other_type' });

      const result = await nameWorkspaceAndCompleteAction('Acme');

      expect(mockUpdateName).toHaveBeenCalledWith('company-1', 'Acme');
      expect(mockEmitOrg).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });

    it('swallows a notification publish rejection — promote still succeeds', async () => {
      mockPromote.mockResolvedValue({
        outcome: 'promoted',
        company: { id: 'company-1', name: 'Acme' },
      });
      mockPublish.mockRejectedValue(new Error('publish boom'));

      const result = await nameWorkspaceAndCompleteAction('Acme');

      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
      expect(mockEmitOrg).toHaveBeenCalledWith('company', 'corporate', 'user-1');
    });
  });

  describe('error handling', () => {
    it('returns retryable and does NOT complete when the authoritative user row is missing', async () => {
      mockFindById.mockResolvedValue(undefined);

      const result = await nameWorkspaceAndCompleteAction('Acme Corp');

      expect(result).toEqual({ success: false, error: RETRYABLE });
      expect(mockPromote).not.toHaveBeenCalled();
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns a retryable error and logs when the rename throws', async () => {
      mockUpdateName.mockRejectedValue(new Error('DB error'));
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: RETRYABLE });
      expect(mockSave).not.toHaveBeenCalled();
      expect(vi.mocked(log.error)).toHaveBeenCalled();
    });
  });
});
