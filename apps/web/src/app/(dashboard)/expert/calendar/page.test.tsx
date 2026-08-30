import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import type { CalendarPageView } from './_lib/calendar-view-types';

// ── Seams the page composes (mirrors the (dashboard)/engagements/page.test.tsx precedent) ──
const {
  mockGetCurrentUser,
  mockRedirect,
  mockLogError,
  mockResolveTimezone,
  mockLoadExpertCalendar,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  // redirect() must THROW so control flow stops, exactly like Next.
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockLogError: vi.fn(),
  mockResolveTimezone: vi.fn(),
  mockLoadExpertCalendar: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError } }));
vi.mock('./_lib/load-expert-calendar', () => ({
  resolveExpertScheduleTimezone: mockResolveTimezone,
  loadExpertCalendar: mockLoadExpertCalendar,
}));
// Stub the heavy client shell — this stays a unit test of the page's gating + timezone-first
// week resolution (B3), not of CalendarShell's own behaviour (covered in calendar-shell.test.tsx).
vi.mock('./_components/calendar-shell', () => ({
  CalendarShell: ({ initialWeekStartDayKey }: { initialWeekStartDayKey: string }) => (
    <div data-testid="calendar-shell" data-week={initialWeekStartDayKey} />
  ),
}));

import ExpertCalendarPage from './page';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'expert@example.com',
    firstName: 'Ex',
    lastName: 'Pert',
    avatarUrl: null,
    activeMode: 'expert',
    onboardingCompleted: true,
    platformRole: 'user',
    expertProfileId: 'expert-1',
    companyId: 'company-1',
    companyName: 'Northwind',
    companyRole: 'member',
    ...overrides,
  };
}

function view(overrides: Partial<CalendarPageView> = {}): CalendarPageView {
  return {
    expertProfileId: 'expert-1',
    timezone: 'Australia/Sydney',
    meetings: [],
    hasConnectedCalendar: true,
    ...overrides,
  };
}

async function renderPage(searchParams: { view?: string; week?: string } = {}) {
  const ui = await ExpertCalendarPage({ searchParams: Promise.resolve(searchParams) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveTimezone.mockResolvedValue('Australia/Sydney');
  mockLoadExpertCalendar.mockResolvedValue(view());
});

describe('ExpertCalendarPage (RSC) — auth gate', () => {
  it('redirects an anonymous request to /dashboard — the SAME destination expert/layout.tsx uses (R6)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    // Unified deliberately: Next renders layout and page CONCURRENTLY, so a page sending
    // anonymous traffic to `/login` while the layout sent it to `/dashboard` made the
    // destination a race. The `(dashboard)` middleware forwards on to `/login` from there.
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    expect(mockLoadExpertCalendar).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard when the session has no expertProfileId', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ expertProfileId: undefined }));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  /**
   * AC4's ROUTE half, previously proven by nothing (review WARNING / security LOW). The layout
   * catches this case, so there is no hole — but the page must catch it too: Next renders layout
   * and page concurrently, so without this gate `loadExpertCalendar`'s three-way DB fan-out still
   * executes for a session the layout is already redirecting away. Every sibling action in this
   * segment re-checks both conditions (`save-schedule.ts`, `save-rate.ts`).
   */
  it('redirects a CLIENT-mode session to /dashboard even when it carries an expertProfileId, and never touches the loader (R7 / AC4)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ activeMode: 'client', expertProfileId: 'expert-1' })
    );

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    expect(mockLoadExpertCalendar).not.toHaveBeenCalled();
    // The timezone read is part of the same fan-out and must not fire either.
    expect(mockResolveTimezone).not.toHaveBeenCalled();
  });
});

