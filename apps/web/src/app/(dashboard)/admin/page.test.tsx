import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-548 / ADR-1055 — `admin/page.tsx` REPLACES the BAL-534 redirect-to-catalogue page. That
 * old suite (asserting `redirect('/admin/catalogue')`) is deleted wholesale, not amended — this
 * file is its full replacement, per the rulings' explicit note.
 */

const { mockGetCurrentUser, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { mockCountOpenByKind, mockListOpenPage, mockListTicks } = vi.hoisted(() => ({
  mockCountOpenByKind: vi.fn(),
  mockListOpenPage: vi.fn(),
  mockListTicks: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: {
    countOpenByKind: (...a: unknown[]) => mockCountOpenByKind(...a),
    listOpenPage: (...a: unknown[]) => mockListOpenPage(...a),
  },
  adminSweepTicksRepository: {
    listTicks: (...a: unknown[]) => mockListTicks(...a),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./_actions/close-admin-alert', () => ({ closeAdminAlert: vi.fn() }));
vi.mock('./_actions/load-more-admin-alerts', () => ({ loadMoreAdminAlerts: vi.fn() }));

import { log } from '@/lib/logging';
import AdminHomePage from './page';

/**
 * ⚠ AGE FIXTURES MUST BE RELATIVE TO NOW, NEVER A HARD-CODED CALENDAR DATE.
 *
 * The header line and the warm CTA both render an age DERIVED from `first_seen_at` against the
 * wall clock, so a literal like `new Date('2026-09-05')` paired with an `oldest waiting 3d`
 * assertion is only true on one calendar day — it passed the day it was written and started
 * failing three days later, in a suite nobody had touched. Anchor every age fixture to `Date.now()`
 * so the assertion means "3 days old" rather than "the 5th".
 */
const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'admin-1',
    email: 'admin@balo.expert',
    firstName: 'Adeeb',
    lastName: 'Support',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'owner',
    ...overrides,
  };
}

function alertRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'expert.application_pending',
    entityType: 'expert',
    entityId: 'expert-1',
    detail: {
      title: 'An application is waiting on review',
      entityLabel: 'Priya Nair @ CloudPeak',
      evidence: 'Submitted 3 days ago, no reviewer assigned.',
      facts: [['Submitted', '3d ago']],
    },
    firstSeenAt: daysAgo(3),
    lastSeenAt: daysAgo(3),
    occurrences: 1,
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
    deletedAt: null,
    ...overrides,
  };
}

async function renderPage(sp: { group?: string; open?: string } = {}) {
  const ui = await AdminHomePage({ searchParams: Promise.resolve(sp) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  mockGetCurrentUser.mockResolvedValue(user());
  mockCountOpenByKind.mockResolvedValue([
    {
      kind: 'expert.application_pending',
      count: 1,
      oldestFirstSeenAt: daysAgo(3),
    },
  ]);
  mockListOpenPage.mockResolvedValue({ alerts: [alertRow('a-1')], hasMore: false });
  mockListTicks.mockResolvedValue([
    { cadence: '1m', lastTickAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
  ]);
});

describe('AdminHomePage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('notFound()s for a non-staff viewer, without reading the queue', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockCountOpenByKind).not.toHaveBeenCalled();
  });
});

