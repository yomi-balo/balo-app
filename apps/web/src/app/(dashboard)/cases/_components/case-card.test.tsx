import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import type { CasesIndexCardState } from '@balo/analytics/events';
import { CaseCard } from './case-card';
import type { CasesIndexCardView, CasesIndexSide } from '../_lib/cases-index-view-types';

/**
 * BAL-567 — ONE grid card, across ALL EIGHT card states and BOTH sides.
 *
 * ⚠⚠ THE TABLE IS THE TEST. The eight states are a data table in the source, so they are a data
 * table here too: sixteen renders driven by one list, each asserting the exact slot copy AND the
 * band rule. Eight hand-written cases would drift from the source table the first time a state
 * was added.
 */

const NOW = new Date('2026-09-16T04:30:00.000Z');
const MIN = 60_000;
const CLOCK = { now: NOW, timeZone: 'UTC' };
const SIDES: readonly CasesIndexSide[] = ['company', 'expert'];

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
    productTags: ['CPQ', 'Revenue Cloud', 'Sales Cloud'],
    trail: [
      { ordinal: 1, mark: 'held' },
      { ordinal: 2, mark: 'booked' },
    ],
    heldCount: 1,
    actionItemsForYou: 2,
    unread: true,
    openedAtIso: '2026-09-02T00:00:00.000Z',
    nextBookingStartIso: new Date(NOW.getTime() + 60 * MIN).toISOString(),
    nextBookingEndIso: new Date(NOW.getTime() + 90 * MIN).toISOString(),
    nextBookingStatus: 'scheduled',
    lastCallAtIso: '2026-09-12T00:00:00.000Z',
    proposalOptionCount: null,
    actorLabel: null,
    bookAgainHref: '/experts/marcus',
    joinPath: null,
    ...overrides,
  };
}

interface StateCase {
  readonly state: CasesIndexCardState;
  readonly overrides: Partial<CasesIndexCardView>;
  /** Text every render of this state shows, on BOTH sides. */
  readonly alwaysShows: readonly string[];
  /**
   * The slot action each side offers, by name.
   *
   * ⚠ "Choose a time" AND "Review" ARE SIDE-AGNOSTIC, and deliberately so: both simply OPEN the
   * case, and their STATES are already side-derived (`selectCaseNudge` gives the expert
   * `proposal_pending`, never `proposal`), so gating them again on the side would be a second
   * copy of a rule the state already carries. The two BOOKING actions are genuinely client-only
   * — an expert cannot book.
   */
  readonly clientAction: string | null;
  readonly expertAction: string | null;
  /** The band's exact sentence on the client side — `null` when the state has no band. */
  readonly clientBand: string | null;
}

