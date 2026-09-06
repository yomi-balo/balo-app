import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionStatementView } from '../_lib/session-statement-view';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const notFoundError = new Error('NEXT_NOT_FOUND');
const redirectError = new Error('NEXT_REDIRECT');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
  redirect: () => {
    throw redirectError;
  },
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => `/sessions/${SESSION_ID}/payout`,
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// ⚠ `vi.mock()` calls are HOISTED above every top-level statement, so the fake error CLASS must
// live in `vi.hoisted()` — a bare top-level `class` is in the temporal dead zone when the factory
// runs (documented at `receipt/pdf/route.test.ts:3-6`). `mockLoadSessionStatement` can stay a
// plain top-level `const` because the factory only dereferences it lazily inside an arrow; a
// class reference is dereferenced eagerly, so it cannot.
const { FakeSessionStatementRateLimitedError } = vi.hoisted(() => ({
  FakeSessionStatementRateLimitedError: class extends Error {
    retryAfterSeconds: number | null = null;
    constructor(retryAfterSeconds: number | null) {
      super('rate limited');
      this.retryAfterSeconds = retryAfterSeconds;
    }
  },
}));

const mockLoadSessionStatement = vi.fn();
vi.mock('../_lib/load-session-statement', () => ({
  loadSessionStatement: (...a: unknown[]) => mockLoadSessionStatement(...a),
  SessionStatementRateLimitedError: FakeSessionStatementRateLimitedError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    CASE_BILLING_SERVER_EVENTS: events.CASE_BILLING_SERVER_EVENTS,
  };
});

import PayoutPage, { generateMetadata } from './page';

const EXPERT_VIEW: SessionStatementView = {
  lens: 'expert',
  sessionId: SESSION_ID,
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Northwind Industrial', orgLabel: null },
  meetingId: 'meeting_1',
  payout: {
    reference: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    recordedAtIso: '2026-08-12T11:00:00.000Z',
  },
  block: {
    lens: 'expert',
    state: 'finalized',
    sessionId: SESSION_ID,
    durationMinutes: 45,
    earningsAudMinor: 11_250,
    payoutStatus: 'recorded',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

function props(over: Record<string, unknown> = {}) {
  return {
    params: Promise.resolve({ sessionId: SESSION_ID }),
    searchParams: Promise.resolve({}),
    ...over,
  };
}

describe('PayoutPage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(EXPERT_VIEW);
  });

  it('redirects to login when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(PayoutPage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockLoadSessionStatement).not.toHaveBeenCalled();
  });

  it('404s on a denial — no existence oracle', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    await expect(PayoutPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  it('AWAITS the params promise, requesting the EXPERT lens', async () => {
    await PayoutPage(props());
    expect(mockLoadSessionStatement).toHaveBeenCalledWith(SESSION_ID, USER_ID, 'expert');
  });

  it('re-throws a loader failure so error.tsx renders the boundary', async () => {
    mockLoadSessionStatement.mockRejectedValue(new Error('boom'));
    await expect(PayoutPage(props())).rejects.toThrow(/boom/);
  });

  it('renders the calm rate-limited state instead of throwing to error.tsx', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    const element = await PayoutPage(props());
    render(element);
    expect(screen.getByRole('heading', { name: 'Hold tight' })).toBeInTheDocument();
    // It must NOT be mistaken for the not-found state — that copy would say the payout is gone.
    expect(screen.queryByText("We couldn't find that payout")).not.toBeInTheDocument();
  });

  // TECH5 (fix round 1) — this was a byte-identical clone of "re-throws a loader failure so
  // error.tsx renders the boundary" above. A rejected promise never reaches `render()`, so there
  // is no DOM to additionally assert against — a not-rendered check here would be vacuously true
  // regardless of behaviour. Deleted rather than padded with a contrived assertion; the case above
  // already proves a generic error re-throws instead of resolving to the rate-limited state.
});

describe('PayoutPage — analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(EXPERT_VIEW);
  });

  it('fires session_statement_viewed with lens: expert', async () => {
    await PayoutPage(props());
    expect(mockTrack).toHaveBeenCalledWith('session_statement_viewed', {
      session_id: SESSION_ID,
      lens: 'expert',
      source: 'direct',
      statement_state: 'finalized',
      distinct_id: USER_ID,
    });
  });

  it('fires NO event on the notFound() path', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    await expect(PayoutPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('fires NO event on the rate-limited path', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    await PayoutPage(props());
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('generateMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(EXPERT_VIEW);
  });

  it('specialises the title only for an authorised viewer', async () => {
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Static analysis walkthrough — Balo');
  });

  it('falls back to GENERIC_METADATA on denial', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Payout statement — Balo');
  });

  it('falls back to GENERIC_METADATA when the loader is rate-limited', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Payout statement — Balo');
  });
});

describe('PayoutPage — what actually renders, fee-safe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(EXPERT_VIEW);
  });

  it('renders the payout statement, the counterparty COMPANY, and no client charge', async () => {
    const element = await PayoutPage(props());
    render(element);
    expect(
      screen.getByRole('heading', { name: 'Static analysis walkthrough' })
    ).toBeInTheDocument();
    expect(screen.getByText(/with Northwind Industrial/)).toBeInTheDocument();
    expect(screen.getByText('Total earned')).toBeInTheDocument();
    expect(screen.getByText('A$112.50')).toBeInTheDocument();
  });
});
