import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockUpdate = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

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
    mockSessionObj = { user: { id: 'user-1' }, save: mockSave };
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
    it('calls usersRepository.update with correct user ID and timezone', async () => {
      await updateTimezoneAction('Australia/Sydney');
      expect(mockUpdate).toHaveBeenCalledWith('user-1', {
        timezone: 'Australia/Sydney',
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
