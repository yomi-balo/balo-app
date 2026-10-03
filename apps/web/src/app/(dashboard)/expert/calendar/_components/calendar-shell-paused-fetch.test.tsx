import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import { CalendarShell } from './calendar-shell';
import type { CalendarPageView } from '../_lib/calendar-view-types';

/**
 * BAL-591 — the REAL `useExpertAvailability` against a mocked `fetch`, so the read scope the
 * shell chooses is observed end to end. The scope must come from the server-rendered
 * `availableForWork` plus a latch, never from the answer the scope itself produced.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('view=week'),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

const FIXED_NOW = new Date('2026-08-24T00:00:00.000Z');

function pageView(overrides: Partial<CalendarPageView> = {}): CalendarPageView {
  return {
    expertProfileId: 'expert-1',
    timezone: 'Australia/Sydney',
    meetings: [],
    hasConnectedCalendar: true,
    availableForWork: true,
    ...overrides,
  };
}

const READY_BODY = {
  expertProfileId: 'expert-1',
  status: 'ok',
  expertTimezone: 'Australia/Sydney',
  generatedAt: '2026-08-24T00:00:00.000Z',
  windowEnd: '2026-09-07T00:00:00.000Z',
  days: 14,
  slots: [{ start: '2026-08-24T23:00:00.000Z', end: '2026-08-25T06:00:00.000Z', maxDuration: 60 }],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function scopesRequested(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('scope') ?? '');
}

describe('CalendarShell — availability read scope while paused (BAL-591)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('settles after two reads when the page says available but the API answers paused', async () => {
    fetchMock.mockImplementation((url: string) => {
      const scope = new URL(String(url)).searchParams.get('scope');
      return Promise.resolve(
        jsonResponse(scope === 'new_work' ? { status: 'paused' } : READY_BODY)
      );
    });

    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    await waitFor(() => expect(screen.getByText("You're paused.")).toBeInTheDocument());
    await waitFor(() => expect(scopesRequested(fetchMock)).toEqual(['new_work', 'existing_work']));
    // Give any runaway loop room to show itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(screen.getByText("You're paused.")).toBeInTheDocument();
  });

  it('reads existing_work once when the page already says paused', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(READY_BODY)));

    render(
      <CalendarShell
        view={pageView({ availableForWork: false })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scopesRequested(fetchMock)).toEqual(['existing_work']);
  });

  it('reads new_work once and shows no paused treatment when available', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(READY_BODY)));

    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scopesRequested(fetchMock)).toEqual(['new_work']);
    expect(screen.queryByText("You're paused.")).not.toBeInTheDocument();
  });
});
