import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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

import { saveCountryAction } from './save-country';
import { revalidatePath } from 'next/cache';

// ── Helpers ──────────────────────────────────────────────────────

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

// ── Tests ────────────────────────────────────────────────────────

describe('saveCountryAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockUpdate.mockResolvedValue({ id: 'user-1' });
  });

  it('throws when no session', async () => {
    mockSessionObj = {};
    await expect(saveCountryAction({ countryCode: 'AU' })).rejects.toThrow('Unauthorized');
  });

  it('saves country and countryCode for a valid code', async () => {
    const result = await saveCountryAction({ countryCode: 'AU' });

    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      countryCode: 'AU',
      country: 'Australia',
    });
  });

  it('saves US country name for US code', async () => {
    const result = await saveCountryAction({ countryCode: 'US' });

    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      countryCode: 'US',
      country: 'United States',
    });
  });

  it('clears country when countryCode is empty string', async () => {
    const result = await saveCountryAction({ countryCode: '' });

    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      countryCode: null,
      country: null,
    });
  });

  it('clears country when countryCode is null', async () => {
    const result = await saveCountryAction({ countryCode: null });

    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      countryCode: null,
      country: null,
    });
  });

  it('returns validation error for invalid countryCode length', async () => {
    const result = await saveCountryAction({ countryCode: 'AUS' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns validation error for single character code', async () => {
    const result = await saveCountryAction({ countryCode: 'A' });

    expect(result.success).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('revalidates path on success', async () => {
    await saveCountryAction({ countryCode: 'AU' });

    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
  });

  it('does not revalidate on validation error', async () => {
    await saveCountryAction({ countryCode: 'INVALID' });

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('returns error when repository update fails', async () => {
    mockUpdate.mockRejectedValue(new Error('DB error'));

    const result = await saveCountryAction({ countryCode: 'AU' });

    expect(result).toEqual({
      success: false,
      error: 'Failed to save country. Please try again.',
    });
  });

  it('sets country to null for unknown country code', async () => {
    const result = await saveCountryAction({ countryCode: 'XX' });

    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      countryCode: 'XX',
      country: null,
    });
  });
});