describe('AdminHomePage (RSC) — render', () => {
  it('renders the heading, header line, and a row from the queue', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(
      screen.getByText(/1 open · 0 close with a note · oldest waiting 3d/)
    ).toBeInTheDocument();
    expect(screen.getByText('An application is waiting on review')).toBeInTheDocument();
  });

  it('renders the warm "Waiting…" CTA targeting the oldest item, clearing the filter', async () => {
    await renderPage();
    const cta = screen.getByRole('link', { name: /Waiting 3d · Priya Nair/ });
    expect(cta).toHaveAttribute('href', '/admin?open=a-1');
  });

  it('renders the four group tiles', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: /Marketplace/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Money/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Capture/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Meetings & calendar/ })).toBeInTheDocument();
  });

  it('shows the true-zero empty state and no warm CTA when nothing is open', async () => {
    mockCountOpenByKind.mockResolvedValue([]);
    mockListOpenPage.mockResolvedValue({ alerts: [], hasMore: false });
    await renderPage();
    expect(screen.getByText('Nothing needs a person right now')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Waiting/ })).not.toBeInTheDocument();
  });

  it('filters server-side by kind when a group is active, and fetches the global-oldest separately', async () => {
    mockListOpenPage.mockImplementation((args: { kinds?: string[]; limit: number }) => {
      if (args.limit === 1) {
        return Promise.resolve({
          alerts: [
            alertRow('global-oldest', {
              detail: { title: 't', entityLabel: 'Global Oldest', evidence: 'e', facts: [] },
            }),
          ],
          hasMore: false,
        });
      }
      return Promise.resolve({ alerts: [alertRow('a-1')], hasMore: false });
    });
    await renderPage({ group: 'marketplace' });

    const [firstCall] = mockListOpenPage.mock.calls;
    expect(firstCall?.[0].kinds).toEqual(expect.arrayContaining(['expert.application_pending']));
    expect(screen.getByRole('link', { name: /Waiting 3d · Global Oldest/ })).toHaveAttribute(
      'href',
      '/admin?open=global-oldest'
    );
    expect(screen.getByRole('link', { name: 'Back to all' })).toHaveAttribute('href', '/admin');
  });

  it('shows the filtered-empty state when a filter matches nothing', async () => {
    mockCountOpenByKind.mockResolvedValue([
      {
        kind: 'recording.failed',
        count: 1,
        oldestFirstSeenAt: daysAgo(3),
      },
    ]);
    mockListOpenPage.mockImplementation((args: { limit: number }) =>
      args.limit === 1
        ? Promise.resolve({
            alerts: [alertRow('a-1', { kind: 'recording.failed' })],
            hasMore: false,
          })
        : Promise.resolve({ alerts: [], hasMore: false })
    );
    await renderPage({ group: 'marketplace' });
    expect(screen.getByText('Nothing open in marketplace')).toBeInTheDocument();
  });

  it('ignores an unknown ?group= value (resolves to unfiltered, never a 404)', async () => {
    await renderPage({ group: 'not-a-real-group' });
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(screen.getByText('An application is waiting on review')).toBeInTheDocument();
  });

  it('renders the sweep disclosure', async () => {
    await renderPage();
    expect(screen.getByText(/Oldest first/)).toBeInTheDocument();
  });

  it('renders the in-page error state and logs on a read failure, without throwing', async () => {
    mockCountOpenByKind.mockRejectedValue(new Error('DB down'));
    await renderPage();
    expect(screen.getByText("Home didn't load")).toBeInTheDocument();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load the admin pending-actions queue',
      expect.objectContaining({ actorUserId: 'admin-1', error: 'DB down' })
    );
  });
});

describe('AdminHomePage (RSC) — B-F2: the row list follows a soft-navigation filter change', () => {
  /**
   * BAL-548 fix round (B-F2). `AlertQueue` is a client component that seeds its row list from
   * `useState(initialRows)` at mount only. `page.tsx` renders it at the same JSX position on
   * every `?group=` change (a same-route-segment `<Link>` navigation) — so without a `key` that
   * varies with the filter, React preserves the component instance across the two server
   * renders below and the row list would keep showing the FIRST render's rows even though the
   * second render's `view.rows` are entirely different.
   *
   * This reproduces that soft navigation for real: render the first page's resolved JSX with
   * RTL, then `rerender()` the SECOND page's resolved JSX into the SAME container — exactly
   * what Next.js does on a client-side navigation within `(dashboard)/admin`. It does not
   * simply re-mount a fresh tree per call, so it is sensitive to whether `page.tsx` gives
   * `<AlertQueue>` a `key`.
   */
  it('replaces the visible rows when the group filter changes via a soft navigation', async () => {
    mockCountOpenByKind.mockResolvedValue([
      {
        kind: 'expert.application_pending',
        count: 1,
        oldestFirstSeenAt: daysAgo(3),
      },
      {
        kind: 'recording.failed',
        count: 1,
        oldestFirstSeenAt: daysAgo(3),
      },
    ]);
    mockListOpenPage.mockImplementation((args: { kinds?: readonly string[]; limit?: number }) => {
      if (args.limit === 1) {
        return Promise.resolve({ alerts: [], hasMore: false });
      }
      if (args.kinds !== undefined) {
        return Promise.resolve({
          alerts: [
            alertRow('filtered-1', {
              kind: 'recording.failed',
              detail: {
                title: 'A recording failed to upload',
                entityLabel: 'Session 9 @ Northwind',
                evidence: 'Retries exhausted.',
                facts: [],
              },
            }),
          ],
          hasMore: false,
        });
      }
      return Promise.resolve({ alerts: [alertRow('a-1')], hasMore: false });
    });

    const unfilteredUi = await AdminHomePage({ searchParams: Promise.resolve({}) });
    const { rerender } = render(unfilteredUi);
    expect(screen.getByText('An application is waiting on review')).toBeInTheDocument();
    expect(screen.queryByText('A recording failed to upload')).not.toBeInTheDocument();

    const filteredUi = await AdminHomePage({
      searchParams: Promise.resolve({ group: 'capture' }),
    });
    rerender(filteredUi);

    expect(screen.queryByText('An application is waiting on review')).not.toBeInTheDocument();
    expect(screen.getByText('A recording failed to upload')).toBeInTheDocument();
  });
});
