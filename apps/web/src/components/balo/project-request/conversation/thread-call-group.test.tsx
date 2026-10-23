import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@/test/utils';
import { joinCountdownLabel } from '@/lib/calendar/join-window';
import { formatNextCallWhen } from '@/app/(dashboard)/dashboard/_lib/up-next-presentation';
import type { UpcomingCallView } from '@/lib/project-request/conversation-view-types';
import type { ViewerClock } from '@/hooks/use-viewer-clock';
import type { CallSlot } from './thread-actions';
import { CallGroup, NextCallLine } from './thread-call-group';

const { clockRef } = vi.hoisted(() => ({ clockRef: { value: null as ViewerClock | null } }));
vi.mock('@/hooks/use-viewer-clock', () => ({ useViewerClock: () => clockRef.value }));

/** Tue 27 Oct 2026, 10:00 — one fixed "now" so every label is deterministic. */
const NOW = new Date('2026-10-27T10:00:00.000Z');
const CLOCK: ViewerClock = { now: NOW, timeZone: 'UTC' };

function callAt(meetingId: string, iso: string, contextType: UpcomingCallView['contextType']) {
  return { meetingId, scheduledStartIso: iso, contextType } satisfies UpcomingCallView;
}

/** The design's call scenarios, :111-119. */
const SCENARIOS = {
  window: callAt('m-window', '2026-10-27T10:01:00.000Z', 'request_interaction'),
  m40: callAt('m-40', '2026-10-27T10:40:00.000Z', 'request_interaction'),
  h3: callAt('m-3h', '2026-10-27T13:00:00.000Z', 'request_interaction'),
  d1: callAt('m-d1', '2026-10-28T14:00:00.000Z', 'request_interaction'),
  d2: callAt('m-d2', '2026-10-29T11:00:00.000Z', 'project_call'),
} as const;

function upcomingSlot(
  calls: readonly UpcomingCallView[],
  canBookAnother = true
): Extract<CallSlot, { kind: 'upcoming' }> {
  const [next] = calls;
  if (next === undefined) throw new Error('scenario needs a call');
  return { kind: 'upcoming', next, more: calls.length - 1, canBookAnother };
}

interface GroupOverrides {
  slot: CallSlot;
  mobile?: boolean;
  callPending?: boolean;
  profileBookingHref?: string | null;
}

function renderGroup(o: GroupOverrides) {
  const handlers = { onCall: vi.fn(), onBookAnother: vi.fn(), onJoin: vi.fn() };
  render(
    <CallGroup
      slot={o.slot}
      mobile={o.mobile ?? false}
      callPending={o.callPending ?? false}
      profileBookingHref={o.profileBookingHref ?? null}
      expertFirstName="Priya"
      joinPartyLabel="Priya Nair"
      {...handlers}
    />
  );
  return handlers;
}

afterEach(() => {
  clockRef.value = null;
});

