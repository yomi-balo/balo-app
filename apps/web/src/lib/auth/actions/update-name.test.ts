import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// `@/lib/logging` is auto-mocked globally in src/test/setup.ts.

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

const mockUpdateName = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    updateName: (...args: unknown[]) => mockUpdateName(...args),
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
    mockUpdateName.mockResolvedValue({ changed: true });
    mockSave.mockResolvedValue(undefined);
    // Un-onboarded session: the onboarding name step must still run.
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: false, firstName: null, lastName: null },
      save: mockSave,
    };
  });

  it('runs while un-onboarded: updates the name through the audited write and returns success', async () => {
    const result = await updateNameAction({ firstName: ' Ada ', lastName: 'Lovelace' });
    expect(result).toEqual({ success: true });
    expect(mockUpdateName).toHaveBeenCalledWith({
      userId: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      actorImpersonatorUserId: undefined,
    });
  });

  it('hands the impersonating staff member to the audit write', async () => {
    mockSessionObj = {
      user: {
        id: 'user-1',
        onboardingCompleted: true,
        firstName: 'Ada',
        lastName: 'Lovelace',
        isImpersonating: true,
        impersonatorUserId: 'staff-1',
      },
      save: mockSave,
    };
    await updateNameAction({ firstName: 'Augusta', lastName: 'Lovelace' });
    expect(mockUpdateName).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', actorImpersonatorUserId: 'staff-1' })
    );
  });

  it('re-saves the session cookie with the new name', async () => {
    await updateNameAction({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSessionObj.user).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('rejects invalid input without writing', async () => {
    const result = await updateNameAction({ firstName: '', lastName: 'Lovelace' });
    expect(result.success).toBe(false);
    expect(mockUpdateName).not.toHaveBeenCalled();
  });
});
