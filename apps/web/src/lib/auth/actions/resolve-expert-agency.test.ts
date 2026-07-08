import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// The pure resolver is mocked to isolate the action's session-read + fail-open
// behaviour. `@/lib/logging` is globally mocked in test/setup.ts.

const mockResolveExpertAgency = vi.fn();
vi.mock('@/lib/expert-agency/resolve-expert-agency', () => ({
  resolveExpertAgency: (...args: unknown[]) => mockResolveExpertAgency(...args),
}));

let mockSessionObj: Record<string, unknown> | null;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { resolveExpertAgencyAction } from './resolve-expert-agency';

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionObj = { user: { id: 'user-1', email: 'founder@acme.io' } };
});

describe('resolveExpertAgencyAction', () => {
  it('fails open to solo (no resolver call) when there is no session', async () => {
    mockSessionObj = null;
    const result = await resolveExpertAgencyAction();
    expect(result).toEqual({ kind: 'solo' });
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('fails open to solo when the session has no email', async () => {
    mockSessionObj = { user: { id: 'user-1' } };
    const result = await resolveExpertAgencyAction();
    expect(result).toEqual({ kind: 'solo' });
    expect(mockResolveExpertAgency).not.toHaveBeenCalled();
  });

  it('returns the resolver outcome for a signed-in user, reading email from the session', async () => {
    mockResolveExpertAgency.mockResolvedValue({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 3 },
    });

    const result = await resolveExpertAgencyAction();

    expect(mockResolveExpertAgency).toHaveBeenCalledWith('founder@acme.io');
    expect(result).toEqual({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 3 },
    });
  });

  it('fails OPEN to solo and warns when the resolver throws', async () => {
    mockResolveExpertAgency.mockRejectedValue(new Error('db down'));

    const result = await resolveExpertAgencyAction();

    expect(result).toEqual({ kind: 'solo' });
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});
