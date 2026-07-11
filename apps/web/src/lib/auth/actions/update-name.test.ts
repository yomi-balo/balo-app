import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// `@/lib/logging` is auto-mocked globally in src/test/setup.ts.

vi.mock('server-only', () => ({}));

const mockUpdate = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
// A single getSession mock backs BOTH the withAuth wrapper and the action body
// (with-auth.ts imports getSession from this same module).
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { updateNameAction } from './update-name';

// ── Tests ───────────────────────────────────────────────────────

describe('updateNameAction — allowUnonboarded opt-out (BAL-365)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    // Un-onboarded session: the onboarding name step must still run.
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: false, firstName: null, lastName: null },
      save: mockSave,
    };
  });

  it('runs while un-onboarded: updates the name and returns success', async () => {
    const result = await updateNameAction({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('re-saves the session cookie with the new name', async () => {
    await updateNameAction({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSessionObj.user).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('rejects invalid input without writing', async () => {
    const result = await updateNameAction({ firstName: '', lastName: 'Lovelace' });
    expect(result.success).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
