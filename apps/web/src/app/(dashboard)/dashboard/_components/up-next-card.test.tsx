import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockUseViewerClock = vi.fn();
vi.mock('@/hooks/use-viewer-clock', () => ({
  useViewerClock: () => mockUseViewerClock(),
}));

const mockUseRefreshOnFocus = vi.fn();
vi.mock('@/hooks/use-refresh-on-focus', () => ({
  useRefreshOnFocus: () => mockUseRefreshOnFocus(),
}));

import { UpNextCard } from './up-next-card';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import { UP_NEXT_COPY, upNextStartsIn } from '../_lib/up-next-copy';
import type { UpNextRowView, UpNextData, UpNextFooterLink } from '../_lib/up-next-view-types';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const MIN = 60_000;

function row(overrides: Partial<UpNextRowView> = {}): UpNextRowView {
  return {
    meetingId: 'm-1',
    contextType: 'case',
    title: 'Consultation with Priya',
    counterpartyName: 'Priya Sharma',
    counterpartyOrgLabel: 'CloudPeak',
    scheduledStart: new Date(NOW.getTime() + 30 * MIN).toISOString(),
    scheduledEnd: new Date(NOW.getTime() + 60 * MIN).toISOString(),
    status: 'scheduled',
    href: '/cases/eng-1',
    joinPath: '/meetings/m-1/call',
    rescheduleProposalExpiresAt: null,
    roomReady: true,
    ...overrides,
  };
}

const FOOTER_LINKS: readonly UpNextFooterLink[] = [
  { target: 'cases', label: 'Cases', href: '/cases' },
  { target: 'projects', label: 'Projects', href: '/projects' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockUseViewerClock.mockReturnValue({ now: NOW, timeZone: 'UTC' });
});

afterEach(() => {
  // Safety net for tests that install fake timers (`vi.useFakeTimers({ now: NOW })`) so a
  // thrown assertion never leaks fake timers into a later test.
  vi.useRealTimers();
});

