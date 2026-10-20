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
const mockFindApprovalById = vi.fn();
const mockListBusyReadTargets = vi.fn();
const mockMarkLiveCelebrationSeen = vi.fn();

vi.mock('@balo/db', () => ({
  calendarRepository: {
    listBusyReadTargets: (...args: unknown[]) => mockListBusyReadTargets(...args),
  },
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
    markLiveCelebrationSeen: (...args: unknown[]) => mockMarkLiveCelebrationSeen(...args),
  },
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

const APPROVED_PROFILE = {
  id: 'profile-1',
  userId: 'user-1',
  approvedAt: new Date('2026-01-01T00:00:00Z'),
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
    availableForWork: true,
    username: 'dana',
    liveCelebrationSeenAt: null,
    ...overrides,
  };
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'c1',
    provider: 'google',
    endUserAccountId: 'acct-1',
    credentialStatus: 'ACTIVE',
    calendarIds: ['cal-1'],
    provisioned: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('getChecklistStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserObj = { ...EXPERT_USER };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE);
    mockReconcileFromRead.mockResolvedValue({ changed: false });
    mockLoadInputs.mockResolvedValue(completeSnapshot());
    mockListBusyReadTargets.mockResolvedValue([target()]);
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

    it('computes the checklist for an approved expert in client view', async () => {
      mockUserObj = { ...EXPERT_USER, activeMode: 'client' };
      const status = await getChecklistStatus();
      expect(status.allComplete).toBe(true);
      expect(mockLoadInputs).toHaveBeenCalled();
    });

    it('throws when the expert profile is not approved', async () => {
      mockFindApprovalById.mockResolvedValue({ ...APPROVED_PROFILE, approvedAt: null });
      await expect(getChecklistStatus()).rejects.toThrow('Expert profile required');
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
      expect(mockFindApprovalById).not.toHaveBeenCalled();
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

  describe('BAL-566 (R2) — calendarNeedsReconnect', () => {
    it('is false when every connection is ACTIVE', async () => {
      const status = await getChecklistStatus();
      expect(status.calendarNeedsReconnect).toBe(false);
    });

    it('is true when no connection is ACTIVE and one is EXPIRED', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: {
            ...completeSnapshot().inputs,
            calendarConnections: [{ id: 'conn-1', credentialStatus: 'EXPIRED' }],
          },
        })
      );
      const status = await getChecklistStatus();
      expect(status.calendarNeedsReconnect).toBe(true);
    });

    it('is false for an expert who never connected a calendar', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: { ...completeSnapshot().inputs, calendarConnections: [] },
        })
      );
      const status = await getChecklistStatus();
      expect(status.calendarNeedsReconnect).toBe(false);
    });

    it('is false when an EXPIRED connection sits beside a healthy ACTIVE one', async () => {
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
      expect(status.calendarNeedsReconnect).toBe(false);
    });
  });

  describe('BAL-591 — availableForWork', () => {
    it('carries the snapshot flag through, true by default', async () => {
      const status = await getChecklistStatus();
      expect(status.availableForWork).toBe(true);
    });

    it('is false for a paused expert, who is still fully set up', async () => {
      mockLoadInputs.mockResolvedValue(completeSnapshot({ availableForWork: false }));
      const status = await getChecklistStatus();
      expect(status.availableForWork).toBe(false);
      expect(status.allComplete).toBe(true);
      expect(status.completedCount).toBe(6);
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

    // BAL-553 — the impersonating staff member's own id, threaded alongside the boolean.
    it('flags actorImpersonatorUserId when the viewing session is an admin impersonation', async () => {
      mockUserObj = { ...EXPERT_USER, isImpersonating: true, impersonatorUserId: 'admin-1' };

      await getChecklistStatus();

      expect(mockReconcileFromRead).toHaveBeenCalledWith(
        expect.objectContaining({ actorImpersonatorUserId: 'admin-1' })
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

  describe('BAL-603 — live status', () => {
    it('is live from the post-reconcile searchable value, not the stale snapshot', async () => {
      mockLoadInputs.mockResolvedValue(completeSnapshot({ currentSearchable: false }));
      const status = await getChecklistStatus();
      expect(status.searchable).toBe(true);
      expect(status.liveStatus).toEqual({ state: 'live', fixItem: null });
      expect(status.username).toBe('dana');
    });

    it('is not_listed when the reconcile throws and the snapshot says unlisted', async () => {
      mockReconcileFromRead.mockRejectedValue(new Error('db unavailable'));
      const status = await getChecklistStatus();
      expect(status.searchable).toBe(false);
      expect(status.liveStatus?.state).toBe('not_listed');
      expect(mockListBusyReadTargets).not.toHaveBeenCalled();
    });

    it('is paused when a considered calendar is unreadable', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        target(),
        target({ connectionId: 'c2', credentialStatus: 'EXPIRED' }),
      ]);
      const status = await getChecklistStatus();
      expect(status.liveStatus).toEqual({ state: 'paused', fixItem: null });
      expect(mockListBusyReadTargets).toHaveBeenCalledWith('profile-1');
    });

    it('stays live when the unreadable calendar is not conflict-checked', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        target(),
        target({ connectionId: 'c2', credentialStatus: 'EXPIRED', calendarIds: [] }),
      ]);
      const status = await getChecklistStatus();
      expect(status.liveStatus?.state).toBe('live');
    });

    it('is away without reading calendars', async () => {
      mockLoadInputs.mockResolvedValue(completeSnapshot({ availableForWork: false }));
      const status = await getChecklistStatus();
      expect(status.liveStatus?.state).toBe('away');
      expect(mockListBusyReadTargets).not.toHaveBeenCalled();
    });

    it('is hidden before first go-live, with no busy read', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          inputs: { ...completeSnapshot().inputs, hasPayoutDetails: false },
        })
      );
      const status = await getChecklistStatus();
      expect(status.liveStatus).toBeNull();
      expect(status.liveCelebrationSeen).toBe(false);
      expect(mockListBusyReadTargets).not.toHaveBeenCalled();
    });

    it('shows not_listed with the failing item after a post-live regression', async () => {
      mockLoadInputs.mockResolvedValue(
        completeSnapshot({
          currentSearchable: true,
          liveCelebrationSeenAt: new Date('2026-02-01T00:00:00Z'),
          inputs: { ...completeSnapshot().inputs, hasPayoutDetails: false },
        })
      );
      const status = await getChecklistStatus();
      expect(status.liveCelebrationSeen).toBe(true);
      expect(status.liveStatus).toEqual({ state: 'not_listed', fixItem: 'payouts' });
      expect(mockListBusyReadTargets).not.toHaveBeenCalled();
    });

    it('hides the badge and warns when the busy read fails', async () => {
      mockListBusyReadTargets.mockRejectedValue(new Error('db down'));
      const status = await getChecklistStatus();
      expect(status.liveStatus).toBeNull();
      expect(log.warn).toHaveBeenCalledWith('Live status busy-read failed', {
        expertProfileId: 'profile-1',
        error: 'db down',
      });
    });

    it('never stamps the celebration from the read path', async () => {
      await getChecklistStatus();
      expect(mockMarkLiveCelebrationSeen).not.toHaveBeenCalled();
    });
  });
});
