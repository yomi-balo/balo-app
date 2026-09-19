import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockUpdate = vi.fn();
// BAL-568 — the account-liveness gate reads the LIVE row through `readLiveUserRow`.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    update: (...args: unknown[]) => mockUpdate(...args),
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

// `readLiveUserRow` is `React.cache()`'d; a unit test has no request scope, so pass it through.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

const LIVE_ROW = { status: 'active', deletedAt: null };
const SUSPENDED_ROW = { status: 'suspended', deletedAt: null };

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { updateTimezoneAction } from './update-timezone';

// ── Tests ───────────────────────────────────────────────────────

describe('updateTimezoneAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
    mockSessionObj = { user: { id: 'user-1' }, save: mockSave };
  });

  /** BAL-568 — one of the bounded `getSession()`-only set; the gate runs before the write. */
  describe('BAL-568 — account liveness', () => {
    it('⚠ refuses a SUSPENDED actor before any repository write', async () => {
      mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);

      const result = await updateTimezoneAction('Australia/Sydney');

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('fails CLOSED when the live-row read throws', async () => {
      mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));

      const result = await updateTimezoneAction('Australia/Sydney');

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('⚠ an unauthenticated caller pays ZERO live-row reads', async () => {
      mockSessionObj = {};

      await updateTimezoneAction('Australia/Sydney');

      expect(mockFindForSessionSync).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('returns error for empty timezone string', async () => {
      const result = await updateTimezoneAction('');
      expect(result).toEqual({
        success: false,
        error: 'Timezone is required',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns error for invalid timezone string', async () => {
      const result = await updateTimezoneAction('Not/A/Real/Timezone');
      expect(result).toEqual({
        success: false,
        error: 'Invalid timezone',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('returns error when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await updateTimezoneAction('Australia/Sydney');
      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns error when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      const result = await updateTimezoneAction('Australia/Sydney');
      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('calls usersRepository.update with timezone, country, and countryCode for a known timezone', async () => {
      await updateTimezoneAction('Australia/Sydney');
      expect(mockUpdate).toHaveBeenCalledWith('user-1', {
        timezone: 'Australia/Sydney',
        country: 'Australia',
        countryCode: 'AU',
      });
    });

    it('calls usersRepository.update with only timezone for an unknown timezone', async () => {
      await updateTimezoneAction('Pacific/Palau');
      expect(mockUpdate).toHaveBeenCalledWith('user-1', {
        timezone: 'Pacific/Palau',
      });
    });

    it('returns success on valid timezone update', async () => {
      const result = await updateTimezoneAction('America/New_York');
      expect(result).toEqual({ success: true });
    });
  });

  describe('error handling', () => {
    it('returns error when usersRepository.update throws', async () => {
      mockUpdate.mockRejectedValue(new Error('DB error'));
      const result = await updateTimezoneAction('Australia/Sydney');
      expect(result).toEqual({
        success: false,
        error: 'Failed to save timezone. Please try again.',
      });
    });
  });
});
