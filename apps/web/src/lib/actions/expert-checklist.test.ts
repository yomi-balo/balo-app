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

const mockFindProfileById = vi.fn();
const mockUpdateProfile = vi.fn();
const mockFindUserById = vi.fn();
const mockHasPayoutDetails = vi.fn();
const mockFindConnection = vi.fn();
const mockHasActiveRules = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findProfileById: (...args: unknown[]) => mockFindProfileById(...args),
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  },
  usersRepository: {
    findById: (...args: unknown[]) => mockFindUserById(...args),
  },
  payoutsRepository: {
    hasPayoutDetails: (...args: unknown[]) => mockHasPayoutDetails(...args),
  },
  calendarRepository: {
    findConnectionByExpertProfileId: (...args: unknown[]) => mockFindConnection(...args),
  },
  availabilityRulesRepository: {
    hasActiveRules: (...args: unknown[]) => mockHasActiveRules(...args),
  },
}));

let mockSessionObj: Record<string, unknown> | null;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { getChecklistStatus } from './expert-checklist';

// ── Helpers ──────────────────────────────────────────────────────

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
};

/** A profile where every profile-owned checklist item is satisfied. */
function completeProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'profile-1',
    headline: 'Salesforce Architect',
    bio: 'Ten years building on the platform.',
    rateCents: 313,
    searchable: false,
    ...overrides,
  };
}

function completeUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('getChecklistStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockUpdateProfile.mockResolvedValue(undefined);
    // Default: calendar connected, no weekly schedule yet.
    mockFindConnection.mockResolvedValue({ id: 'conn-1' });
    mockHasActiveRules.mockResolvedValue(false);
  });

  describe('authentication & mode guards', () => {
    it('throws when there is no session user', async () => {
      mockSessionObj = null;
      await expect(getChecklistStatus()).rejects.toThrow('Unauthorized');
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });

    it('throws when not in expert mode', async () => {
      mockSessionObj = {
        user: { id: 'user-1', activeMode: 'client', expertProfileId: 'profile-1' },
      };
      await expect(getChecklistStatus()).rejects.toThrow('Expert mode required');
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });

    it('throws when there is no expertProfileId', async () => {
      mockSessionObj = {
        user: { id: 'user-1', activeMode: 'expert', expertProfileId: null },
      };
      await expect(getChecklistStatus()).rejects.toThrow('Expert profile required');
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });

    it('throws when the profile is not found', async () => {
      mockFindProfileById.mockResolvedValue(undefined);
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      await expect(getChecklistStatus()).rejects.toThrow('Profile or user not found');
    });
  });

  describe('rate checklist item & returned rateCents', () => {
    it('marks rate complete and returns the raw rateCents when rateCents > 0', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ rateCents: 313 }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.rate).toBe(true);
      expect(status.rateCents).toBe(313);
    });

    it('marks rate incomplete and returns null when rateCents is null', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ rateCents: null }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.rate).toBe(false);
      expect(status.rateCents).toBeNull();
    });
  });

  describe('calendar & availability signals (BAL-234)', () => {
    it('marks calendar complete when a connection row exists', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });

      const status = await getChecklistStatus();

      expect(status.items.calendar).toBe(true);
      expect(mockFindConnection).toHaveBeenCalledWith('profile-1');
    });

    it('marks calendar incomplete when there is no connection row', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue(undefined);
      mockHasActiveRules.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.calendar).toBe(false);
      // Availability needs BOTH a schedule AND a calendar → false here.
      expect(status.items.availability).toBe(false);
    });

    it('marks availability complete only with both a schedule and a calendar', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });
      mockHasActiveRules.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.availability).toBe(true);
      expect(mockHasActiveRules).toHaveBeenCalledWith('profile-1');
    });

    it('keeps availability incomplete when a calendar is connected but no schedule exists', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });
      mockHasActiveRules.mockResolvedValue(false);

      const status = await getChecklistStatus();

      expect(status.items.availability).toBe(false);
    });
  });

  describe('searchable side-effect', () => {
    it('sets searchable when all six items complete', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ searchable: false }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });
      mockHasActiveRules.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.allComplete).toBe(true);
      expect(status.completedCount).toBe(6);
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { searchable: true });
    });

    it('does NOT set searchable again when the profile is already searchable', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ searchable: true }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });
      mockHasActiveRules.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.allComplete).toBe(true);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('does NOT set searchable when availability keeps the checklist incomplete', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ searchable: false }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockHasActiveRules.mockResolvedValue(false);

      const status = await getChecklistStatus();

      expect(status.items.availability).toBe(false);
      expect(status.allComplete).toBe(false);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('completedCount', () => {
    it('counts 5 of 6 when only the weekly schedule is missing', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);
      mockFindConnection.mockResolvedValue({ id: 'conn-1' });
      mockHasActiveRules.mockResolvedValue(false);

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
    });
  });
});