describe('CallGroup — one Join slot per scenario', () => {
  it('inside the window it is a live button, not aria-disabled, with a "Join now" label', () => {
    clockRef.value = CLOCK;
    renderGroup({ slot: upcomingSlot([SCENARIOS.window]) });

    const join = screen.getByRole('button', { name: /Join Priya Nair's meeting/ });
    expect(join).toHaveTextContent('Join now');
    expect(join).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
  });

  it.each([
    ['m40', 'Join in 40 minutes'],
    ['h3', 'Join in 3 hours'],
    ['d1', 'Join tomorrow'],
    ['d2', 'Join in 2 days'],
  ] as const)('outside the window (%s) it is the aria-disabled countdown "%s"', (key, label) => {
    clockRef.value = CLOCK;
    renderGroup({ slot: upcomingSlot([SCENARIOS[key]]) });

    const countdown = screen.getByTestId('join-countdown');
    expect(countdown).toHaveTextContent(label);
    expect(label).toBe(joinCountdownLabel(NOW, new Date(SCENARIOS[key].scheduledStartIso)));
    expect(countdown).toHaveAttribute('aria-disabled', 'true');
    expect(countdown).not.toHaveAttribute('disabled');
    expect(screen.getAllByTestId(/^(join-countdown|calendar-join)$/)).toHaveLength(1);
  });

  it('shows the bare "Join" countdown until the viewer clock resolves', () => {
    renderGroup({ slot: upcomingSlot([SCENARIOS.d2]) });
    expect(screen.getByTestId('join-countdown')).toHaveTextContent(/^Join$/);
  });

  it('reports the joined call on click inside the window', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: realLocation.href, origin: realLocation.origin, assign },
    });
    clockRef.value = CLOCK;
    const { onJoin } = renderGroup({ slot: upcomingSlot([SCENARIOS.window]) });

    await user.click(screen.getByRole('button', { name: /Join Priya Nair's meeting/ }));

    expect(onJoin).toHaveBeenCalledWith(SCENARIOS.window);
    expect(assign).toHaveBeenCalledWith('/meetings/m-window/call');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
  });

  it('desktop sizes the group at 36px; mobile at 44px with a 44px icon button', () => {
    clockRef.value = CLOCK;
    const { unmount } = render(
      <CallGroup
        slot={upcomingSlot([SCENARIOS.d1])}
        mobile={false}
        callPending={false}
        profileBookingHref={null}
        expertFirstName="Priya"
        joinPartyLabel="Priya Nair"
        onCall={vi.fn()}
        onBookAnother={vi.fn()}
        onJoin={vi.fn()}
      />
    );
    expect(screen.getByTestId('join-countdown').className).toContain('min-h-9');
    expect(screen.getByRole('button', { name: 'Book another call' }).className).toContain('h-9');
    unmount();

    renderGroup({ slot: upcomingSlot([SCENARIOS.d1]), mobile: true });
    expect(screen.getByTestId('join-countdown').className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Book another call' }).className).toContain('w-11');
  });

  it('omits Book another call when the slot says the viewer cannot book', () => {
    clockRef.value = CLOCK;
    renderGroup({ slot: upcomingSlot([SCENARIOS.d1], false) });
    expect(screen.queryByRole('button', { name: 'Book another call' })).not.toBeInTheDocument();
  });

  it('Book another call fires onBookAnother and has a tooltip-backed name', async () => {
    const user = userEvent.setup();
    clockRef.value = CLOCK;
    const { onBookAnother } = renderGroup({ slot: upcomingSlot([SCENARIOS.d1]) });
    await user.click(screen.getByRole('button', { name: 'Book another call' }));
    expect(onBookAnother).toHaveBeenCalledTimes(1);
  });
});

describe('CallGroup — the other slots', () => {
  it('renders nothing for none', () => {
    const { container } = render(
      <CallGroup
        slot={{ kind: 'none' }}
        mobile={false}
        callPending={false}
        profileBookingHref={null}
        expertFirstName="Priya"
        joinPartyLabel="Priya Nair"
        onCall={vi.fn()}
        onBookAnother={vi.fn()}
        onJoin={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('book in place is a button that fires onCall and disables while pending', async () => {
    const user = userEvent.setup();
    const { onCall } = renderGroup({ slot: { kind: 'book', route: 'in_place' } });
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('book in place is disabled while a call action is pending', () => {
    renderGroup({ slot: { kind: 'book', route: 'in_place' }, callPending: true });
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeDisabled();
  });

  it('book via the profile is a link with the explanatory title', () => {
    renderGroup({
      slot: { kind: 'book', route: 'profile' },
      profileBookingHref: '/experts/priya?book=1&src=request_thread',
    });
    const link = screen.getByRole('link', { name: 'Book a call' });
    expect(link).toHaveAttribute('href', '/experts/priya?book=1&src=request_thread');
    expect(link).toHaveAttribute('title', "Opens Priya's profile to book a consultation");
  });

  it('book via the profile renders nothing without a href', () => {
    renderGroup({ slot: { kind: 'book', route: 'profile' }, profileBookingHref: null });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('propose fires onCall', async () => {
    const user = userEvent.setup();
    const { onCall } = renderGroup({ slot: { kind: 'propose' } });
    await user.click(screen.getByRole('button', { name: 'Propose times' }));
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('shared renders the pill with no button', () => {
    renderGroup({ slot: { kind: 'shared' } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.getByText('Availability shared').closest('[aria-disabled="true"]')
    ).not.toBeNull();
  });
});

describe('NextCallLine', () => {
  function renderLine(calls: readonly UpcomingCallView[], deliveryEngagementId: string | null) {
    return render(
      <NextCallLine
        slot={upcomingSlot(calls)}
        upcomingCalls={calls}
        deliveryEngagementId={deliveryEngagementId}
      />
    );
  }

  it('renders nothing unless the slot is upcoming', () => {
    const { container } = render(
      <NextCallLine
        slot={{ kind: 'book', route: 'in_place' }}
        upcomingCalls={[]}
        deliveryEngagementId={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reads "Next call" plus the shared formatNextCallWhen label', () => {
    clockRef.value = CLOCK;
    const { container } = renderLine([SCENARIOS.d1], null);
    expect(container.textContent).toBe(
      `Next call ${formatNextCallWhen(SCENARIOS.d1.scheduledStartIso, NOW, 'UTC')}`
    );
    expect(container.textContent).toBe('Next call tomorrow at 2:00 pm');
  });

  it('is an aria-hidden skeleton, with no label text, while the clock is unresolved', () => {
    const { container } = renderLine([SCENARIOS.d1], null);
    expect(container.textContent).toBe('Next call ');
    expect(container.querySelector('[aria-hidden="true"].animate-pulse')).not.toBeNull();
  });

  it('a project call with a delivery engagement links to the workspace; otherwise plain text', () => {
    clockRef.value = CLOCK;
    const linked = renderLine([SCENARIOS.d2], 'eng-1');
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/engagements/eng-1?from=request_detail'
    );
    linked.unmount();

    renderLine([SCENARIOS.d2], null);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('a request-interaction call is plain text even when an engagement id is known', () => {
    clockRef.value = CLOCK;
    renderLine([SCENARIOS.d1], 'eng-1');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('two calls: "+1 more" opens a popover listing both', async () => {
    const user = userEvent.setup();
    clockRef.value = CLOCK;
    const calls = [SCENARIOS.d1, SCENARIOS.d2];
    renderLine(calls, 'eng-1');

    await user.click(screen.getByRole('button', { name: 'Show 1 more upcoming call' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Upcoming calls')).toBeInTheDocument();
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('tomorrow at 2:00 pm');
    expect(items[1]).toHaveTextContent('Thu 29 Oct at 11:00 am');
    // The project call keeps the link rule inside the list as well.
    expect(within(items[1] as HTMLElement).getByRole('link')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows no "+N more" with a single call', () => {
    clockRef.value = CLOCK;
    renderLine([SCENARIOS.d1], null);
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });
});