describe('UpNextCard — rendering rows', () => {
  it('renders rows in the order given, with title and counterparty', () => {
    const data: UpNextData = {
      kind: 'ready',
      rows: [row({ meetingId: 'a', title: 'First' }), row({ meetingId: 'b', title: 'Second' })],
    };
    render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    const titles = screen.getAllByText(/First|Second/);
    expect(titles.map((el) => el.textContent)).toEqual(['First', 'Second']);
  });

  it('renders an anchor when href is set, and no anchor for an unverified row', () => {
    const data: UpNextData = {
      kind: 'ready',
      rows: [
        row({ meetingId: 'a', href: '/cases/eng-1' }),
        row({ meetingId: 'b', href: null, title: null, counterpartyName: null }),
      ],
    };
    render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    // ⚠ `/cases/` WITH THE TRAILING SLASH, as of BAL-567. The footer link is `/cases` now, so a
    // bare `startsWith('/cases')` also matches it and counts 2. The subject here is the ROW
    // anchor, and a case row's href is always `/cases/{engagementId}`.
    const links = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/cases/') === true);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/cases/eng-1');
  });

  it('fires dashboard_up_next_viewed once, with row_count and meeting_types in tuple order', () => {
    const data: UpNextData = {
      kind: 'ready',
      rows: [row({ contextType: 'project_kickoff' }), row({ meetingId: 'b', contextType: 'case' })],
    };
    render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_VIEWED, {
      workspace_type: 'company',
      row_count: 2,
      meeting_types: ['case', 'project_kickoff'],
    });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('F10: fires dashboard_up_next_viewed exactly once even across re-renders (the viewedRef guard, not the dep array, keeps it once)', () => {
    const data: UpNextData = { kind: 'ready', rows: [row()] };
    const { rerender } = render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    expect(track).toHaveBeenCalledTimes(1);

    // A re-render with the SAME data (e.g. the 60s clock tick) must not re-fire.
    mockUseViewerClock.mockReturnValue({
      now: new Date(NOW.getTime() + MIN),
      timeZone: 'UTC',
    });
    rerender(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    expect(track).toHaveBeenCalledTimes(1);

    // Nor does a `workspaceType` change — now a real effect dependency (F10 removed the
    // exhaustive-deps disable) — cause a second fire; `viewedRef` is what guards it.
    rerender(
      <UpNextCard data={data} workspaceType="expert" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does not fire viewed for the error state', () => {
    render(
      <UpNextCard
        data={{ kind: 'error' }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(track).not.toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_VIEWED, expect.anything());
  });
});

describe('UpNextCard — Join affordance', () => {
  it('shows Join only for a row inside the join window, and no a[href*="/join/"] ever appears', () => {
    const joinable = row({
      meetingId: 'joinable',
      scheduledStart: new Date(NOW.getTime() + 10 * MIN).toISOString(),
    });
    const notYet = row({
      meetingId: 'not-yet',
      scheduledStart: new Date(NOW.getTime() + 60 * MIN).toISOString(),
    });
    const data: UpNextData = { kind: 'ready', rows: [joinable, notYet] };
    render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    const joinButtons = screen.getAllByTestId('calendar-join');
    expect(joinButtons).toHaveLength(1);
    expect(document.querySelector('a[href*="/join/"]')).toBeNull();
  });

  it('BAL-581 — an in-window row with roomReady:false renders the setting-up slot, no Join, and is not featured', () => {
    const notReady = row({
      meetingId: 'not-ready',
      scheduledStart: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      roomReady: false,
    });
    const { container } = render(
      <UpNextCard
        data={{ kind: 'ready', rows: [notReady] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.queryByTestId('calendar-join')).not.toBeInTheDocument();
    expect(screen.getByText('Setting up room')).toBeInTheDocument();
    // Not featured: the card features only a row whose Join is visible.
    expect(container.querySelectorAll('.bg-success\\/10')).toHaveLength(0);
  });

  it('Join is absent entirely while clock is null (SSR pass)', () => {
    mockUseViewerClock.mockReturnValue(null);
    const data: UpNextData = { kind: 'ready', rows: [row()] };
    render(
      <UpNextCard data={data} workspaceType="company" subtitle="sub" footerLinks={FOOTER_LINKS} />
    );
    expect(screen.queryByTestId('calendar-join')).toBeNull();
  });

  it('clicking Join calls location.assign with the exact /meetings/<id>/call literal and tracks the real row_state', () => {
    // F1/F3(a) — `new Date()` inside the row's click handler must resolve to the SAME instant the
    // clock mock reports, so `row_state` is asserted exactly rather than with `expect.any(String)`.
    vi.useFakeTimers({ now: NOW });
    const realLocation = globalThis.location;
    const mockAssign = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
    });

    // 10 minutes out: inside the join window, not yet live — 'starting_soon'.
    const joinable = row({
      meetingId: 'm-1',
      scheduledStart: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      joinPath: '/meetings/m-1/call',
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [joinable] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    fireEvent.click(screen.getByTestId('calendar-join'));

    expect(mockAssign).toHaveBeenCalledWith('/meetings/m-1/call');
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'join',
      meeting_type: 'case',
      row_state: 'starting_soon',
    });

    Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
    vi.useRealTimers();
  });

  it('clicking Join on a row already underway tracks row_state: happening_now', () => {
    vi.useFakeTimers({ now: NOW });
    const realLocation = globalThis.location;
    const mockAssign = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
    });

    // Started 5 minutes ago, still inside the overrun grace window — 'happening_now'.
    const live = row({
      meetingId: 'm-live',
      scheduledStart: new Date(NOW.getTime() - 5 * MIN).toISOString(),
      scheduledEnd: new Date(NOW.getTime() + 25 * MIN).toISOString(),
      status: 'in_progress',
      joinPath: '/meetings/m-live/call',
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [live] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    fireEvent.click(screen.getByTestId('calendar-join'));

    expect(mockAssign).toHaveBeenCalledWith('/meetings/m-live/call');
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'join',
      meeting_type: 'case',
      row_state: 'happening_now',
    });

    Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
    vi.useRealTimers();
  });

  it('clicking a row link tracks target: row with the real meeting_type and row_state', () => {
    vi.useFakeTimers({ now: NOW });
    const joinable = row({
      meetingId: 'm-row',
      contextType: 'project_kickoff',
      scheduledStart: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      href: '/engagements/eng-9',
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [joinable] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    const rowLink = screen
      .getAllByRole('link')
      .find((l) => l.getAttribute('href') === '/engagements/eng-9');
    if (rowLink === undefined) throw new Error('row link not found');
    fireEvent.click(rowLink);

    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'row',
      meeting_type: 'project_kickoff',
      row_state: 'starting_soon',
    });
    vi.useRealTimers();
  });

  it('F3(d): the featured highlight class is on the FIRST joinable row only, not the second', () => {
    const first = row({
      meetingId: 'first',
      scheduledStart: new Date(NOW.getTime() + 5 * MIN).toISOString(),
    });
    const second = row({
      meetingId: 'second',
      scheduledStart: new Date(NOW.getTime() + 8 * MIN).toISOString(),
    });
    const { container } = render(
      <UpNextCard
        data={{ kind: 'ready', rows: [first, second] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    const joinButtons = screen.getAllByTestId('calendar-join');
    expect(joinButtons).toHaveLength(2); // both rows are inside the join window — non-vacuous

    // The featured wrapper carries `bg-success/10` (up-next-row.tsx); a plain row does not.
    const featuredRows = container.querySelectorAll('.bg-success\\/10');
    expect(featuredRows).toHaveLength(1);
    const [featuredRow] = featuredRows;
    expect(featuredRow).toBeDefined();
    expect(featuredRow?.contains(joinButtons[0] ?? null)).toBe(true);
    expect(featuredRow?.contains(joinButtons[1] ?? null)).toBe(false);
  });
});

describe('UpNextCard — Empty state', () => {
  it('company: shows "Nothing booked", the body copy, and a Find an expert link that tracks find_expert', async () => {
    const user = userEvent.setup();
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.getByText('Nothing booked')).toBeInTheDocument();
    expect(screen.getByText('Find an expert and pick a time.')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: 'Find an expert' });
    expect(cta).toHaveAttribute('href', '/experts');
    await user.click(cta);
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'find_expert',
      meeting_type: null,
      row_state: null,
    });
  });

  it('expert: shows the body copy, no CTA button', () => {
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [] }}
        workspaceType="expert"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.getByText('New bookings show up here and in Calendar.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Find an expert' })).toBeNull();
  });
});

