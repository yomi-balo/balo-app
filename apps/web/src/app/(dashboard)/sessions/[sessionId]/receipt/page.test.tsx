import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionStatementView } from '../_lib/session-statement-view';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';

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
  usePathname: () => `/sessions/${SESSION_ID}/receipt`,
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

import ReceiptPage, { generateMetadata } from './page';

const CLIENT_VIEW: SessionStatementView = {
  lens: 'client',
  sessionId: SESSION_ID,
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
  meetingId: 'meeting_1',
  block: {
    lens: 'client',
    state: 'finalized',
    sessionId: SESSION_ID,
    durationMinutes: 45,
    amountAudMinor: 15_750,
    ratePerMinuteMinor: 350,
    settlementStatus: 'not_required',
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

describe('ReceiptPage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(CLIENT_VIEW);
  });

  it('redirects to login when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(ReceiptPage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockLoadSessionStatement).not.toHaveBeenCalled();
  });

  it('404s on a denial (missing/unauthorised) — no existence oracle', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    await expect(ReceiptPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  // NOTE: the wrong-lens arm is NOT re-tested here. It was, as a byte-identical copy of the
  // denial test above — but this suite MOCKS `loadSessionStatement`, so the lens assertion it
  // claimed to cover never executed. The real coverage is `_lib/load-session-statement.test.ts`
  // ("returns null when the resolved lens does not match"), where the collapse actually happens.
  // What this suite CAN prove about the lens is the argument it passes — asserted below.

  it('AWAITS the params promise (Next 16), requesting the CLIENT lens', async () => {
    await ReceiptPage(props());
    expect(mockLoadSessionStatement).toHaveBeenCalledWith(SESSION_ID, USER_ID, 'client');
  });

  it('re-throws a loader failure so error.tsx renders the boundary', async () => {
    mockLoadSessionStatement.mockRejectedValue(new Error('boom'));
    await expect(ReceiptPage(props())).rejects.toThrow(/boom/);
  });

  it('renders the calm rate-limited state instead of throwing to error.tsx', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    const element = await ReceiptPage(props());
    render(element);
    expect(screen.getByRole('heading', { name: 'Hold tight' })).toBeInTheDocument();
    // It must NOT be mistaken for the not-found state — that copy would say the receipt is gone.
    expect(screen.queryByText("We couldn't find that receipt")).not.toBeInTheDocument();
  });

  // TECH5 (fix round 1) — this was a byte-identical clone of "re-throws a loader failure so
  // error.tsx renders the boundary" above. A rejected promise never reaches `render()`, so there
  // is no DOM to additionally assert against — a not-rendered check here would be vacuously true
  // regardless of behaviour. Deleted rather than padded with a contrived assertion; the case above
  // already proves a generic error re-throws instead of resolving to the rate-limited state.
});

describe('ReceiptPage — analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(CLIENT_VIEW);
  });

  it('fires session_statement_viewed with the exact dimension object', async () => {
    await ReceiptPage(props());
    expect(mockTrack).toHaveBeenCalledWith('session_statement_viewed', {
      session_id: SESSION_ID,
      lens: 'client',
      source: 'direct',
      statement_state: 'finalized',
      distinct_id: USER_ID,
    });
  });

  it('resolves ?from=money_block to source "money_block"', async () => {
    await ReceiptPage(props({ searchParams: Promise.resolve({ from: 'money_block' }) }));
    expect(mockTrack).toHaveBeenCalledWith(
      'session_statement_viewed',
      expect.objectContaining({ source: 'money_block' })
    );
  });

  it('includes settlement_shape only when the payload carries one', async () => {
    mockLoadSessionStatement.mockResolvedValue({
      ...CLIENT_VIEW,
      block: { ...CLIENT_VIEW.block, settlementShape: 'held' },
    });
    await ReceiptPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'session_statement_viewed',
      expect.objectContaining({ settlement_shape: 'held' })
    );
  });

  it('fires NO event on the notFound() path', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    await expect(ReceiptPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('fires NO event on the redirect() path', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(ReceiptPage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('fires NO event on the rate-limited path', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    await ReceiptPage(props());
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('generateMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(CLIENT_VIEW);
  });

  it('specialises the title only for an authorised viewer, and never indexes', async () => {
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Static analysis walkthrough — Balo');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('falls back to GENERIC_METADATA when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Session receipt — Balo');
  });

  it('falls back to GENERIC_METADATA on a denial', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Session receipt — Balo');
  });

  it('falls back to GENERIC_METADATA when the loader throws', async () => {
    mockLoadSessionStatement.mockRejectedValue(new Error('boom'));
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Session receipt — Balo');
  });

  it('falls back to GENERIC_METADATA when the loader is rate-limited', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Session receipt — Balo');
  });
});

describe('ReceiptPage — what actually renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(CLIENT_VIEW);
  });

  it('renders the statement and the Receipt breadcrumb', async () => {
    const element = await ReceiptPage(props());
    render(element);
    expect(
      screen.getByRole('heading', { name: 'Static analysis walkthrough' })
    ).toBeInTheDocument();
    expect(screen.getByText('Total charged')).toBeInTheDocument();
  });
});

describe('ReceiptPage — NO COUNTERPARTY EMAIL, ANYWHERE (ADR-1044)', () => {
  /** No-regex, linear @-shape detector (SonarCloud S5852) — mirrors the recap page's scanner. */
  function containsEmailShape(text: string): boolean {
    let at = text.indexOf('@');
    while (at !== -1) {
      const before = at === 0 ? ' ' : text.charAt(at - 1);
      const after = at + 1 >= text.length ? ' ' : text.charAt(at + 1);
      const tight = before.trim().length > 0 && after.trim().length > 0;
      if (
        tight &&
        text
          .slice(at + 1)
          .split(' ')[0]
          ?.includes('.') === true
      ) {
        return true;
      }
      at = text.indexOf('@', at + 1);
    }
    return false;
  }

  it('positive control: the detector actually flags a real address', () => {
    expect(containsEmailShape('amara@cloudpeak.example')).toBe(true);
  });

  it('does not flag the required attribution form', () => {
    expect(containsEmailShape('Priya Sharma @ CloudPeak Consulting')).toBe(false);
  });

  it('renders no email shape anywhere in the finalized statement', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadSessionStatement.mockResolvedValue(CLIENT_VIEW);
    const element = await ReceiptPage(props());
    const { container } = render(element);
    expect(containsEmailShape(container.textContent ?? '')).toBe(false);
    expect(containsEmailShape(container.innerHTML)).toBe(false);
  });
});
