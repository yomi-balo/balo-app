import { describe, expect, it } from 'vitest';
import { CASES_INDEX_CARD_STATES } from '@balo/analytics/events';
import {
  CASE_TRAIL_MAX_MARKS,
  caseTrailAriaLabel,
  caseTrailMark,
  formatCaseBooking,
  formatCaseDay,
  relativeDayLabel,
  resolveCardBand,
  resolveCaseCardState,
  resolveFeaturedTiming,
  resolveNextSlot,
  splitProductTags,
  type CaseNudgeKind,
} from './cases-index-presentation';
import type { CaseTrailEntry, CasesIndexCardView } from './cases-index-view-types';

/**
 * BAL-567 — the index's pure presentation rules.
 *
 * ⚠ `TZ=UTC` IS REQUIRED (memory `reference_web_tests_need_tz_utc`), but every case below ALSO
 * injects its zone explicitly, so a machine running in another zone fails on the harness rather
 * than on a silently different expectation.
 */

const NOW = new Date('2026-09-16T04:30:00.000Z'); // Wed 16 Sep, 2:30pm AEST / 4:30am UTC
const MIN = 60_000;

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
    productTags: ['CPQ', 'Revenue Cloud'],
    trail: [{ ordinal: 1, mark: 'held' }],
    heldCount: 1,
    actionItemsForYou: 2,
    unread: false,
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

// ── The trail ─────────────────────────────────────────────────────────────────────────────────

describe('caseTrailMark', () => {
  it('draws a pending reschedule as still BOOKED — the original time stands', () => {
    expect(caseTrailMark('pending_reschedule')).toBe('booked');
    expect(caseTrailMark('scheduled')).toBe('booked');
    expect(caseTrailMark('in_progress')).toBe('booked');
  });

  it('never calls an unrecorded outcome "missed" — that would accuse somebody', () => {
    expect(caseTrailMark('outcome_pending')).toBe('unrecorded');
    expect(caseTrailMark('no_show_client')).toBe('missed');
    expect(caseTrailMark('missed_call')).toBe('missed');
  });

  it('maps held and cancelled to their own marks', () => {
    expect(caseTrailMark('held')).toBe('held');
    expect(caseTrailMark('cancelled')).toBe('cancelled');
  });
});

describe('caseTrailAriaLabel', () => {
  const trail = (...marks: CaseTrailEntry['mark'][]): CaseTrailEntry[] =>
    marks.map((mark, index) => ({ ordinal: index + 1, mark }));

  it('is null for an empty trail — there is nothing to announce', () => {
    expect(caseTrailAriaLabel([])).toBeNull();
  });

  it('counts by mark, in the tuple order, omitting the zeroes', () => {
    expect(caseTrailAriaLabel(trail('held', 'booked', 'held'))).toBe(
      'Consultations: 2 held, 1 booked'
    );
  });

  it('reads an unrecorded outcome as "not recorded"', () => {
    expect(caseTrailAriaLabel(trail('unrecorded'))).toBe('Consultations: 1 not recorded');
  });

  it('does not depend on the order the consultations happened in', () => {
    expect(caseTrailAriaLabel(trail('booked', 'held'))).toBe(
      caseTrailAriaLabel(trail('held', 'booked'))
    );
  });
});

// ── The eight states ──────────────────────────────────────────────────────────────────────────

describe('resolveCaseCardState', () => {
  const EXPECTED: readonly (readonly [CaseNudgeKind, number, string])[] = [
    ['upcoming', 3, 'booked'],
    ['reschedule_proposal', 3, 'proposal'],
    ['reschedule_proposal_pending', 3, 'proposal_pending'],
    ['resolution_ask', 3, 'resolution_ask'],
    ['resolution_ask_pending', 3, 'resolution_ask_pending'],
    ['nothing_booked', 3, 'nothing_booked'],
    ['nothing_booked', 0, 'no_calls'],
  ];

  it('covers every nudge kind (guards a shrunken table)', () => {
    expect(EXPECTED).toHaveLength(7);
  });

  it.each(EXPECTED)('%s with a trail of %i → %s', (kind, trailLength, expected) => {
    expect(resolveCaseCardState(kind, trailLength)).toBe(expected);
  });

  it('never produces `live` — that is the VIEWER’s clock’s answer, not the server’s', () => {
    const produced = EXPECTED.map(([kind, length]) => resolveCaseCardState(kind, length));
    expect(produced).not.toContain('live');
    // …and the seven it does produce, plus `live`, are exactly the analytics tuple.
    expect([...new Set([...produced, 'live'])].sort()).toEqual([...CASES_INDEX_CARD_STATES].sort());
  });
});

