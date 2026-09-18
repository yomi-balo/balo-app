import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import { FeaturedCaseCard } from './featured-case-card';
import type { CasesIndexCardView } from '../_lib/cases-index-view-types';

/**
 * BAL-567 — the featured ticket card: the ONE card that renders Join, and only inside the window.
 *
 * ⚠⚠ THE `<button>`-NOT-`href` ASSERTION IS THE SECURITY ONE. Binding the join target to an
 * `href` puts a meeting id in the DOM, where PostHog autocapture (`$elements[].attr__href`) and
 * Sentry Session Replay (rrweb snapshots, whose `maskAttributes` default excludes `href`) both
 * pick it up with no click required. `join-link-never-writes.test.ts` is the source-side half.
 */

const NOW = new Date('2026-09-16T04:30:00.000Z');
const MIN = 60_000;
const JOIN_PATH = '/meetings/m-1/call';

/** jsdom's `Location.assign` is a non-configurable own property — swap the whole object. */
const realLocation = globalThis.location;
let mockAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAssign = vi.fn();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
});

function card(overrides: Partial<CasesIndexCardView> = {}): CasesIndexCardView {
  return {
    engagementId: 'eng-1',
    href: '/cases/eng-1',
    title: 'CPQ discount schedule errors',
    cardState: 'booked',
    counterpartyName: 'Marcus Lee',
    counterpartyOrgLabel: 'Stratus Advisory',
    counterpartyAvatarUrl: null,
    counterpartyInitials: 'ML',
    productTags: ['CPQ'],
    trail: [{ ordinal: 1, mark: 'held' }],
    heldCount: 1,
    actionItemsForYou: 2,
    unread: true,
    openedAtIso: '2026-09-02T00:00:00.000Z',
    nextBookingStartIso: new Date(NOW.getTime() + 180 * MIN).toISOString(),
    nextBookingEndIso: new Date(NOW.getTime() + 210 * MIN).toISOString(),
    nextBookingStatus: 'scheduled',
    lastCallAtIso: null,
    proposalOptionCount: null,
    actorLabel: null,
    bookAgainHref: '/experts/marcus',
    joinPath: JOIN_PATH,
    ...overrides,
  };
}

/** A card whose booking starts in `minutes` — inside the window when `minutes <= 15`. */
function startingIn(minutes: number, overrides: Partial<CasesIndexCardView> = {}) {
  return card({
    nextBookingStartIso: new Date(NOW.getTime() + minutes * MIN).toISOString(),
    nextBookingEndIso: new Date(NOW.getTime() + (minutes + 30) * MIN).toISOString(),
    ...overrides,
  });
}

