import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { render, screen } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';
import { CaseNudge } from './case-nudge';

/**
 * `useUpcomingJoinClock` calls `useRouter()` unconditionally (it owns the once-only refresh on
 * the crossing), so every `'upcoming'`-kind render needs the app router mocked, not only the
 * crossing tests. N8 idiom, copied from `case-surface.test.tsx`: a shared, hoisted spy so tests
 * can assert `router.refresh()` fired, which a fresh `vi.fn()` per `useRouter()` call could not.
 */
const { mockRouterRefresh } = vi.hoisted(() => ({ mockRouterRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

/**
 * BAL-567 — `JoinMeetingButton` navigates with `globalThis.location.assign`, and jsdom's
 * `Location.assign` is a NON-CONFIGURABLE own property, so the whole `location` object is
 * swapped and restored (the `join-meeting-button.test.tsx` idiom, verbatim).
 */
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
  vi.clearAllMocks();
});

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
  // Defaulted on; tests that need the gated-off case override explicitly with
  // `canReschedule={false}`.
  canReschedule: true,
  onReschedule: vi.fn(),
  canProposeReschedule: false,
  onProposeReschedule: vi.fn(),
  busy: false,
};

const JOIN_PATH = '/meetings/m1/call';

/** An ISO stamp `offsetMs` from the real now — never a fixed literal date, which `insideCase-
 *  JoinWindow`'s "no closing bound" would silently turn permanently live the moment real time
 *  passes it (reference_hardcoded_date_fixtures_are_time_bombs). */
function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60_000;

const UPCOMING: CaseNudgeView = {
  kind: 'upcoming',
  meetingId: 'm1',
  scheduledStartIso: isoFromNow(THREE_DAYS_MS),
  live: false,
  durationMinutes: 60,
  joinPath: JOIN_PATH,
};

/** Inside the join window on both the server flag AND the clock — the ordinary live case. */
const UPCOMING_LIVE: CaseNudgeView = {
  ...UPCOMING,
  scheduledStartIso: isoFromNow(5 * 60_000),
  live: true,
};

/**
 * Each kind's ONE identifying heading, per lens. The component renders exactly one
 * `NudgeShell`, so the count of matches across this table is the "exactly one" assertion.
 */
const HEADINGS: readonly RegExp[] = [
  /Next consultation/i,
  /consultation is about to start|consultation starts in|consultation is starting now/i,
  /suggested some new times/i,
  // BAL-567 — was `/Waiting on a reply to your suggested times/i`. The pending-proposal title now
  // names the ACTOR ("You suggested new times" / "Priya suggested new times"), so the pattern
  // matches the sentence rather than the one viewer it used to assume.
  /suggested new times/i,
  /thinks this one's sorted/i,
  // Likewise: "You've asked …" for the person who asked, "{Colleague} asked …" for everyone else.
  /asked if this is sorted/i,
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
    render(
      <CaseNudge {...BASE} nudge={{ kind: 'resolution_ask', actorLabel: 'Dana' }} lens={lens} />
    );
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Dana thinks this one's sorted/i)).toBeInTheDocument();
  });

  it.each(LENSES)('renders exactly one RESOLUTION_ASK_PENDING nudge, %s lens', (lens) => {
    render(
      <CaseNudge
        {...BASE}
        nudge={{ kind: 'resolution_ask_pending', actorLabel: 'You' }}
        lens={lens}
      />
    );
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText("You've asked if this is sorted")).toBeInTheDocument();
  });

  it.each(LENSES)('renders exactly one NOTHING_BOOKED nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={{ kind: 'nothing_booked' }} lens={lens} />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Nothing booked/i)).toBeInTheDocument();
  });

  const PROPOSAL_OPTIONS = [
    { optionId: 'opt-1', scheduledStartIso: '2026-09-02T10:00:00Z' },
    { optionId: 'opt-2', scheduledStartIso: '2026-09-03T10:00:00Z' },
  ];

  const RESCHEDULE_PROPOSAL_NUDGE = {
    kind: 'reschedule_proposal' as const,
    proposalId: 'proposal-1',
    meetingId: 'm1',
    optionCount: 2,
    originalScheduledStartIso: '2026-09-01T10:00:00Z',
    expiresAtIso: '2026-09-01T09:00:00Z',
    proposedAtIso: '2026-08-30T09:00:00Z',
    options: PROPOSAL_OPTIONS,
    actorLabel: 'Dana',
  };

  const RESCHEDULE_PROPOSAL_PENDING_NUDGE = {
    kind: 'reschedule_proposal_pending' as const,
    proposalId: 'proposal-1',
    meetingId: 'm1',
    optionCount: 2,
    expiresAtIso: '2026-09-01T09:00:00Z',
    proposedAtIso: '2026-08-30T09:00:00Z',
    options: PROPOSAL_OPTIONS,
    actorLabel: 'You',
  };

  it('renders exactly one RESCHEDULE_PROPOSAL nudge — CLIENT lens only', () => {
    render(<CaseNudge {...BASE} nudge={RESCHEDULE_PROPOSAL_NUDGE} lens="client" />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText(/Dana suggested some new times/i)).toBeInTheDocument();
  });

  it('renders exactly one RESCHEDULE_PROPOSAL_PENDING nudge — EXPERT lens only', () => {
    render(<CaseNudge {...BASE} nudge={RESCHEDULE_PROPOSAL_PENDING_NUDGE} lens="expert" />);
    expect(renderedHeadingCount()).toBe(1);
    expect(screen.getByText('You suggested new times')).toBeInTheDocument();
  });
});

