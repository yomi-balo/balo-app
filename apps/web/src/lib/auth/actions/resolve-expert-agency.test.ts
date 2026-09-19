import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// The pure resolver is mocked to isolate the action's session-read + fail-open
// behaviour. `@/lib/logging` is globally mocked in test/setup.ts.

const mockResolveExpertAgency = vi.fn();
vi.mock('@/lib/expert-agency/resolve-expert-agency', () => ({
  resolveExpertAgency: (...args: unknown[]) => mockResolveExpertAgency(...args),
}));

const mockFindById = vi.fn();
// BAL-568 — the account-liveness gate reads the LIVE row through `readLiveUserRow`.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
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

let mockSessionObj: Record<string, unknown> | null;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { resolveExpertAgencyAction } from './resolve-expert-agency';

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionObj = { user: { id: 'user-1', email: 'session-copy@acme.io' } };
  // DB is authoritative — the action reads email + verified from here, not the session.
  mockFindById.mockResolvedValue({ id: 'user-1', email: 'founder@acme.io', emailVerified: true });
  mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
});

/**
 * BAL-568 — one of the bounded `getSession()`-only set.
 *
 * ⚠ THE GATE SITS **ABOVE** THIS ACTION'S `try`, DELIBERATELY. The action fails OPEN on any
 * throw, so a gate inside the `try` would be swallowed by its catch and silently do nothing. A
 * refused account therefore lands on the same safe default an anonymous one does — it learns
 * nothing, and this path writes nothing.
 */
describe('BAL-568 — account liveness', () => {
  it('⚠ a SUSPENDED actor fails to solo WITHOUT reading the identity row or resolving', async () => {
    mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);

    const result = await resolveExpertAgencyAction();

    expect(result).toEqual({ kind: 'solo' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('a SOFT-DELETED actor is refused the same way', async () => {
    mockFindForSessionSync.mockResolvedValue({
      status: 'active',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(await resolveExpertAgencyAction()).toEqual({ kind: 'solo' });
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('⚠ an anonymous caller pays ZERO live-row reads', async () => {
    mockSessionObj = null;

    await resolveExpertAgencyAction();

    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });
});

describe('resolveExpertAgencyAction', () => {
  it('fails open to solo (no db/resolver call) when there is no session', async () => {
    mockSessionObj = null;
    const result = await resolveExpertAgencyAction();
    expect(result).toEqual({ kind: 'solo' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('fails open to solo (no db/resolver call) when the session has no user id', async () => {
    mockSessionObj = { user: {} };
    const result = await resolveExpertAgencyAction();
    expect(result).toEqual({ kind: 'solo' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('fails open to solo when the user row is not found (no resolver call)', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await resolveExpertAgencyAction();
    expect(result).toEqual({ kind: 'solo' });
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('delegates to the resolver with the DB email + verified flag for a verified user', async () => {
    mockResolveExpertAgency.mockResolvedValue({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 3 },
    });

    const result = await resolveExpertAgencyAction();

    // Email comes from the DB row (not the session copy), with the authoritative flag.
    expect(mockFindById).toHaveBeenCalledWith('user-1');
    expect(mockResolveExpertAgency).toHaveBeenCalledWith('founder@acme.io', true);
    expect(result).toEqual({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 3 },
    });
  });

  it('passes emailVerified=false through for an UNVERIFIED user (resolver gates to solo)', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'founder@acme.io',
      emailVerified: false,
    });
    mockResolveExpertAgency.mockResolvedValue({ kind: 'solo' });

    const result = await resolveExpertAgencyAction();

    expect(mockResolveExpertAgency).toHaveBeenCalledWith('founder@acme.io', false);
    expect(result).toEqual({ kind: 'solo' });
  });

  it('fails OPEN to solo and warns when the resolver throws', async () => {
    mockResolveExpertAgency.mockRejectedValue(new Error('db down'));

    const result = await resolveExpertAgencyAction();

    expect(result).toEqual({ kind: 'solo' });
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});