describe('FeaturedCaseCard — the Join window', () => {
  it('offers NO Join outside the window, and states when it opens instead', () => {
    render(<FeaturedCaseCard card={card()} now={NOW} timeZone="UTC" onTrack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.getByText('Join opens 15 min before')).toBeInTheDocument();
  });

  it('offers Join inside the window, as a <button> — never a link', () => {
    render(<FeaturedCaseCard card={startingIn(9)} now={NOW} timeZone="UTC" onTrack={vi.fn()} />);
    const join = screen.getByRole('button', { name: /^Join .*meeting/i });
    expect(join.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Join opens 15 min before')).not.toBeInTheDocument();
    expect(screen.getByText('Starts in 9 mins')).toBeInTheDocument();
  });

  it('NEVER renders the join path as an attribute anywhere in the markup', () => {
    const { container } = render(
      <FeaturedCaseCard card={startingIn(9)} now={NOW} timeZone="UTC" onTrack={vi.fn()} />
    );
    expect(container.innerHTML).not.toContain(JOIN_PATH);
  });

  it('navigates with location.assign and reports the click, in that order', async () => {
    const onTrack = vi.fn();
    const user = userEvent.setup();
    render(<FeaturedCaseCard card={startingIn(2)} now={NOW} timeZone="UTC" onTrack={onTrack} />);

    await user.click(screen.getByRole('button', { name: /^Join .*meeting/i }));

    expect(onTrack).toHaveBeenCalledWith(
      'join',
      expect.objectContaining({ engagementId: 'eng-1' })
    );
    expect(mockAssign).toHaveBeenCalledWith(JOIN_PATH);
  });

  it('says "Happening now" once the call is under way', () => {
    render(
      <FeaturedCaseCard
        card={startingIn(-5, { nextBookingStatus: 'in_progress' })}
        now={NOW}
        timeZone="UTC"
        onTrack={vi.fn()}
      />
    );
    expect(screen.getByText('Happening now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Join .*meeting/i })).toBeInTheDocument();
  });

  it('offers no Join on a TERMINAL meeting, even inside the clock window', () => {
    render(
      <FeaturedCaseCard
        card={startingIn(5, { nextBookingStatus: 'cancelled' })}
        now={NOW}
        timeZone="UTC"
        onTrack={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });

  it('offers no Join with no join path — an absent action beats a dead one', () => {
    render(
      <FeaturedCaseCard
        card={startingIn(5, { joinPath: null })}
        now={NOW}
        timeZone="UTC"
        onTrack={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });
});

describe('FeaturedCaseCard — the ticket stub', () => {
  it('renders the booking in the injected zone', () => {
    render(
      <FeaturedCaseCard
        card={card({
          nextBookingStartIso: '2026-09-16T04:30:00.000Z',
          nextBookingEndIso: '2026-09-16T05:00:00.000Z',
        })}
        now={NOW}
        timeZone="Australia/Sydney"
        onTrack={vi.fn()}
      />
    );
    expect(screen.getByText('Wednesday')).toBeInTheDocument();
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('September')).toBeInTheDocument();
    expect(screen.getByText('2:30 pm')).toBeInTheDocument();
    expect(screen.getByText('30 minutes')).toBeInTheDocument();
  });

  it('holds the date back until the viewer’s clock lands, rather than guessing a zone', () => {
    render(<FeaturedCaseCard card={card()} now={null} timeZone={null} onTrack={vi.fn()} />);
    expect(screen.queryByText('September')).not.toBeInTheDocument();
    expect(screen.queryByText(/minutes$/)).not.toBeInTheDocument();
    // …but the identity half is already readable.
    expect(screen.getByText('CPQ discount schedule errors')).toBeInTheDocument();
    expect(screen.getByText('Your next consultation')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ FIX ROUND X5 — NO "Join opens 15 min before" WITHOUT A TIME TO COUNT BACK FROM. The hint
   * used to be the unconditional `else` of the Join branch, so it appeared during the pre-clock
   * paint and on a card whose booking the trail could not resolve. Promising when somebody can
   * join a call whose time you do not have is a confident wrong answer; the skeleton beside it
   * already reads honestly as "still loading".
   */
  it('renders NEITHER Join NOR the hint before the viewer’s clock lands', () => {
    render(<FeaturedCaseCard card={card()} now={null} timeZone={null} onTrack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Join opens 15 min before')).not.toBeInTheDocument();
  });

  it('renders NEITHER Join NOR the hint when the booking itself is unreadable', () => {
    // The repository says this case is booked, but no matching meeting reached the trail — so
    // there is no start time, no end time, and nothing honest to say about joining.
    render(
      <FeaturedCaseCard
        card={card({
          nextBookingStartIso: null,
          nextBookingEndIso: null,
          nextBookingStatus: null,
        })}
        now={NOW}
        timeZone="UTC"
        onTrack={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Join opens 15 min before')).not.toBeInTheDocument();
    // The card still opens — the identity half needs no clock and no booking.
    expect(screen.getByRole('link', { name: /Open case/ })).toHaveAttribute('href', '/cases/eng-1');
  });

  it('still shows the hint on a readable booking OUTSIDE the window — the honest case', () => {
    render(<FeaturedCaseCard card={card()} now={NOW} timeZone="UTC" onTrack={vi.fn()} />);
    expect(screen.getByText('Join opens 15 min before')).toBeInTheDocument();
  });
});

describe('FeaturedCaseCard — the identity half', () => {
  it('links to the case from both the title and the "Open case" affordance', async () => {
    const onTrack = vi.fn();
    const user = userEvent.setup();
    render(<FeaturedCaseCard card={card()} now={NOW} timeZone="UTC" onTrack={onTrack} />);

    const openCase = screen.getByRole('link', { name: /Open case/ });
    expect(openCase).toHaveAttribute('href', '/cases/eng-1');
    await user.click(openCase);
    expect(onTrack).toHaveBeenCalledWith(
      'case',
      expect.objectContaining({ engagementId: 'eng-1' })
    );
  });

  it('announces the trail as one accessible name', () => {
    render(<FeaturedCaseCard card={card()} now={NOW} timeZone="UTC" onTrack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Consultations: 1 held' })).toBeInTheDocument();
  });

  it('has no axe violations, live or not', async () => {
    const quiet = render(
      <FeaturedCaseCard card={card()} now={NOW} timeZone="UTC" onTrack={vi.fn()} />
    );
    expect(await axe(quiet.container)).toHaveNoViolations();
    quiet.unmount();

    const live = render(
      <FeaturedCaseCard card={startingIn(4)} now={NOW} timeZone="UTC" onTrack={vi.fn()} />
    );
    expect(await axe(live.container)).toHaveNoViolations();
  });
});
