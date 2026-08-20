import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

// `getChecklistStatus` is wrapped in React's `cache()`, which requires a
// request scope to run. In unit tests there is no such scope, so make `cache`
// a pass-through wrapper that returns the original function unchanged.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const mockLoadInputs = vi.fn();
const mockReconcileFromRead = vi.fn();

vi.mock('@balo/db', () => ({
  expertSearchabilityRepository: {
    loadInputs: (...args: unknown[]) => mockLoadInputs(...args),
  },
}));

vi.mock('@/lib/expert/searchability', () => ({
  reconcileFromRead: (...args: unknown[]) => mockReconcileFromRead(...args),
}));

// S2 (fix round 1) — `getChecklistStatus` now authenticates via `requireOnboardedUser()`
// (fail-closed) rather than a bare `getSession()` + hand-rolled checks. The mock reproduces the
// real function's contract (Unauthorized / Onboarding not completed / the user) closely enough
// that the pre-existing guard tests below still exercise the SAME three failure shapes.
let mockUserObj: Record<string, unknown> | null;

vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: vi.fn(() => {
    if (!mockUserObj) throw new Error('Unauthorized');
    if (mockUserObj.onboardingCompleted !== true) throw new Error('Onboarding not completed');
    return Promise.resolve(mockUserObj);
  }),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { getChecklistStatus } from './expert-checklist';
import { log } from '@/lib/logging';

// ── Helpers ──────────────────────────────────────────────────────

const EXPERT_USER = {
  id: 'user-1',
  email: 'expert@example.com',
  activeMode: 'expert',
  expertProfileId: 'profile-1',
  onboardingCompleted: true,
};

