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

const mockLoadSessionStatement = vi.fn();
vi.mock('../_lib/load-session-statement', () => ({
  loadSessionStatement: (...a: unknown[]) => mockLoadSessionStatement(...a),
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