// ── The featured ticket's timing ──────────────────────────────────────────────────────────────

describe('resolveFeaturedTiming', () => {
  const featured = (overrides: Partial<CasesIndexCardView> = {}): CasesIndexCardView =>
    card({ joinPath: '/meetings/m-1/call', ...overrides });

  it('offers no Join and keeps the server state outside the window', () => {
    const timing = resolveFeaturedTiming(featured(), NOW);
    expect(timing).toEqual({
      joinVisible: false,
      statusText: null,
      timingLabel: null,
      effectiveState: 'booked',
    });
  });

  it('opens Join 15 minutes before the start and promotes the state to `live`', () => {
    const timing = resolveFeaturedTiming(
      featured({
        nextBookingStartIso: new Date(NOW.getTime() + 9 * MIN).toISOString(),
        nextBookingEndIso: new Date(NOW.getTime() + 39 * MIN).toISOString(),
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(true);
    expect(timing.effectiveState).toBe('live');
    expect(timing.statusText).toBe('Starts in 9 mins');
    expect(timing.timingLabel).toBe('starting in 9 minutes');
  });

  it('says "Happening now" once the call has begun', () => {
    const timing = resolveFeaturedTiming(
      featured({
        nextBookingStartIso: new Date(NOW.getTime() - 5 * MIN).toISOString(),
        nextBookingEndIso: new Date(NOW.getTime() + 25 * MIN).toISOString(),
        nextBookingStatus: 'in_progress',
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(true);
    expect(timing.statusText).toBe('Happening now');
  });

  it('refuses outright on a TERMINAL status, even inside the clock window', () => {
    const timing = resolveFeaturedTiming(
      featured({
        nextBookingStartIso: new Date(NOW.getTime() + 5 * MIN).toISOString(),
        nextBookingEndIso: new Date(NOW.getTime() + 35 * MIN).toISOString(),
        nextBookingStatus: 'cancelled',
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(false);
  });

  it('offers no Join with no join path — a card that cannot render one is never `live`', () => {
    const timing = resolveFeaturedTiming(
      card({
        joinPath: null,
        nextBookingStartIso: new Date(NOW.getTime() + 5 * MIN).toISOString(),
        nextBookingEndIso: new Date(NOW.getTime() + 35 * MIN).toISOString(),
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(false);
    expect(timing.effectiveState).toBe('booked');
  });

  it('leaves a PROPOSAL state alone — a live proposal outranks "it is starting"', () => {
    const timing = resolveFeaturedTiming(
      featured({
        cardState: 'proposal',
        nextBookingStartIso: new Date(NOW.getTime() + 5 * MIN).toISOString(),
        nextBookingEndIso: new Date(NOW.getTime() + 35 * MIN).toISOString(),
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(true);
    expect(timing.effectiveState).toBe('proposal');
  });
});

// ── Formatting ────────────────────────────────────────────────────────────────────────────────

describe('formatCaseBooking', () => {
  it('formats the ticket parts in the injected zone, not the machine’s', () => {
    const parts = formatCaseBooking(
      '2026-09-16T04:30:00.000Z',
      '2026-09-16T05:00:00.000Z',
      NOW,
      'Australia/Sydney'
    );
    expect(parts).toMatchObject({
      dow: 'Wed',
      dowLong: 'Wednesday',
      day: '16',
      mon: 'Sep',
      monLong: 'September',
      time: '2:30 pm',
      durationMinutes: 30,
      relative: 'Today',
    });
  });

  it('reads the SAME instant as a different calendar day in a different zone', () => {
    const sydney = formatCaseBooking(
      '2026-09-16T14:30:00.000Z',
      '2026-09-16T15:00:00.000Z',
      NOW,
      'Australia/Sydney'
    );
    const utc = formatCaseBooking(
      '2026-09-16T14:30:00.000Z',
      '2026-09-16T15:00:00.000Z',
      NOW,
      'UTC'
    );
    expect(sydney.day).toBe('17');
    expect(utc.day).toBe('16');
  });
});

describe('relativeDayLabel', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2026-09-16T23:00:00.000Z', 'Today'],
    ['2026-09-17T09:00:00.000Z', 'Tomorrow'],
    ['2026-09-15T09:00:00.000Z', 'Yesterday'],
    ['2026-09-18T09:00:00.000Z', 'In 2 days'],
    ['2026-10-27T09:00:00.000Z', 'In 6 weeks'],
    ['2026-09-10T09:00:00.000Z', '6 days ago'],
    ['2026-08-16T09:00:00.000Z', '4 weeks ago'],
  ];

  it.each(cases)('%s reads as "%s"', (iso, expected) => {
    expect(relativeDayLabel(iso, NOW, 'UTC')).toBe(expected);
  });

  it('switches from days to weeks at a fortnight, and singularises the first week', () => {
    // ⚠ THE BOUNDARY IS 14 DAYS, NOT 7. "In 9 days" is more useful than "In 1 week"; past a
    // fortnight the day count stops being something anyone counts.
    expect(relativeDayLabel('2026-09-29T09:00:00.000Z', NOW, 'UTC')).toBe('In 13 days');
    expect(relativeDayLabel('2026-09-30T09:00:00.000Z', NOW, 'UTC')).toBe('In 2 weeks');
    expect(relativeDayLabel('2026-09-02T09:00:00.000Z', NOW, 'UTC')).toBe('2 weeks ago');
  });
});

describe('formatCaseDay', () => {
  it('renders the short day/month in the injected zone', () => {
    expect(formatCaseDay('2026-09-12T00:00:00.000Z', 'UTC')).toBe('12 Sep');
  });
});

// ── Slots, bands and tags ─────────────────────────────────────────────────────────────────────

describe('resolveNextSlot', () => {
  it('renders the booked stub with no caption and no action', () => {
    const slot = resolveNextSlot(card(), 'company', NOW, 'UTC');
    expect(slot).toMatchObject({ kind: 'stub', label: null, note: null, action: null });
  });

  it('captions a live proposal "Booked for now" and offers the amber answer', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'proposal', actorLabel: 'Dana', proposalOptionCount: 3 }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({
      kind: 'stub',
      label: 'Booked for now',
      action: {
        target: 'choose_time',
        label: 'Choose a time',
        href: '/cases/eng-1',
        tone: 'amber',
      },
    });
  });

  it('notes the ACTOR on a pending proposal, never "you" for a colleague', () => {
    const mine = resolveNextSlot(
      card({ cardState: 'proposal_pending', actorLabel: 'You' }),
      'expert',
      NOW,
      'UTC'
    );
    const theirs = resolveNextSlot(
      card({ cardState: 'proposal_pending', actorLabel: 'Priya' }),
      'expert',
      NOW,
      'UTC'
    );
    expect(mine).toMatchObject({ note: 'You suggested new times' });
    expect(theirs).toMatchObject({ note: 'Priya suggested new times' });
  });

  it('offers Review on a resolution ask, with the last call as the sub', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'resolution_ask', actorLabel: 'Dana', nextBookingStartIso: null }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({
      kind: 'quiet',
      icon: 'calendar-plus',
      title: 'Nothing booked',
      sub: 'Last call 12 Sep',
      action: { target: 'review', label: 'Review' },
    });
  });

  it('names the actor on a PENDING ask and waits on the counterparty', () => {
    const slot = resolveNextSlot(
      card({
        cardState: 'resolution_ask_pending',
        actorLabel: 'Priya',
        counterpartyName: 'Acme Corp',
      }),
      'expert',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({
      kind: 'quiet',
      icon: 'circle-help',
      title: 'Priya asked if this is sorted',
      sub: 'Waiting on Acme Corp',
      action: null,
    });
  });

  it('offers "Book another" to the CLIENT side only', () => {
    const forClient = resolveNextSlot(card({ cardState: 'nothing_booked' }), 'company', NOW, 'UTC');
    const forExpert = resolveNextSlot(card({ cardState: 'nothing_booked' }), 'expert', NOW, 'UTC');
    expect(forClient).toMatchObject({ action: { target: 'book_another', label: 'Book another' } });
    expect(forExpert).toMatchObject({ action: null });
  });

  it('offers "Book a time" on a case that has never held one', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'no_calls', trail: [], lastCallAtIso: null }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({
      kind: 'quiet',
      title: 'No consultation booked',
      sub: 'Pick a time to get started',
      action: { target: 'book_time', label: 'Book a time' },
    });
  });

  it('renders NO booking action when the expert has no username — never /experts/null', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'nothing_booked', bookAgainHref: null }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({ action: null });
  });

  it('falls back to the quiet slot when a "booked" card has no readable booking', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'booked', nextBookingStartIso: null, nextBookingEndIso: null }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({ kind: 'quiet', title: 'Nothing booked' });
  });

  it('omits the "last call" sub on a case that has never held one', () => {
    const slot = resolveNextSlot(
      card({ cardState: 'nothing_booked', lastCallAtIso: null }),
      'company',
      NOW,
      'UTC'
    );
    expect(slot).toMatchObject({ sub: null });
  });
});

describe('resolveCardBand', () => {
  it('names the ACTOR and the option count on a live proposal', () => {
    const band = resolveCardBand(
      card({ cardState: 'proposal', actorLabel: 'Priya @ CloudPeak', proposalOptionCount: 3 }),
      'company'
    );
    expect(band).toEqual({
      tone: 'amber',
      icon: 'calendar-clock',
      text: 'Priya @ CloudPeak suggested 3 new times',
    });
  });

  it('singularises a single suggested time', () => {
    const band = resolveCardBand(
      card({ cardState: 'proposal', actorLabel: 'Dana', proposalOptionCount: 1 }),
      'company'
    );
    expect(band?.text).toBe('Dana suggested 1 new time');
  });

  it('uses the case page’s own wording for a resolution ask', () => {
    const band = resolveCardBand(
      card({ cardState: 'resolution_ask', actorLabel: 'Dana' }),
      'company'
    );
    expect(band).toEqual({
      tone: 'violet',
      icon: 'circle-help',
      text: "Dana thinks this one's sorted",
    });
  });

  it('NEVER renders a band on the expert side — the expert made both asks', () => {
    for (const state of ['proposal', 'resolution_ask'] as const) {
      expect(resolveCardBand(card({ cardState: state, actorLabel: 'Dana' }), 'expert')).toBeNull();
    }
  });

  it('renders no band for any other state, on either side', () => {
    for (const state of ['booked', 'proposal_pending', 'nothing_booked', 'no_calls'] as const) {
      expect(resolveCardBand(card({ cardState: state, actorLabel: 'Dana' }), 'company')).toBeNull();
    }
  });

  it('renders no band with no actor to name', () => {
    expect(
      resolveCardBand(card({ cardState: 'proposal', actorLabel: null }), 'company')
    ).toBeNull();
  });
});

describe('splitProductTags', () => {
  it('shows up to the cap and reports the overflow', () => {
    expect(splitProductTags(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], overflow: 1 });
  });

  it('reports no overflow when everything fits', () => {
    expect(splitProductTags(['a'], 2)).toEqual({ shown: ['a'], overflow: 0 });
  });
});

describe('CASE_TRAIL_MAX_MARKS', () => {
  it('is the six the design draws', () => {
    expect(CASE_TRAIL_MAX_MARKS).toBe(6);
  });
});
