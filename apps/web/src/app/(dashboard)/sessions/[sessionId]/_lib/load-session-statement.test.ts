import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchSessionStatement } = vi.hoisted(() => ({
  mockFetchSessionStatement: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/session-statement', () => ({
  fetchSessionStatement: mockFetchSessionStatement,
}));
// `cache()` from React de-dupes per request; a plain passthrough is fine for a unit test.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import { loadSessionStatement, SessionStatementUnavailableError } from './load-session-statement';

const CLIENT_STATEMENT = {
  lens: 'client' as const,
  block: {
    lens: 'client' as const,
    state: 'finalized' as const,
    sessionId: 'session_1',
    durationMinutes: 45,
    amountAudMinor: 15_000,
    ratePerMinuteMinor: 333,
    settlementStatus: 'not_required',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
  context: {
    occurredAtIso: '2026-08-12T10:00:00.000Z',
    title: 'Static analysis walkthrough',
    counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
    meetingId: 'meeting_1',
    cancelled: false,
  },
};

describe('loadSessionStatement (BAL-441)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the mapped view on a matching lens', async () => {
    mockFetchSessionStatement.mockResolvedValue({ outcome: 'ok', statement: CLIENT_STATEMENT });
    const view = await loadSessionStatement('session_1', 'user_1', 'client');
    expect(view).not.toBeNull();
    expect(view?.lens).toBe('client');
    expect(view?.mode).toEqual({ kind: 'money' });
  });

  it('returns null on the WRONG lens (client statement on the /payout route)', async () => {
    mockFetchSessionStatement.mockResolvedValue({ outcome: 'ok', statement: CLIENT_STATEMENT });
    const view = await loadSessionStatement('session_1', 'user_1', 'expert');
    expect(view).toBeNull();
  });

  it('returns null on a denial', async () => {
    mockFetchSessionStatement.mockResolvedValue({ outcome: 'denied' });
    expect(await loadSessionStatement('session_1', 'user_1', 'client')).toBeNull();
  });

  it('throws SessionStatementUnavailableError on an outage — never swallowed to null', async () => {
    mockFetchSessionStatement.mockResolvedValue({ outcome: 'unavailable' });
    await expect(loadSessionStatement('session_1', 'user_1', 'client')).rejects.toBeInstanceOf(
      SessionStatementUnavailableError
    );
  });
});