/** A snapshot where every checklist item is satisfied. */
function completeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      headline: 'Salesforce Architect',
      bio: 'Ten years building on the platform.',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      rateCents: 313,
      calendarConnections: [{ id: 'conn-1', credentialStatus: 'ACTIVE' }],
      hasActiveAvailabilityRules: true,
      hasPayoutDetails: true,
    },
    currentSearchable: false,
    rateCents: 313,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('getChecklistStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserObj = { ...EXPERT_USER };
    mockReconcileFromRead.mockResolvedValue({ changed: false });
    mockLoadInputs.mockResolvedValue(completeSnapshot());
  });

  describe('authentication & mode guards', () => {
    it('throws when there is no session user', async () => {
      mockUserObj = null;
      await expect(getChecklistStatus()).rejects.toThrow('Unauthorized');
      expect(mockLoadInputs).not.toHaveBeenCalled();
    });

    // S2 — `requireOnboardedUser()` is fail-closed on onboarding, which a bare `getSession()`
    // read never checked at this layer.
    it('throws Onboarding not completed for an un-onboarded session', async () => {
      mockUserObj = { ...EXPERT_USER, onboardingCompleted: false };
      await expect(getChecklistStatus()).rejects.toThrow('Onboarding not completed');
      expect(mockLoadInputs).not.toHaveBeenCalled();
    });

    it('throws when not in expert mode', async () => {
      mockUserObj = {
        id: 'user-1',
        activeMode: 'client',
        expertProfileId: 'profile-1',
        onboardingCompleted: true,
      };
      await expect(getChecklistStatus()).rejects.toThrow('Expert mode required');
      expect(mockLoadInputs).not.toHaveBeenCalled();
    });

    it('throws when there is no expertProfileId', async () => {
      mockUserObj = {
        id: 'user-1',
        activeMode: 'expert',
        expertProfileId: null,
        onboardingCompleted: true,
      };
      await expect(getChecklistStatus()).rejects.toThrow('Expert profile required');
      expect(mockLoadInputs).not.toHaveBeenCalled();
    });

    it('throws when the profile/user snapshot is not found', async () => {
      mockLoadInputs.mockResolvedValue(undefined);
      await expect(getChecklistStatus()).rejects.toThrow('Profile or user not found');
      expect(mockReconcileFromRead).not.toHaveBeenCalled();
    });

    // S4 — the scoped read: `loadInputs` must carry the session's own user id as the scoping
    // term, not just the expert profile id.
    it('scopes loadInputs to the session user id', async () => {
      await getChecklistStatus();
      expect(mockLoadInputs).toHaveBeenCalledWith('profile-1', undefined, { userId: 'user-1' });
    });
  });

  describe('read-path shape (T5.2) — unchanged for the 5-of-6 case', () => {
    it('counts 5 of 6 when only the weekly schedule is missing', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: { ...completeSnapshot().inputs, hasActiveAvailabilityRules: false },
        })
      );

      const status = await getChecklistStatus();

      expect(status.completedCount).toBe(5);
      expect(status.items).toEqual({
        profile: true,
        phone: true,
        rate: true,
        calendar: true,
        availability: false,
        payouts: true,
      });
      expect(status.allComplete).toBe(false);
      expect(status.rateCents).toBe(313);
    });
  });

  describe('D4 ANY-ACTIVE — calendar & availability signals', () => {
    it('marks calendar complete when at least one connection is ACTIVE', async () => {
      const status = await getChecklistStatus();
      expect(status.items.calendar).toBe(true);
    });

    it('marks calendar incomplete for a non-ACTIVE credential status (EXPIRED)', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: {
            ...completeSnapshot().inputs,
            calendarConnections: [{ id: 'conn-1', credentialStatus: 'EXPIRED' }],
          },
        })
      );
      const status = await getChecklistStatus();
      expect(status.items.calendar).toBe(false);
    });

    it('D4: an expired Google + a healthy Microsoft still marks calendar complete', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: {
            ...completeSnapshot().inputs,
            calendarConnections: [
              { id: 'g', credentialStatus: 'EXPIRED' },
              { id: 'm', credentialStatus: 'ACTIVE' },
            ],
          },
        })
      );
      const status = await getChecklistStatus();
      expect(status.items.calendar).toBe(true);
      expect(status.allComplete).toBe(true);
    });

    it('marks availability complete on active rules, independent of the calendar', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: {
            ...completeSnapshot().inputs,
            calendarConnections: [],
            hasActiveAvailabilityRules: true,
          },
        })
      );
      const status = await getChecklistStatus();
      expect(status.items.availability).toBe(true);
      expect(status.items.calendar).toBe(false);
    });
  });

  describe('T5.1 — read-path reconciliation, both directions (D1 symmetric)', () => {
    it('a complete checklist reconciles with allComplete true', async () => {
      await getChecklistStatus();

      expect(mockReconcileFromRead).toHaveBeenCalledWith({
        expertProfileId: 'profile-1',
        actorUserId: 'user-1',
        derivation: expect.objectContaining({ allComplete: true, failingItems: [] }),
        currentSearchable: false,
        actorImpersonating: false,
      });
    });

    it('a regression on a currently-searchable expert reconciles with allComplete false', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          currentSearchable: true,
          inputs: { ...completeSnapshot().inputs, hasPayoutDetails: false },
        })
      );

      await getChecklistStatus();

      expect(mockReconcileFromRead).toHaveBeenCalledWith({
        expertProfileId: 'profile-1',
        actorUserId: 'user-1',
        derivation: expect.objectContaining({ allComplete: false, failingItems: ['payouts'] }),
        currentSearchable: true,
        actorImpersonating: false,
      });
    });

    // S2 — audit-integrity: an impersonated session must flag itself through to the repository.
    it('flags actorImpersonating true when the viewing session is an admin impersonation', async () => {
      mockUserObj = { ...EXPERT_USER, isImpersonating: true };

      await getChecklistStatus();

      expect(mockReconcileFromRead).toHaveBeenCalledWith(
        expect.objectContaining({ actorImpersonating: true })
      );
    });

    it('a reconcile failure is caught and logged — the render still succeeds', async () => {
      mockReconcileFromRead.mockRejectedValue(new Error('db unavailable'));

      const status = await getChecklistStatus();

      expect(status.allComplete).toBe(true);
      expect(log.error).toHaveBeenCalledWith(
        'Expert searchability reconcile failed',
        expect.objectContaining({ expertProfileId: 'profile-1', userId: 'user-1' })
      );
    });
  });
});