describe('UpNextCard — error state', () => {
  it('shows the error copy and a Try again button that calls router.refresh()', async () => {
    const user = userEvent.setup();
    render(
      <UpNextCard
        data={{ kind: 'error' }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.getByText('We couldn’t load your upcoming meetings.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('UpNextCard — F3(c) rendered row DOM content', () => {
  it('renders primary/secondary time text, the status line, the reschedule note (company copy) and the org label', () => {
    // Today, joinable, with a live pending reschedule proposal.
    const todayRow = row({
      meetingId: 'today',
      scheduledStart: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      scheduledEnd: new Date(NOW.getTime() + 40 * MIN).toISOString(),
      status: 'scheduled',
      rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
      counterpartyName: 'Priya Sharma',
      counterpartyOrgLabel: 'CloudPeak',
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [todayRow] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );

    expect(screen.getByText('Today, 12:10 pm')).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText(upNextStartsIn(10))).toBeInTheDocument();
    expect(screen.getByText(UP_NEXT_COPY.company.rescheduleNote)).toBeInTheDocument();
    expect(screen.getByText('CloudPeak', { exact: false })).toBeInTheDocument();
  });

  it('renders "Happening now" for a live row, and the expert-workspace reschedule copy', () => {
    // `status: 'scheduled'` deliberately, NOT 'in_progress': `deriveCaseConsultationState`
    // short-circuits 'in_progress' to that state before it ever looks at the reschedule
    // proposal (case-surface.ts), so a row that must show BOTH "Happening now" (via
    // `signedMinutes <= 0`, independent of status) AND the reschedule note needs a still-
    // 'scheduled' row whose start has merely already passed.
    const liveRow = row({
      meetingId: 'live',
      scheduledStart: new Date(NOW.getTime() - 5 * MIN).toISOString(),
      scheduledEnd: new Date(NOW.getTime() + 25 * MIN).toISOString(),
      status: 'scheduled',
      rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [liveRow] }}
        workspaceType="expert"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );

    expect(screen.getByText('Happening now')).toBeInTheDocument();
    expect(screen.getByText(UP_NEXT_COPY.expert.rescheduleNote)).toBeInTheDocument();
  });

  it('renders a non-today/tomorrow row as "{weekday} {day} {month}" + "{time}, {duration} min"', () => {
    // NOW is Thursday 2026-09-17; five days out lands on Tuesday 2026-09-22 — neither today nor
    // tomorrow, so the row falls back to the full-date format.
    const datedRow = row({
      meetingId: 'dated',
      scheduledStart: '2026-09-22T15:00:00.000Z',
      scheduledEnd: '2026-09-22T15:45:00.000Z',
    });
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [datedRow] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );

    expect(screen.getByText('Tue 22 Sep')).toBeInTheDocument();
    expect(screen.getByText('3:00 pm, 45 min')).toBeInTheDocument();
  });
});

describe('UpNextCard — footer links', () => {
  it('renders each footer link and tracks the click with its target', async () => {
    const user = userEvent.setup();
    render(
      <UpNextCard
        data={{ kind: 'ready', rows: [] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    await user.click(screen.getByRole('link', { name: /Cases/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.UP_NEXT_CLICKED, {
      target: 'cases',
      meeting_type: null,
      row_state: null,
    });
  });

  /** The strip is a border: with no links it would draw a bare rule above the card edge. */
  it('renders no footer strip at all when there are no links', () => {
    // Expert workspace: its Empty state carries no CTA link, so any link found here is a
    // footer link (the company Empty state renders "Find an expert").
    const { container, rerender } = render(
      <UpNextCard
        data={{ kind: 'ready', rows: [] }}
        workspaceType="expert"
        subtitle="sub"
        footerLinks={[]}
      />
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelectorAll('.border-t')).toHaveLength(0);

    // Guard-the-guard: the same query DOES find the strip once links exist, so the assertion
    // above cannot pass because `.border-t` is simply never used here.
    rerender(
      <UpNextCard
        data={{ kind: 'ready', rows: [] }}
        workspaceType="expert"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(container.querySelectorAll('.border-t')).toHaveLength(1);
    expect(screen.queryAllByRole('link')).toHaveLength(FOOTER_LINKS.length);
  });
});

describe('UpNextCard — D10 tick behaviour', () => {
  it('advancing the clock moves a row from upcoming to starting_soon and eventually drops it', () => {
    const nearRow = row({
      meetingId: 'near',
      scheduledStart: new Date(NOW.getTime() + 20 * MIN).toISOString(),
      scheduledEnd: new Date(NOW.getTime() + 50 * MIN).toISOString(),
    });
    const { rerender } = render(
      <UpNextCard
        data={{ kind: 'ready', rows: [nearRow] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.queryByTestId('calendar-join')).toBeNull();

    mockUseViewerClock.mockReturnValue({
      now: new Date(NOW.getTime() + 10 * MIN),
      timeZone: 'UTC',
    });
    rerender(
      <UpNextCard
        data={{ kind: 'ready', rows: [nearRow] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    expect(screen.getByTestId('calendar-join')).toBeInTheDocument();

    mockUseViewerClock.mockReturnValue({
      now: new Date(NOW.getTime() + 85 * MIN),
      timeZone: 'UTC',
    });
    rerender(
      <UpNextCard
        data={{ kind: 'ready', rows: [nearRow] }}
        workspaceType="company"
        subtitle="sub"
        footerLinks={FOOTER_LINKS}
      />
    );
    // F3(e) — `nearRow`'s title was never "First" (that literal belonged to an unrelated test's
    // fixture, making the original assertion vacuous); assert against the row's OWN title.
    expect(screen.queryByText(nearRow.title ?? '')).toBeNull();
    expect(screen.getByText('Nothing booked')).toBeInTheDocument();
  });
});