describe('ExpertCalendarPage (RSC) — week resolution (B3: timezone-first)', () => {
  it('resolves the timezone BEFORE computing "today" — a UTC-adjacent Sydney evening lands on the RIGHT week, not the one before', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockResolveTimezone.mockResolvedValue('Australia/Sydney');
    vi.setSystemTime(new Date('2026-08-23T22:00:00.000Z')); // Mon 2026-08-24 08:00 AEST
    vi.useFakeTimers();

    try {
      await renderPage();
    } finally {
      vi.useRealTimers();
    }

    // Second argument is the SESSION user id — S3's scoped `expert_profiles` read.
    expect(mockResolveTimezone).toHaveBeenCalledWith('expert-1', 'user-1');
    const [call] = mockLoadExpertCalendar.mock.calls as [{ weekStartDayKey: string }][];
    if (call === undefined) throw new Error('loadExpertCalendar was not called');
    // Monday-anchored week for 2026-08-24 local (NOT 2026-08-23, which the old UTC('today') bug
    // would have produced).
    expect(call[0].weekStartDayKey).toBe('2026-08-24');
  });

  it('honours a valid ?week= param over the resolved-timezone default', async () => {
    mockGetCurrentUser.mockResolvedValue(user());

    await renderPage({ week: '2026-09-07' });

    const [call] = mockLoadExpertCalendar.mock.calls as [{ weekStartDayKey: string }][];
    if (call === undefined) throw new Error('loadExpertCalendar was not called');
    expect(call[0].weekStartDayKey).toBe('2026-09-07');
  });

  it('falls back to the resolved-timezone default when ?week= is shape-invalid or not a real calendar date (M4)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    vi.setSystemTime(new Date('2026-08-23T22:00:00.000Z'));
    vi.useFakeTimers();

    try {
      await renderPage({ week: '9999-99-99' });
    } finally {
      vi.useRealTimers();
    }

    const [call] = mockLoadExpertCalendar.mock.calls as [{ weekStartDayKey: string }][];
    if (call === undefined) throw new Error('loadExpertCalendar was not called');
    expect(call[0].weekStartDayKey).toBe('2026-08-24');
  });

  /**
   * S2 — `?week=1000-01-01` is a REAL calendar date, so it passed both `DAY_KEY_PATTERN` and
   * `isValidDayKey` and opened a ~1000-year repository window: every meeting the expert has ever
   * had, with no `LIMIT`, sorted in memory and serialised whole into the RSC payload. Nothing
   * rate-limits an RSC render the way `availabilityRateLimit` guards the API endpoint.
   * (`0001-01-01` is already rejected — `Date.UTC` remaps years 0-99 to 1900+n — so a repro needs
   * a 4-digit year ≥ 100.)
   */
  it.each([['1000-01-01'], ['3000-01-01']])(
    'discards a far-out ?week=%s and falls back to the current week',
    async (week) => {
      mockGetCurrentUser.mockResolvedValue(user());
      vi.setSystemTime(new Date('2026-08-23T22:00:00.000Z'));
      vi.useFakeTimers();

      try {
        await renderPage({ week });
      } finally {
        vi.useRealTimers();
      }

      const [call] = mockLoadExpertCalendar.mock.calls as [{ weekStartDayKey: string }][];
      if (call === undefined) throw new Error('loadExpertCalendar was not called');
      expect(call[0].weekStartDayKey).toBe('2026-08-24');
    }
  );

  it('still honours a ?week= just inside the ±1-year bound', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    vi.setSystemTime(new Date('2026-08-23T22:00:00.000Z')); // Mon 2026-08-24 AEST
    vi.useFakeTimers();

    try {
      // 2027-08-01 is ~342 days out — inside the bound, so it must NOT be clamped away.
      await renderPage({ week: '2027-08-01' });
    } finally {
      vi.useRealTimers();
    }

    const [call] = mockLoadExpertCalendar.mock.calls as [{ weekStartDayKey: string }][];
    if (call === undefined) throw new Error('loadExpertCalendar was not called');
    expect(call[0].weekStartDayKey).toBe('2027-07-26');
  });

  it('threads the SESSION user id into the loader so the expert_profiles read is scoped (S3)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());

    await renderPage({ week: '2026-09-07' });

    expect(mockResolveTimezone).toHaveBeenCalledWith('expert-1', 'user-1');
    expect(mockLoadExpertCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: 'expert-1', userId: 'user-1' })
    );
  });

  it('renders CalendarShell with the resolved week once the loader succeeds', async () => {
    mockGetCurrentUser.mockResolvedValue(user());

    await renderPage({ week: '2026-09-07' });

    expect(screen.getByTestId('calendar-shell')).toHaveAttribute('data-week', '2026-09-07');
  });
});

describe('ExpertCalendarPage (RSC) — loader failure', () => {
  it('logs and rethrows so error.tsx renders, never swallowing the failure', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const failure = new Error('db unreachable');
    mockLoadExpertCalendar.mockRejectedValue(failure);

    await expect(renderPage()).rejects.toThrow('db unreachable');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load expert calendar',
      expect.objectContaining({ expertProfileId: 'expert-1' })
    );
  });
});