/**
 * ⚠⚠ BAL-567 — THE ATTRIBUTION FIX, AND THE DEFECT IT CLOSES. Before this ticket the four
 * attributed arms rendered `counterpartyLabel`, so the case page told EVERY expert-side viewer
 * "You've asked if this is sorted" — including an agency colleague who did nothing
 * (`resolveCaseAccess` admits any live agency member, ADR-1046 §7) — and named the delivering
 * expert on the client side even when a colleague made the ask.
 *
 * Every case below asserts the actor's label IS rendered AND that `counterpartyLabel` is NOT,
 * because a title that rendered both would pass a bare `getByText(actorLabel)`.
 */
describe('CaseNudge — the four attributed arms name the ACTOR, never the counterparty', () => {
  const COUNTERPARTY = 'Amara';

  interface AttributedCase {
    readonly name: string;
    readonly nudge: CaseNudgeView;
    readonly lens: 'client' | 'expert';
    readonly expectedTitle: string;
    /**
     * ⚠ THE EXACT SENTENCE THE PRE-BAL-567 COMPONENT WOULD HAVE RENDERED for this case, pinned
     * as ABSENT. A "the counterparty name appears nowhere" assertion cannot be used here: the
     * PROSPECTIVE bodies legitimately name the counterparty ("Amara will pick one…"), so such an
     * assertion would fail on correct code. Naming the stale title is what makes this test fail
     * if the titles are reverted to `counterpartyLabel`.
     */
    readonly staleTitle: string;
  }

  const ATTRIBUTED: readonly AttributedCase[] = [
    {
      name: 'resolution_ask · an agency colleague asked',
      nudge: { kind: 'resolution_ask', actorLabel: 'Priya @ CloudPeak' },
      lens: 'client',
      expectedTitle: "Priya @ CloudPeak thinks this one's sorted",
      staleTitle: "Amara thinks this one's sorted",
    },
    {
      name: 'resolution_ask_pending · the viewer asked',
      nudge: { kind: 'resolution_ask_pending', actorLabel: 'You' },
      lens: 'expert',
      expectedTitle: "You've asked if this is sorted",
      staleTitle: 'Amara asked if this is sorted',
    },
    {
      name: 'resolution_ask_pending · a COLLEAGUE asked, so it is not "you"',
      nudge: { kind: 'resolution_ask_pending', actorLabel: 'Priya' },
      lens: 'expert',
      expectedTitle: 'Priya asked if this is sorted',
      staleTitle: "You've asked if this is sorted",
    },
    {
      name: 'reschedule_proposal · a colleague proposed',
      nudge: {
        kind: 'reschedule_proposal',
        proposalId: 'p1',
        meetingId: 'm1',
        optionCount: 2,
        originalScheduledStartIso: '2026-09-01T10:00:00Z',
        expiresAtIso: '2026-09-01T09:00:00Z',
        actorLabel: 'Priya @ CloudPeak',
      },
      lens: 'client',
      expectedTitle: 'Priya @ CloudPeak suggested some new times',
      staleTitle: 'Amara suggested some new times',
    },
    {
      name: 'reschedule_proposal_pending · a COLLEAGUE proposed, so it is not "your" ask',
      nudge: {
        kind: 'reschedule_proposal_pending',
        proposalId: 'p1',
        meetingId: 'm1',
        optionCount: 2,
        expiresAtIso: '2026-09-01T09:00:00Z',
        actorLabel: 'Priya',
      },
      lens: 'expert',
      expectedTitle: 'Priya suggested new times',
      staleTitle: 'Waiting on a reply to your suggested times',
    },
  ];

  it('covers every attributed arm (guards a shrunken table)', () => {
    expect(ATTRIBUTED).toHaveLength(5);
  });

  it.each(ATTRIBUTED)('$name', ({ nudge, lens, expectedTitle, staleTitle }) => {
    render(<CaseNudge {...BASE} counterpartyLabel={COUNTERPARTY} nudge={nudge} lens={lens} />);
    expect(screen.getByText(expectedTitle)).toBeInTheDocument();
    expect(renderedHeadingCount()).toBe(1);
    // The pre-BAL-567 sentence, pinned as ABSENT — see `staleTitle`'s note.
    expect(screen.queryByText(staleTitle)).not.toBeInTheDocument();
  });

  it('keeps counterpartyLabel in the PROSPECTIVE bodies — it is a different register', () => {
    render(
      <CaseNudge
        {...BASE}
        counterpartyLabel={COUNTERPARTY}
        nudge={{ kind: 'resolution_ask_pending', actorLabel: 'Priya' }}
        lens="expert"
      />
    );
    // "who must answer" names the PARTY (CLAUDE.md attribution-by-tense), and still does.
    expect(
      screen.getByText(new RegExp(`${COUNTERPARTY} will see the question`, 'i'))
    ).toBeInTheDocument();
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
   * ⚠⚠ BAL-567 — **INVERTED**, NOT DELETED. This case used to assert that NO join button existed
   * anywhere, because no participant join route existed on `main`. BAL-435 shipped
   * `/meetings/{id}/call` and BAL-566 gave it one builder, so the assertion had become a guard
   * against the feature. Deleting it would have left the new behaviour unpinned; it now asserts
   * the opposite, on BOTH sides.
   */
  it.each(LENSES)('renders JOIN inside the window, as a <button>, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens={lens} />);
    const join = screen.getByRole('button', { name: /^Join .*meeting/i });
    expect(join).toBeInTheDocument();
    // ⚠ A `<button>`, NEVER AN `href` — `join-link-never-writes.test.ts` is the source-side half
    // of this rule and `JoinMeetingButton`'s docblock is the reason.
    expect(join.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /join/i })).not.toBeInTheDocument();
    // The stale instruction is gone: BAL-475 ships client invites, and the button is the nearer
    // door either way (decisions D5).
    expect(screen.queryByText(/join link is in your calendar/i)).not.toBeInTheDocument();
    // "Join now" replaces "Join call".
    expect(join).toHaveTextContent('Join now');
    expect(screen.queryByText('Join call')).not.toBeInTheDocument();
    // The slot holds only the ONE active control — no leftover inactive countdown beside it.
    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
  });

  /** The join slot never empties: outside the window it is `JoinCountdown`, an inactive but
   *  focusable control, never a live `JoinMeetingButton`. */
  it.each(LENSES)(
    'renders an inactive countdown, never a live Join, OUTSIDE the window, %s lens',
    (lens) => {
      render(<CaseNudge {...BASE} nudge={UPCOMING} lens={lens} />);
      expect(screen.queryByRole('button', { name: /^Join .*meeting/i })).not.toBeInTheDocument();
      const countdown = screen.getByTestId('join-countdown');
      expect(countdown).toBeInTheDocument();
      expect(countdown).toHaveTextContent('Join in 3 days');
      expect(countdown).toHaveAttribute('aria-disabled', 'true');
      // `aria-disabled`, NEVER `disabled` — "in 3 days" is information, so it stays focusable.
      expect(countdown).not.toBeDisabled();
      expect(countdown).toHaveAccessibleDescription(
        `Opens ${CASE_JOIN_WINDOW_MINUTES} minutes before the start.`
      );
    }
  );

  it('navigates to the member call path and tracks the click, never rendering the path', async () => {
    const user = userEvent.setup();
    const { container } = render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" />);

    expect(container.innerHTML).not.toContain(JOIN_PATH);

    await user.click(screen.getByRole('button', { name: /^Join .*meeting/i }));

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'join',
      lens: 'client',
    });
    expect(mockAssign).toHaveBeenCalledWith(JOIN_PATH);
  });

  it('tracks the EXPERT side under its own lens value', async () => {
    const user = userEvent.setup();
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="expert" />);
    await user.click(screen.getByRole('button', { name: /^Join .*meeting/i }));
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'join',
      lens: 'expert',
    });
  });

  /**
   * BAL-409 — INVERTED from the pre-BAL-409 assertion that no reschedule CTA exists. A
   * client-initiated reschedule auto-approves (it needs no proposal state), so the CTA lands
   * here.
   */
  it('renders a RESCHEDULE CTA for the client lens on an upcoming, non-live consultation', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" />);
    expect(screen.getByRole('button', { name: /reschedule/i })).toBeInTheDocument();
  });

  it('does NOT render the (client) reschedule CTA for the expert lens — it gets its own', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={UPCOMING}
        lens="expert"
        canReschedule={false}
        canProposeReschedule={true}
      />
    );
    expect(screen.queryByRole('button', { name: /^reschedule$/i })).not.toBeInTheDocument();
  });

  // Join-window exclusion is the caller's job, not derived here — `mapCaseConsultations` is
  // what actually excludes it. `canReschedule={false}` alongside a live nudge is the shape the
  // real caller would produce.
  it('does NOT render the reschedule CTA when canReschedule is false, even on a live nudge', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" canReschedule={false} />);
    expect(screen.queryByRole('button', { name: /reschedule/i })).not.toBeInTheDocument();
  });

  it('does NOT render the reschedule CTA for the client lens when canReschedule is false', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" canReschedule={false} />);
    expect(screen.queryByRole('button', { name: /reschedule/i })).not.toBeInTheDocument();
  });

  /**
   * BAL-411 — the EXPERT'S symmetrical CTA on the SAME `'upcoming'` arm, gated on the
   * server-resolved `canProposeReschedule`. An absent action beats a dead one: when the flag
   * is false (a proposal is already outstanding, or the axis denies it), no button renders at
   * all — never a disabled one.
   */
  it('renders "Propose a new time" for the EXPERT lens when canProposeReschedule is true', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={UPCOMING}
        lens="expert"
        canReschedule={false}
        canProposeReschedule={true}
      />
    );
    expect(screen.getByRole('button', { name: 'Propose a new time' })).toBeInTheDocument();
  });

  it('renders NO propose CTA for the expert when canProposeReschedule is false', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={UPCOMING}
        lens="expert"
        canReschedule={false}
        canProposeReschedule={false}
      />
    );
    expect(screen.queryByRole('button', { name: 'Propose a new time' })).not.toBeInTheDocument();
  });

  it('does NOT render the propose CTA while the consultation is LIVE', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={UPCOMING_LIVE}
        lens="expert"
        canReschedule={false}
        canProposeReschedule={true}
      />
    );
    expect(screen.queryByRole('button', { name: 'Propose a new time' })).not.toBeInTheDocument();
  });

  it('calls onProposeReschedule when the expert CTA is clicked', async () => {
    const onProposeReschedule = vi.fn();
    const user = userEvent.setup();
    render(
      <CaseNudge
        {...BASE}
        nudge={UPCOMING}
        lens="expert"
        canReschedule={false}
        canProposeReschedule={true}
        onProposeReschedule={onProposeReschedule}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Propose a new time' }));
    expect(onProposeReschedule).toHaveBeenCalledTimes(1);
  });

  it('calls onReschedule when the CTA is clicked, and renderedHeadingCount stays 1', async () => {
    const onReschedule = vi.fn();
    const user = userEvent.setup();
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" onReschedule={onReschedule} />);

    await user.click(screen.getByRole('button', { name: /reschedule/i }));

    expect(onReschedule).toHaveBeenCalledTimes(1);
    expect(renderedHeadingCount()).toBe(1);
  });
});

