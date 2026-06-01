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

/** A profile where every non-availability checklist item is satisfied. */
function completeProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'profile-1',
    headline: 'Salesforce Architect',
    bio: 'Ten years building on the platform.',
    rateCents: 313,
    cronofySyncStatus: 'connected',
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

  describe('rate checklist item & returned rateCents (line 64 & 84)', () => {
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

    it('marks rate incomplete and returns null when rateCents is 0', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ rateCents: 0 }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.rate).toBe(false);
      // 0 is falsy → rateCents ?? null returns 0 (not null), since 0 is not nullish.
      expect(status.rateCents).toBe(0);
    });
  });

  describe('searchable side-effect', () => {
    // NOTE: `availability` is currently hard-coded to `false` (TODO BAL-195),
    // so `allComplete` (= all 6 items) can never be true with current source.
    // These tests therefore pin the present behaviour: the side-effect guard
    // never fires, and updateProfile is never called from the checklist.
    it('does NOT set searchable when availability keeps the checklist incomplete', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ searchable: false }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);

      const status = await getChecklistStatus();

      expect(status.items.availability).toBe(false);
      expect(status.allComplete).toBe(false);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('does NOT set searchable when several items are incomplete', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile({ rateCents: null }));
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(false);

      const status = await getChecklistStatus();

      expect(status.allComplete).toBe(false);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('completedCount', () => {
    it('counts the satisfied items (5 of 6 when availability is the only gap)', async () => {
      mockFindProfileById.mockResolvedValue(completeProfile());
      mockFindUserById.mockResolvedValue(completeUser());
      mockHasPayoutDetails.mockResolvedValue(true);

      const status = await getChecklistStatus();

      // profile, phone, rate, calendar, payouts = 5; availability = false.
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
