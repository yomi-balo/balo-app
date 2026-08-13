import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';
import { CaseNudge } from './case-nudge';

/**
 * BAL-421 — the nudge renders EXACTLY ONE thing, chosen server-side by `selectCaseNudge`.
 *
 * ⚠⚠ THE "EXACTLY ONE" ASSERTIONS ARE THE LOAD-BEARING ONES. The component is a pure renderer
 * BECAUSE a second copy of the priority ordering would be a second place the "the ask is
 * suppressed while anything is booked" rule lives — and the two would drift. So every case
 * below counts the nudges that appeared, rather than merely asserting the expected one is
 * present: a component that re-derived priority and rendered two would still pass a
 * `getByText`.
 */

const LENSES = ['client', 'expert'] as const;

const BASE = {
  counterpartyLabel: 'Amara',
  bookAgainHref: '/experts/amara-okafor',
  onMarkResolved: vi.fn(),
  onDismissAsk: vi.fn(),
  busy: false,
};

const UPCOMING: CaseNudgeView = {
  kind: 'upcoming',
  meetingId: 'm1',
  scheduledStartIso: '2026-09-01T10:00:00Z',
  live: false,
};

/**
 * Each kind's ONE identifying heading, per lens. The component renders exactly one
 * `NudgeShell`, so the count of matches across this table is the "exactly one" assertion.
 */
const HEADINGS: readonly RegExp[] = [
  /Next consultation/i,
  /consultation is about to start|consultation starts in|consultation is starting now/i,
  /thinks this one's sorted/i,
  /You've asked if this is sorted/i,
  /Nothing booked/i,
];

function renderedHeadingCount(): number {
  return HEADINGS.reduce((total, pattern) => total + screen.queryAllByText(pattern).length, 0);
}

describe('CaseNudge — exactly ONE nudge renders, for every kind × every lens', () => {
  it.each(LENSES)('renders nothing at all for a CLOSED case (null nudge), %s lens', (lens) => {
    const { container } = render(<CaseNudge {...BASE} nudge={null} lens={lens} />);
    expect(container).toBeEmptyDOMElement();
    expect(renderedHeadingCount()).toBe(0);
  });

  it.each(LENSES)('renders exactly one UPCOMING nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens={lens} />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Next consultation/i)).toBeInTheDocument();
  });

  it.each(LENSES)('renders exactly one RESOLUTION_ASK nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={{ kind: 'resolution_ask' }} lens={lens} />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Amara thinks this one's sorted/i)).toBeInTheDocument();
  });

  it.each(LENSES)('renders exactly one RESOLUTION_ASK_PENDING nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={{ kind: 'resolution_ask_pending' }} lens={lens} />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/You've asked if this is sorted/i)).toBeInTheDocument();
  });

  it.each(LENSES)('renders exactly one NOTHING_BOOKED nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={{ kind: 'nothing_booked' }} lens={lens} />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Nothing booked/i)).toBeInTheDocument();
  });
});

describe('CaseNudge — the lens changes the COPY, not the count', () => {
  it('addresses the client about their own call, and the expert about the other party', () => {
    const { unmount } = render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" />);
    expect(screen.getByText(/Your call with Amara is booked/i)).toBeInTheDocument();
    unmount();

    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="expert" />);
    expect(screen.getByText(/Amara is booked in/i)).toBeInTheDocument();
  });

  it('titles NOTHING_BOOKED differently per lens, and only the client is invited to book', () => {
    const { unmount } = render(
      <CaseNudge {...BASE} nudge={{ kind: 'nothing_booked' }} lens="client" />
    );
    expect(screen.getByText('Nothing booked yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book a consultation' })).toHaveAttribute(
      'href',
      '/experts/amara-okafor'
    );
    unmount();

    render(<CaseNudge {...BASE} nudge={{ kind: 'nothing_booked' }} lens="expert" />);
    expect(screen.getByText('Nothing booked')).toBeInTheDocument();
    // Only a CLIENT can book — the expert lens never gets the CTA.
    expect(screen.queryByRole('link', { name: 'Book a consultation' })).not.toBeInTheDocument();
  });

  it('renders NO booking CTA when the username is null — never /experts/null', () => {
    // `expert_profiles.username` is NULLABLE. An absent action beats a dead one.
    render(
      <CaseNudge {...BASE} bookAgainHref={null} nudge={{ kind: 'nothing_booked' }} lens="client" />
    );
    expect(screen.queryByRole('link', { name: 'Book a consultation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  /**
   * ⚠ THERE IS NO "JOIN NOW" BUTTON ANYWHERE, AND ITS ABSENCE IS DELIBERATE — no participant
   * join route exists on `main` (BAL-132 / BAL-435 own it), so rendering one would be a link
   * to nowhere and a disabled one is worse than an absent one.
   */
  it.each(LENSES)('offers NO join button even on a LIVE consultation, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={{ ...UPCOMING, live: true }} lens={lens} />);
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /join/i })).not.toBeInTheDocument();
    // …but the honest instruction IS carried.
    expect(screen.getByText(/join link is in your calendar/i)).toBeInTheDocument();
  });

  it('offers no RESCHEDULE CTA either — no reschedule proposal exists in the schema', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" />);
    expect(screen.queryByText(/reschedule/i)).not.toBeInTheDocument();
  });
});

describe('CaseNudge — the resolution ask is the only interactive nudge', () => {
  it('wires both actions, and disables them while a mutation is in flight', async () => {
    const onMarkResolved = vi.fn();
    const onDismissAsk = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <CaseNudge
        {...BASE}
        nudge={{ kind: 'resolution_ask' }}
        lens="client"
        onMarkResolved={onMarkResolved}
        onDismissAsk={onDismissAsk}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Yes, mark it resolved' }));
    expect(onMarkResolved).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(onDismissAsk).toHaveBeenCalledTimes(1);

    rerender(
      <CaseNudge
        {...BASE}
        nudge={{ kind: 'resolution_ask' }}
        lens="client"
        onMarkResolved={onMarkResolved}
        onDismissAsk={onDismissAsk}
        busy
      />
    );
    expect(screen.getByRole('button', { name: 'Yes, mark it resolved' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeDisabled();
  });

  it('gives the dismiss affordance an accessible name', async () => {
    const onDismissAsk = vi.fn();
    render(
      <CaseNudge
        {...BASE}
        nudge={{ kind: 'resolution_ask' }}
        lens="client"
        onDismissAsk={onDismissAsk}
      />
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissAsk).toHaveBeenCalled();
  });

  it.each([
    ['upcoming', UPCOMING],
    ['resolution_ask_pending', { kind: 'resolution_ask_pending' } as const],
    ['nothing_booked', { kind: 'nothing_booked' } as const],
  ])('gives %s NO dismiss affordance', (_label, nudge) => {
    render(<CaseNudge {...BASE} nudge={nudge} lens="client" />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('offers the expert NO buttons on the pending state — nothing to do until they answer', () => {
    render(<CaseNudge {...BASE} nudge={{ kind: 'resolution_ask_pending' }} lens="expert" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
