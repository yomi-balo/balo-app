import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import { AgendaList } from './agenda-list';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';

/** R5 — see the identical mock in `meeting-block.test.tsx`: in jsdom `next/link` renders a plain
 *  anchor, so only this marker fails when someone reverts to a raw `<a href>`. */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}));

/** S1 — the Join affordance navigates instead of rendering an href. jsdom's `Location.assign` is
 *  a non-configurable own property, so the whole `location` object is swapped and restored. */
const realLocation = globalThis.location;
let mockAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockAssign = vi.fn();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
});

function meeting(overrides: Partial<CalendarMeetingView>): CalendarMeetingView {
  return {
    meetingId: 'm-1',
    scheduledStart: '2026-08-25T00:00:00.000Z',
    scheduledEnd: '2026-08-25T00:30:00.000Z',
    contextType: 'case',
    href: '/cases/e1',
    joinUrl: 'https://balo.expert/join/m/m-1',
    counterpartyCompanyName: 'Northwind',
    ...overrides,
  };
}

const NOOP = (): void => {};

describe('AgendaList', () => {
  it('groups rows under Today / Tomorrow date-section headers', () => {
    const today = meeting({
      meetingId: 'today-1',
      scheduledStart: '2026-08-24T05:00:00.000Z',
      scheduledEnd: '2026-08-24T05:30:00.000Z',
    });
    const tomorrow = meeting({
      meetingId: 'tomorrow-1',
      scheduledStart: '2026-08-25T05:00:00.000Z',
      scheduledEnd: '2026-08-25T05:30:00.000Z',
    });

    render(
      <AgendaList
        meetings={[today, tomorrow]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
      />
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
  });

  it('replaces the chevron with a Join button on an imminent row, and not otherwise', () => {
    const imminent = meeting({
      meetingId: 'imminent-1',
      scheduledStart: '2026-08-24T00:10:00.000Z',
      scheduledEnd: '2026-08-24T00:40:00.000Z',
      counterpartyCompanyName: 'Imminent Co',
    });
    const later = meeting({
      meetingId: 'later-1',
      scheduledStart: '2026-08-24T10:00:00.000Z',
      scheduledEnd: '2026-08-24T10:30:00.000Z',
      counterpartyCompanyName: 'Later Co',
    });

    render(
      <AgendaList
        meetings={[imminent, later]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
      />
    );

    expect(
      screen.getByRole('button', { name: /Join Imminent Co's meeting, starting in 10 minutes/i })
    ).toBeInTheDocument();
    // The non-imminent row keeps its chevron (no accessible "Join" control for it).
    expect(
      screen.queryByRole('button', { name: /Join Later Co's meeting/i })
    ).not.toBeInTheDocument();
    // R5 — the row body links through `next/link`, not a raw anchor.
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('data-next-link', 'true');
  });

  it('fires onJoinClick when Join is clicked, and navigates to the tokenless lobby URL', async () => {
    const onJoinClick = vi.fn();
    const imminent = meeting({
      meetingId: 'imminent-2',
      scheduledStart: '2026-08-24T00:05:00.000Z',
      scheduledEnd: '2026-08-24T00:35:00.000Z',
      counterpartyCompanyName: 'Click Co',
    });
    render(
      <AgendaList
        meetings={[imminent]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={onJoinClick}
      />
    );
    const joinButton = screen.getByRole('button', {
      name: /Join Click Co's meeting, starting in 5 minutes/i,
    });
    joinButton.click();
    expect(onJoinClick).toHaveBeenCalledWith(imminent);
    expect(mockAssign).toHaveBeenCalledWith('https://balo.expert/join/m/m-1');
  });

  /**
   * S1 — Agenda is the MOBILE DEFAULT surface, so this is the row that renders most often. An
   * `href` here shipped `/join/m/{meetingId}` to PostHog autocapture
   * (`$elements[].attr__href`, never walked by `sanitizeAnalyticsEvent`) and to Sentry Session
   * Replay's rrweb DOM snapshots (`href` is not in the default `maskAttributes`) on render alone.
   */
  it('renders NO element whose href contains /join/m/ (S1)', () => {
    const imminent = meeting({
      meetingId: 'imminent-4',
      scheduledStart: '2026-08-24T00:05:00.000Z',
      scheduledEnd: '2026-08-24T00:35:00.000Z',
    });
    const { container } = render(
      <AgendaList
        meetings={[imminent]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
      />
    );

    const hrefs = [...container.querySelectorAll('[href]')].map((node) =>
      node.getAttribute('href')
    );
    expect(hrefs).not.toHaveLength(0); // the row body IS still a link — non-vacuous
    expect(hrefs.some((href) => href?.includes('/join/m/'))).toBe(false);
    expect(container.innerHTML).not.toContain('/join/m/');
  });

  it('A1 — the Join control meets the 44px minimum tap target on the mobile-default surface', () => {
    const imminent = meeting({
      meetingId: 'imminent-5',
      scheduledStart: '2026-08-24T00:05:00.000Z',
      scheduledEnd: '2026-08-24T00:35:00.000Z',
    });
    render(
      <AgendaList
        meetings={[imminent]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
      />
    );

    // `size="sm"` alone is 32px tall — under balo-ui's 44×44 NEVER-rule.
    const joinButton = screen.getByRole('button', { name: /Join Northwind's meeting/i });
    expect(joinButton.className).toContain('min-h-11');
    // BAL-511 / ADR-1053 — the ambient live-call ping ring, baked into JoinMeetingButton itself,
    // replacing the old whole-button animate-pulse.
    expect(joinButton.className).toContain('motion-safe:before:animate-ping-slow');
    expect(joinButton.className).toContain('motion-reduce:ring-2');
    expect(joinButton.className).toContain('motion-reduce:ring-primary');
    // ⚠ NO ALPHA MODIFIER. `toContain('motion-reduce:ring-primary')` alone also matches
    // `motion-reduce:ring-primary/40` — the pre-existing value that measures 1.47:1 in light
    // mode, below WCAG 1.4.11's 3:1 floor. This pins FULL opacity so re-adding an alpha fails.
    expect(joinButton.className).not.toContain('motion-reduce:ring-primary/');
    expect(joinButton.className).not.toContain('animate-pulse');
  });

  it('Join reads "starting now" once the meeting has actually started (M1)', () => {
    const started = meeting({
      meetingId: 'started-1',
      scheduledStart: '2026-08-23T23:55:00.000Z',
      scheduledEnd: '2026-08-24T00:25:00.000Z',
      counterpartyCompanyName: 'Live Co',
    });
    render(
      <AgendaList
        meetings={[started]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: /Join Live Co's meeting, starting now/i })
    ).toBeInTheDocument();
  });
});

describe('AgendaList — the "Now" divider inside Today\'s group (H8)', () => {
  it('renders a Now divider between a past row and an upcoming row', () => {
    const past = meeting({
      meetingId: 'past-1',
      scheduledStart: '2026-08-23T22:00:00.000Z',
      scheduledEnd: '2026-08-23T22:30:00.000Z',
      counterpartyCompanyName: 'Earlier Co',
    });
    const upcoming = meeting({
      meetingId: 'upcoming-1',
      scheduledStart: '2026-08-24T02:00:00.000Z',
      scheduledEnd: '2026-08-24T02:30:00.000Z',
      counterpartyCompanyName: 'Later Co',
    });

    render(
      <AgendaList
        meetings={[past, upcoming]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={vi.fn()}
      />
    );

    expect(screen.getByText('Now')).toBeInTheDocument();
  });

  it('renders the Now divider AFTER the last row when every meeting in Today is already past', () => {
    // BAL-498 fix round 2, N6: `nowDividerIndex === dayMeetings.length` used to be unreachable
    // dead code (`findIndex` only ever returns -1 or an index strictly less than `length`), so
    // this exact scenario — every meeting today already ended — rendered NO "Now" marker at all.
    // At 18:00 after a full day of calls, the divider is the one orientation cue on the
    // mobile-default surface (H8); it must render, positioned after the last (past) row.
    const past = meeting({
      meetingId: 'past-1',
      scheduledStart: '2026-08-23T20:00:00.000Z',
      scheduledEnd: '2026-08-23T20:30:00.000Z',
      counterpartyCompanyName: 'Earlier Co',
    });

    render(
      <AgendaList
        meetings={[past]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={vi.fn()}
      />
    );

    const nowDivider = screen.getByText('Now');
    const pastRow = screen.getByText('Earlier Co');
    // `nowDivider` FOLLOWS `pastRow` in DOM order — the divider is AFTER the last row, not
    // merely present somewhere on the page.
    expect(pastRow.compareDocumentPosition(nowDivider)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('AgendaList — accessibility', () => {
  it('has no axe violations across grouped, past, and imminent-Join rows', async () => {
    const past = meeting({
      meetingId: 'past-1',
      scheduledStart: '2026-08-23T22:00:00.000Z',
      scheduledEnd: '2026-08-23T22:30:00.000Z',
    });
    const imminent = meeting({
      meetingId: 'imminent-3',
      scheduledStart: '2026-08-24T00:05:00.000Z',
      scheduledEnd: '2026-08-24T00:35:00.000Z',
    });
    const { container } = render(
      <AgendaList
        meetings={[past, imminent]}
        timezone="Australia/Sydney"
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={vi.fn()}
      />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