const STATES: readonly StateCase[] = [
  {
    state: 'live',
    overrides: { cardState: 'live' },
    alwaysShows: ['Wed, 5:30 am'],
    clientAction: null,
    expertAction: null,
    clientBand: null,
  },
  {
    state: 'booked',
    overrides: {},
    alwaysShows: ['Wed, 5:30 am', 'Today, 30 min'],
    clientAction: null,
    expertAction: null,
    clientBand: null,
  },
  {
    state: 'proposal',
    overrides: { cardState: 'proposal', actorLabel: 'Priya @ CloudPeak', proposalOptionCount: 3 },
    alwaysShows: ['Booked for now'],
    clientAction: 'Choose a time',
    expertAction: 'Choose a time',
    clientBand: 'Priya @ CloudPeak suggested 3 new times',
  },
  {
    state: 'proposal_pending',
    overrides: { cardState: 'proposal_pending', actorLabel: 'You' },
    alwaysShows: ['You suggested new times'],
    clientAction: null,
    expertAction: null,
    clientBand: null,
  },
  {
    state: 'resolution_ask',
    overrides: {
      cardState: 'resolution_ask',
      actorLabel: 'Marcus',
      nextBookingStartIso: null,
      nextBookingEndIso: null,
      nextBookingStatus: null,
    },
    alwaysShows: ['Nothing booked', 'Last call 12 Sep'],
    clientAction: 'Review',
    expertAction: 'Review',
    clientBand: "Marcus thinks this one's sorted",
  },
  {
    state: 'resolution_ask_pending',
    overrides: {
      cardState: 'resolution_ask_pending',
      actorLabel: 'Priya',
      nextBookingStartIso: null,
      nextBookingEndIso: null,
      nextBookingStatus: null,
    },
    alwaysShows: ['Priya asked if this is sorted', 'Waiting on Marcus Lee'],
    clientAction: null,
    expertAction: null,
    clientBand: null,
  },
  {
    state: 'nothing_booked',
    overrides: {
      cardState: 'nothing_booked',
      nextBookingStartIso: null,
      nextBookingEndIso: null,
      nextBookingStatus: null,
    },
    alwaysShows: ['Nothing booked', 'Last call 12 Sep'],
    clientAction: 'Book another',
    expertAction: null,
    clientBand: null,
  },
  {
    state: 'no_calls',
    overrides: {
      cardState: 'no_calls',
      trail: [],
      heldCount: 0,
      lastCallAtIso: null,
      nextBookingStartIso: null,
      nextBookingEndIso: null,
      nextBookingStatus: null,
    },
    alwaysShows: ['No consultation booked', 'Pick a time to get started'],
    clientAction: 'Book a time',
    expertAction: null,
    clientBand: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CaseCard — all eight states, both sides', () => {
  it('covers every state in the analytics tuple (guards a shrunken table)', () => {
    expect(STATES).toHaveLength(8);
    expect(STATES.map((entry) => entry.state).sort()).toEqual(
      [
        'booked',
        'live',
        'no_calls',
        'nothing_booked',
        'proposal',
        'proposal_pending',
        'resolution_ask',
        'resolution_ask_pending',
      ].sort()
    );
  });

  it.each(STATES.flatMap((entry) => SIDES.map((side) => ({ ...entry, side }))))(
    '$state · $side side renders its slot copy',
    ({ overrides, side, alwaysShows }) => {
      render(
        <CaseCard
          card={card(overrides)}
          side={side}
          dense={false}
          clock={CLOCK}
          onTrack={vi.fn()}
        />
      );
      for (const text of alwaysShows) {
        expect(screen.getByText(text)).toBeInTheDocument();
      }
    }
  );

  /**
   * ⚠ BOTH SIDES ARE ASSERTED EXPLICITLY, INCLUDING THE "no action at all" ROWS — otherwise a
   * state that silently grew a button would sail through this table.
   */
  it.each(STATES)(
    '$state · offers exactly the right action on each side',
    ({ overrides, clientAction, expertAction }) => {
      const ACTION_NAMES = ['Choose a time', 'Review', 'Book another', 'Book a time'];

      const { unmount } = render(
        <CaseCard
          card={card(overrides)}
          side="company"
          dense={false}
          clock={CLOCK}
          onTrack={vi.fn()}
        />
      );
      for (const name of ACTION_NAMES) {
        const matcher = screen.queryByRole('link', { name });
        if (name === clientAction) {
          expect(matcher).toBeInTheDocument();
          // ⚠ EVERY SLOT ACTION OPENS THE CASE — including the two BOOKING ones, which briefly
          // pointed at `/experts/{username}` and so forgot which case they belonged to. The href
          // is asserted EXACTLY; "has some href" would have passed for that bug.
          expect(matcher).toHaveAttribute('href', '/cases/eng-1');
        } else {
          expect(matcher).not.toBeInTheDocument();
        }
      }
      unmount();

      render(
        <CaseCard
          card={card(overrides)}
          side="expert"
          dense={false}
          clock={CLOCK}
          onTrack={vi.fn()}
        />
      );
      for (const name of ACTION_NAMES) {
        const matcher = screen.queryByRole('link', { name });
        if (name === expertAction) {
          expect(matcher).toBeInTheDocument();
          expect(matcher).toHaveAttribute('href', '/cases/eng-1');
        } else {
          expect(matcher).not.toBeInTheDocument();
        }
      }
    }
  );

  it('renders NO booking action when the expert has no username — never /experts/null', () => {
    render(
      <CaseCard
        card={card({
          cardState: 'nothing_booked',
          bookAgainHref: null,
          nextBookingStartIso: null,
          nextBookingEndIso: null,
          nextBookingStatus: null,
        })}
        side="company"
        dense={false}
        clock={CLOCK}
        onTrack={vi.fn()}
      />
    );
    expect(screen.queryByRole('link', { name: 'Book another' })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('null');
    }
  });

  /**
   * ⚠⚠ A BAND NEVER RENDERS ON THE EXPERT SIDE. Both banded states say "the other party is
   * waiting on you"; on the expert side neither is true, because the expert MADE those asks.
   */
  it.each(STATES)(
    '$state · the band is CLIENT-only and names the ACTOR',
    ({ overrides, clientBand }) => {
      const { unmount } = render(
        <CaseCard
          card={card(overrides)}
          side="company"
          dense={false}
          clock={CLOCK}
          onTrack={vi.fn()}
        />
      );
      if (clientBand === null) {
        expect(
          screen.queryByText(/suggested \d+ new time|thinks this one's sorted/)
        ).not.toBeInTheDocument();
      } else {
        expect(screen.getByText(clientBand)).toBeInTheDocument();
      }
      unmount();

      render(
        <CaseCard
          card={card(overrides)}
          side="expert"
          dense={false}
          clock={CLOCK}
          onTrack={vi.fn()}
        />
      );
      expect(
        screen.queryByText(/suggested \d+ new time|thinks this one's sorted/)
      ).not.toBeInTheDocument();
    }
  );
});

describe('CaseCard — the identity block', () => {
  it('links the whole title/counterparty block to the case', () => {
    render(<CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={vi.fn()} />);
    const links = screen.getAllByRole('link', { name: /CPQ discount schedule errors/ });
    expect(links[0]).toHaveAttribute('href', '/cases/eng-1');
  });

  it('reports a card click with its own target', async () => {
    const onTrack = vi.fn();
    const user = userEvent.setup();
    render(<CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={onTrack} />);

    // ⚠ DESTRUCTURE + GUARD, never an index-position `!` — SonarCloud analyses WITHOUT
    // `noUncheckedIndexedAccess`, so it reads such an assertion as "unnecessary" and fails the
    // gate on a false positive. CLAUDE.md's house fix is to guard (memory
    // `reference_sonar_nonnull_false_positive`).
    const [titleLink] = screen.getAllByRole('link', { name: /CPQ discount schedule errors/ });
    if (titleLink === undefined) throw new Error('expected the card title to be a link');
    await user.click(titleLink);

    expect(onTrack).toHaveBeenCalledWith(
      'case',
      expect.objectContaining({ engagementId: 'eng-1' })
    );
  });

  it('names the expert on the client side and the COMPANY on the expert side', () => {
    const { unmount } = render(
      <CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={vi.fn()} />
    );
    expect(screen.getByText('Marcus Lee')).toBeInTheDocument();
    expect(screen.getByText(', Stratus Advisory')).toBeInTheDocument();
    unmount();

    render(
      <CaseCard
        card={card({ counterpartyName: 'Acme Corp', counterpartyOrgLabel: null })}
        side="expert"
        dense={false}
        clock={CLOCK}
        onTrack={vi.fn()}
      />
    );
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByText(/, Stratus Advisory/)).not.toBeInTheDocument();
  });

  it('shows two tags plus an overflow chip when comfortable, one when dense', () => {
    const { unmount } = render(
      <CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={vi.fn()} />
    );
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('Revenue Cloud')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    unmount();

    render(<CaseCard card={card()} side="expert" dense clock={CLOCK} onTrack={vi.fn()} />);
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.queryByText('Revenue Cloud')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});

describe('CaseCard — the footer facts', () => {
  it('announces the trail as ONE accessible name, never five shapes', () => {
    render(<CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={vi.fn()} />);
    expect(
      screen.getByRole('img', { name: 'Consultations: 1 held, 1 booked' })
    ).toBeInTheDocument();
  });

  it('omits each figure at zero rather than rendering "0 for you"', () => {
    render(
      <CaseCard
        card={card({ heldCount: 0, actionItemsForYou: 0, unread: false })}
        side="company"
        dense={false}
        clock={CLOCK}
        onTrack={vi.fn()}
      />
    );
    expect(screen.queryByText(/0 held|0 for you/)).not.toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('renders "Opened {date}" only on the comfortable density', () => {
    const { unmount } = render(
      <CaseCard card={card()} side="company" dense={false} clock={CLOCK} onTrack={vi.fn()} />
    );
    expect(screen.getByText('Opened 2 Sep')).toBeInTheDocument();
    unmount();

    render(<CaseCard card={card()} side="expert" dense clock={CLOCK} onTrack={vi.fn()} />);
    expect(screen.queryByText('Opened 2 Sep')).not.toBeInTheDocument();
  });

  it('shows a SKELETON instead of a server-zone time before the viewer’s clock lands', () => {
    render(<CaseCard card={card()} side="company" dense={false} clock={null} onTrack={vi.fn()} />);
    expect(screen.queryByText(/Wed, /)).not.toBeInTheDocument();
    expect(screen.queryByText('Opened 2 Sep')).not.toBeInTheDocument();
    // …but the clock-free half is already there.
    expect(
      screen.getAllByRole('link', { name: /CPQ discount schedule errors/ })[0]
    ).toBeInTheDocument();
  });
});

describe('CaseCard — accessibility', () => {
  it('has no axe violations on a banded, fully populated card', async () => {
    const { container } = render(
      <CaseCard
        card={card({ cardState: 'proposal', actorLabel: 'Priya', proposalOptionCount: 2 })}
        side="company"
        dense={false}
        clock={CLOCK}
        onTrack={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
