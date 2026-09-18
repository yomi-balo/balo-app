import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

let mockSessionObj: Record<string, unknown> | null;
vi.mock('./session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

// BAL-568 — `with-auth.ts` now asserts account liveness through `./account-liveness`, which reads
// the LIVE row. Driving the repository double is what proves the gate actually runs, and that it
// runs ABOVE the onboarding check.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

import { withAuth } from './with-auth';
import { AccountNotLiveError } from './account-liveness';

// ── Helpers ─────────────────────────────────────────────────────

const LIVE_ROW = { status: 'active', deletedAt: null };
const SUSPENDED_ROW = { status: 'suspended', deletedAt: null };

function sessionWith(onboardingCompleted: unknown): Record<string, unknown> {
  return { user: { id: 'user-1', onboardingCompleted } };
}

// ── Tests ───────────────────────────────────────────────────────

describe('withAuth', () => {
  const inner = vi.fn(async (_session: unknown, ...args: unknown[]) => ({ ok: true, args }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = sessionWith(true);
    mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
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

  // ── BAL-568 — the liveness gate, above the onboarding gate and above the action ────────

  it('⚠ does NOT invoke the wrapped action for a SUSPENDED account', async () => {
    mockSessionObj = sessionWith(true);
    mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);
    const action = withAuth(inner);

    await expect(action('input-a')).rejects.toBeInstanceOf(AccountNotLiveError);

    expect(inner).not.toHaveBeenCalled();
  });

  it('does not invoke the wrapped action for a SOFT-DELETED account', async () => {
    mockSessionObj = sessionWith(true);
    mockFindForSessionSync.mockResolvedValue({
      status: 'active',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const action = withAuth(inner);

    await expect(action()).rejects.toMatchObject({ code: 'account_deleted' });
    expect(inner).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the live-row read throws — an unreachable DB is not a way to keep acting', async () => {
    mockSessionObj = sessionWith(true);
    mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));
    const action = withAuth(inner);

    await expect(action()).rejects.toMatchObject({ code: 'account_unreadable' });
    expect(inner).not.toHaveBeenCalled();
  });

  /**
   * ⚠ ORDERING, PINNED. An actor who is BOTH un-onboarded and suspended must report the LIVENESS
   * refusal, not the onboarding one — the onboarding message would invite them to finish a wizard
   * they are not allowed to run.
   */
  it('⚠ the liveness gate runs ABOVE the onboarding gate', async () => {
    mockSessionObj = sessionWith(false); // un-onboarded AND suspended
    mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);
    const action = withAuth(inner);

    await expect(action()).rejects.toBeInstanceOf(AccountNotLiveError);
    await expect(action()).rejects.not.toThrow('Onboarding not completed');
    expect(inner).not.toHaveBeenCalled();
  });

  /**
   * ⚠ `allowUnonboarded` OPTS OUT OF THE ONBOARDING GATE ONLY. It must never be a way past the
   * liveness gate — otherwise every onboarding-flow action would be an open door.
   */
  it('⚠ allowUnonboarded does NOT opt out of the liveness gate', async () => {
    mockSessionObj = sessionWith(false);
    mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);
    const action = withAuth(inner, { allowUnonboarded: true });

    await expect(action()).rejects.toBeInstanceOf(AccountNotLiveError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('a live account still runs the action, reading the row exactly once', async () => {
    mockSessionObj = sessionWith(true);
    const action = withAuth(inner);

    await action('x');

    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockFindForSessionSync).toHaveBeenCalledTimes(1);
    expect(mockFindForSessionSync).toHaveBeenCalledWith('user-1');
  });

  it('⚠ an unauthenticated caller pays ZERO database reads', async () => {
    mockSessionObj = {};
    const action = withAuth(inner);

    await expect(action()).rejects.toThrow('Unauthorized');

    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });
});
