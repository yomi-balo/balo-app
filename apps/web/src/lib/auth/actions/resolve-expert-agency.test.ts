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
vi.mock('@balo/db', () => ({
  usersRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

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
