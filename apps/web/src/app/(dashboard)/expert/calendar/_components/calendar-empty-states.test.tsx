import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { NoCalendarConnectedEmptyState, NothingScheduledEmptyState } from './calendar-empty-states';

/** R5 — see `meeting-block.test.tsx`: in jsdom `next/link` renders a plain anchor, so only this
 *  marker fails if someone reverts this in-app settings CTA to a raw `<a href>`. */
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

const trackMock = vi.mocked(track);

describe('NoCalendarConnectedEmptyState', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('renders invitation-framed copy and a CTA to the settings deep link', () => {
    render(<NoCalendarConnectedEmptyState href="/expert/settings?tab=schedule&setup=calendar" />);
    expect(screen.getByText(/Connect a calendar to see your week/i)).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Connect your calendar/i });
    expect(cta).toHaveAttribute('href', '/expert/settings?tab=schedule&setup=calendar');
    // R5 — an ordinary in-app route: client-side navigation, not a full document reload.
    expect(cta).toHaveAttribute('data-next-link', 'true');
  });

  it('fires exactly one calendar_connect_cta_clicked { source: "empty_state" }, and no upkeep event (BAL-512)', async () => {
    const user = userEvent.setup();
    render(<NoCalendarConnectedEmptyState href="/expert/settings?tab=schedule&setup=calendar" />);

    await user.click(screen.getByRole('link', { name: /Connect your calendar/i }));

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, {
      source: 'empty_state',
    });
    // The regression BAL-512 closes: this CONNECTION intent used to be logged as availability
    // UPKEEP (`source: 'empty_state_no_calendar'`), conflating the two funnels in one event.
    expect(trackMock).not.toHaveBeenCalledWith(
      CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED,
      expect.anything()
    );
  });
});

describe('NothingScheduledEmptyState', () => {
  it('renders Week-scoped copy for the week view', () => {
    render(<NothingScheduledEmptyState view="week" />);
    expect(screen.getByText(/Nothing on the calendar this week/i)).toBeInTheDocument();
  });

  it('renders a general status for the agenda view', () => {
    render(<NothingScheduledEmptyState view="agenda" />);
    expect(screen.getByText(/You're all clear/i)).toBeInTheDocument();
  });

  it('never renders a CTA — both possible actions are ticket non-goals', () => {
    render(<NothingScheduledEmptyState view="agenda" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

/**
 * BAL-498 fix round 5, F5. Both copies used to state "Your availability is still visible to
 * clients" unconditionally. That is FALSE for an expert whose profile is unpublished or whose
 * availability is unconfigured — precisely the `not_published` / `not_configured` states the
 * shading surface already models — so the page reassured people about something that was not
 * happening. The claim now rides a signal (`availabilityVisibleToClients`), and its DEFAULT is
 * "don't claim it": a new call site cannot assert it by forgetting the prop.
 */
describe('NothingScheduledEmptyState — the availability reassurance is conditional (F5)', () => {
  const CLAIM = /Your availability is still visible to clients/i;
  const INVITATION = /Bookings will show up here as soon as someone schedules time with you/i;

  it.each(['week', 'agenda'] as const)(
    '%s: makes the claim when the availability endpoint has confirmed bookable time',
    (view) => {
      render(<NothingScheduledEmptyState view={view} availabilityVisibleToClients />);
      expect(screen.getByText(CLAIM)).toBeInTheDocument();
    }
  );

  it.each(['week', 'agenda'] as const)(
    '%s: drops the claim when it is not known true, keeping the invitation-framed half',
    (view) => {
      render(<NothingScheduledEmptyState view={view} availabilityVisibleToClients={false} />);
      expect(screen.queryByText(CLAIM)).not.toBeInTheDocument();
      expect(screen.getByText(INVITATION)).toBeInTheDocument();
    }
  );

  it.each(['week', 'agenda'] as const)(
    '%s: omitting the prop defaults to NOT claiming it (fail-quiet, not fail-reassuring)',
    (view) => {
      render(<NothingScheduledEmptyState view={view} />);
      expect(screen.queryByText(CLAIM)).not.toBeInTheDocument();
    }
  );

  it('is never absence-framed in either arm — no "No X yet" phrasing (CLAUDE.md empty-state rule)', () => {
    for (const claimed of [true, false]) {
      const { unmount } = render(
        <NothingScheduledEmptyState view="agenda" availabilityVisibleToClients={claimed} />
      );
      expect(screen.queryByText(/^No\b/i)).not.toBeInTheDocument();
      expect(screen.getByText(INVITATION)).toBeInTheDocument();
      unmount();
    }
  });
});
