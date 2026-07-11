import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

let mockSessionObj: Record<string, unknown> | null;
vi.mock('./session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { withAuth } from './with-auth';

// ── Helpers ─────────────────────────────────────────────────────

function sessionWith(onboardingCompleted: unknown): Record<string, unknown> {
  return { user: { id: 'user-1', onboardingCompleted } };
}

// ── Tests ───────────────────────────────────────────────────────

describe('withAuth', () => {
  const inner = vi.fn(async (_session: unknown, ...args: unknown[]) => ({ ok: true, args }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = sessionWith(true);
  });

  it('throws Unauthorized when there is no user and does not call the action', async () => {
    mockSessionObj = {};
    const action = withAuth(inner);
    await expect(action()).rejects.toThrow('Unauthorized');
    expect(inner).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when the session is null', async () => {
    mockSessionObj = null;
    const action = withAuth(inner);
    await expect(action()).rejects.toThrow('Unauthorized');
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes through and forwards session + args when onboarding is complete', async () => {
    mockSessionObj = sessionWith(true);
    const action = withAuth(inner);
    const result = await action('input-a', 42);
    expect(inner).toHaveBeenCalledWith(mockSessionObj, 'input-a', 42);
    expect(result).toEqual({ ok: true, args: ['input-a', 42] });
  });

  it('throws Onboarding not completed when onboardingCompleted is false', async () => {
    mockSessionObj = sessionWith(false);
    const action = withAuth(inner);
    await expect(action()).rejects.toThrow('Onboarding not completed');
    expect(inner).not.toHaveBeenCalled();
  });

  it('throws Onboarding not completed when onboardingCompleted is undefined (fail-closed)', async () => {
    mockSessionObj = sessionWith(undefined);
    const action = withAuth(inner);
    await expect(action()).rejects.toThrow('Onboarding not completed');
    expect(inner).not.toHaveBeenCalled();
  });

  it('throws Onboarding not completed when onboardingCompleted is null (fail-closed)', async () => {
    mockSessionObj = sessionWith(null);
    const action = withAuth(inner);
    await expect(action()).rejects.toThrow('Onboarding not completed');
    expect(inner).not.toHaveBeenCalled();
  });

  it('runs an un-onboarded session when allowUnonboarded: true (opt-out)', async () => {
    mockSessionObj = sessionWith(false);
    const action = withAuth(inner, { allowUnonboarded: true });
    const result = await action('x');
    expect(inner).toHaveBeenCalledWith(mockSessionObj, 'x');
    expect(result).toEqual({ ok: true, args: ['x'] });
  });

  it('still throws Unauthorized under allowUnonboarded when there is no user', async () => {
    mockSessionObj = {};
    const action = withAuth(inner, { allowUnonboarded: true });
    await expect(action()).rejects.toThrow('Unauthorized');
    expect(inner).not.toHaveBeenCalled();
  });
});