/**
 * ⚠⚠ THE COUNTDOWN IS CLIENT-ONLY, AND THAT IS A HYDRATION RULE RATHER THAN A STYLE CHOICE. "in
 * N minutes" computed during SSR would be stale by the time it painted and would differ between
 * the server and client renders, so the first paint states the absolute time and the effect
 * swaps in the relative one. These cases drive the swapped-in half — including the moment the
 * countdown crosses zero, where "starts in 0 minutes" would read as a broken clock.
 */
describe('CaseNudge — a LIVE consultation counts down, and never past zero', () => {
  it('singularises exactly one minute', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={{ ...UPCOMING, live: true, scheduledStartIso: isoFromNow(60_000) }}
        lens="client"
      />
    );
    expect(screen.getByText('Your consultation starts in 1 minute')).toBeInTheDocument();
  });

  it('pluralises more than one minute', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={{ ...UPCOMING, live: true, scheduledStartIso: isoFromNow(8 * 60_000) }}
        lens="client"
      />
    );
    expect(screen.getByText('Your consultation starts in 8 minutes')).toBeInTheDocument();
  });

  it('says it is STARTING NOW once the start time has passed — never a negative count', () => {
    const { container } = render(
      <CaseNudge
        {...BASE}
        nudge={{ ...UPCOMING, live: true, scheduledStartIso: isoFromNow(-2 * 60_000) }}
        lens="client"
      />
    );
    expect(screen.getByText('Your consultation is starting now')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/-\d/);
    expect(container.textContent ?? '').not.toContain('starts in');
  });

  it('states the absolute time instead when the consultation is genuinely NOT live', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" />);
    expect(screen.queryByText(/starts in/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Next consultation/i)).toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE SERVER-SUPPLIED `live` IS SEEDED ONLY FOR FIRST PAINT, NEVER TRUSTED AFTER. Here it
   * is stale (`live: false`) but the scheduled start is already inside the window — the clock
   * must correct it on its own next tick, or a page left open across the boundary would sit
   * with a dead countdown forever.
   */
  it('self-corrects to live when the server flag is stale — a page left open across the boundary', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={{ ...UPCOMING, scheduledStartIso: isoFromNow(5 * 60_000), live: false }}
        lens="client"
      />
    );
    expect(screen.getByRole('button', { name: /^Join .*meeting/i })).toBeInTheDocument();
    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
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
        nudge={{ kind: 'resolution_ask', actorLabel: 'Dana' }}
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
        nudge={{ kind: 'resolution_ask', actorLabel: 'Dana' }}
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
        nudge={{ kind: 'resolution_ask', actorLabel: 'Dana' }}
        lens="client"
        onDismissAsk={onDismissAsk}
      />
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissAsk).toHaveBeenCalled();
  });

  it.each([
    ['upcoming', UPCOMING],
    ['resolution_ask_pending', { kind: 'resolution_ask_pending', actorLabel: 'You' } as const],
    ['nothing_booked', { kind: 'nothing_booked' } as const],
  ])('gives %s NO dismiss affordance', (_label, nudge) => {
    render(<CaseNudge {...BASE} nudge={nudge} lens="client" />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('offers the expert NO buttons on the pending state — nothing to do until they answer', () => {
    render(
      <CaseNudge
        {...BASE}
        nudge={{ kind: 'resolution_ask_pending', actorLabel: 'You' }}
        lens="expert"
      />
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

// ── the nudge never offers Cancel ─────────────────────────────────────────────

/**
 * Cancel has no seat in the nudge at all — it lives only on the row's kebab
 * (`consultation-row-menu.tsx`), including for the nudge's own meeting, and the row's Cancel is
 * deliberately not join-window-gated. There is no prop left to opt into a nudge Cancel button
 * with, so this is a blanket absence check across lens and liveness rather than a flag table.
 */
describe('CaseNudge — never renders a Cancel affordance', () => {
  it.each(LENSES)('renders no Cancel button on an upcoming nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens={lens} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it.each(LENSES)('renders no Cancel button on a LIVE upcoming nudge, %s lens', (lens) => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens={lens} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('renders only Join on a live nudge — no Cancel beside it', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" />);
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).not.toContain('Cancel');
  });
});

/**
 * The join slot never empties, and the clock (not the server-resolved `nudge.live`) owns the
 * crossing. `useUpcomingJoinClock` ticks unconditionally; these cases drive the tick.
 */
describe('CaseNudge — the clock owns the join window crossing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('crosses from countdown to Join on its own tick, announces once, and refreshes once', () => {
    // 20 seconds outside the window — one 30s tick later it has opened.
    const nudge = {
      ...UPCOMING,
      scheduledStartIso: isoFromNow(CASE_JOIN_WINDOW_MINUTES * 60_000 + 20_000),
      live: false,
    };
    render(<CaseNudge {...BASE} nudge={nudge} lens="client" />);

    // 20s outside the window rounds to the SAME minute as the boundary itself, so a
    // rounded-minute comparison reads this instant as "Join now" while the control is still
    // rendering aria-disabled — the label must say WHEN it opens instead.
    expect(screen.getByTestId('join-countdown')).toHaveTextContent(
      `Join in ${CASE_JOIN_WINDOW_MINUTES + 1} minutes`
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(mockRouterRefresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Join .*meeting/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You can join now.');
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);

    // Further ticks — still crossed, never announced or refreshed again.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual([
      'You can join now.',
    ]);
  });

  it('never fires the crossing side effects when already live at mount', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(mockRouterRefresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockRouterRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  /** A device clock running behind the server's must never HIDE Join once the server already
   *  considers the meeting joinable — the server's word only ever ADDS liveness. */
  it('renders Join, not the countdown, when the server says live but the device clock disagrees', () => {
    const nudge = {
      ...UPCOMING,
      // 20 minutes out by this (behind) device clock — outside the window on the clock alone.
      scheduledStartIso: isoFromNow(20 * 60_000),
      live: true,
    };
    render(<CaseNudge {...BASE} nudge={nudge} lens="client" />);

    const join = screen.getByRole('button', { name: /^Join .*meeting/i });
    expect(join).toBeInTheDocument();
    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
    // The visible label must agree with liveness too — not just the accessible name — or a
    // device clock running behind the server's shows an active button reading a countdown.
    expect(join).toHaveTextContent('Join now');
  });
});

/**
 * `joinCountdownLabel`'s ladder itself, exhaustively including the calendar-day boundary, is
 * pinned in `join-window.test.ts`; this only checks the nudge renders whatever it returns, in
 * the right slot. `now` is pinned to a fixed noon so the "tomorrow" case can't flip to "in 2
 * days" depending on what wall-clock hour the suite happens to run at.
 */
describe('CaseNudge — the countdown label renders in the inactive slot', () => {
  const NOW = new Date('2026-01-06T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['Join now', CASE_JOIN_WINDOW_MINUTES * 60_000],
    // Just outside the window — the boundary the inactive-vs-live disagreement lived on. Must
    // NOT read "Join now": `insideCaseJoinWindow` (the render's own liveness predicate) is
    // already false here, one second past the inclusive boundary.
    [`Join in ${CASE_JOIN_WINDOW_MINUTES + 1} minutes`, CASE_JOIN_WINDOW_MINUTES * 60_000 + 1_000],
    ['Join in 40 minutes', 40 * 60_000],
    ['Join in 3 hours', 3 * 60 * 60_000 + 30_000],
    ['Join tomorrow', 25 * 60 * 60_000],
    ['Join in 3 days', 3 * 24 * 60 * 60_000],
  ])('renders "%s"', (label, offsetMs) => {
    const nudge = {
      ...UPCOMING,
      scheduledStartIso: new Date(NOW.getTime() + offsetMs).toISOString(),
      live: offsetMs <= CASE_JOIN_WINDOW_MINUTES * 60_000,
    };
    render(<CaseNudge {...BASE} nudge={nudge} lens="client" />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('CaseNudge — exactly one moving thing', () => {
  it('the title dot no longer pulses while live', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" />);
    // The dot is `aria-hidden`, so it has no role or text a query can target.
    const dot = document.querySelector('.bg-destructive');
    expect(dot).not.toBeNull();
    expect(dot?.className ?? '').not.toContain('animate-pulse');
  });

  it('the Join button keeps its ping-ring cue and reduced-motion fallback', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING_LIVE} lens="client" />);
    const join = screen.getByRole('button', { name: /^Join .*meeting/i });
    expect(join.className).toContain('motion-safe:before:animate-ping-slow');
    expect(join.className).toContain('motion-reduce:ring-primary');
  });

  it('the countdown carries no animation classes of its own', () => {
    render(<CaseNudge {...BASE} nudge={UPCOMING} lens="client" />);
    expect(screen.getByTestId('join-countdown').className).not.toMatch(/animate-/);
  });
});
