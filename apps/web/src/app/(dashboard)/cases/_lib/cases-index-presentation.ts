import { formatInTimeZone } from 'date-fns-tz';
import type { CaseConsultationStateLabel } from '@balo/shared/engagements';
import type { CasesIndexCardState, CasesIndexTarget } from '@balo/analytics/events';
import { addDaysToDayKey, todayDayKey, zonedDayKey } from '@/lib/calendar/zoned-grid';
import {
  calendarJoinAffordanceVisible,
  joinAffordanceTimingLabel,
  signedMinutesUntilCalendarStart,
} from '@/lib/calendar/join-window';
import { proposalPendingTitle, resolutionAskPendingTitle } from '@/lib/cases/actor-attribution';
import {
  CASE_TRAIL_WORDS,
  CASES_INDEX_BOOK_ANOTHER,
  CASES_INDEX_BOOK_TIME,
  CASES_INDEX_BOOKED_FOR_NOW,
  CASES_INDEX_CHOOSE_TIME,
  CASES_INDEX_HAPPENING_NOW,
  CASES_INDEX_NO_CALLS_SUB,
  CASES_INDEX_NO_CALLS_TITLE,
  CASES_INDEX_NOTHING_BOOKED,
  CASES_INDEX_REVIEW,
  casesIndexLastCall,
  casesIndexProposalBand,
  casesIndexResolutionBand,
  casesIndexStartsIn,
  casesIndexTrailLabel,
  casesIndexWaitingOn,
} from './cases-index-copy';
import {
  CASE_TRAIL_MARKS,
  type CaseTrailEntry,
  type CaseTrailMark,
  type CasesIndexCardView,
  type CasesIndexSide,
} from './cases-index-view-types';

/**
 * BAL-567 — the `/cases` index's PURE presentation rules. Client-safe, no `server-only`, no I/O,
 * and NO CLOCK OF ITS OWN: `now` and `timeZone` are always injected, so the caller owns the one
 * source of "now" (`useViewerClock`) and every function here is testable at a fixed instant.
 *
 * ⚠ THE EIGHT CARD STATES ARE A DATA TABLE, NOT EIGHT BRANCHES. `CARD_STATE_BY_NUDGE` below is
 * the whole mapping, and it is derived from `selectCaseNudge`'s output rather than re-deriving
 * the nudge PRIORITY — a second copy of that ordering would be a second place the "the ask is
 * suppressed while anything is booked" rule lives, and the two would drift.
 */

const MS_PER_MINUTE = 60_000;

/** How many marks the trail renders. Older consultations fall off the left, as the design does. */
export const CASE_TRAIL_MAX_MARKS = 6;

/** How many product tags the card renders before the "+N" chip. Keyed by DENSITY, not by side. */
export const CASE_TAGS_SHOWN = { comfortable: 2, dense: 1 } as const;

// ── The trail ─────────────────────────────────────────────────────────────────────────────────

/**
 * `deriveCaseConsultationState`'s label → the mark the trail draws.
 *
 * ⚠ TOTAL OVER THE UNION, and stated as a `Record` so a ninth `CaseConsultationStateLabel` fails
 * `tsc` here rather than falling through to a default that quietly draws the wrong dot.
 *
 * ⚠ `pending_reschedule` DRAWS AS `booked`, NOT AS SOMETHING OF ITS OWN. The original booking
 * stands until an option is accepted, so the consultation is still expected to happen — the
 * same reasoning `caseConsultationIsUpcoming` applies. The PROPOSAL is reported by the card's
 * state and band, which is where it can be read.
 */
const TRAIL_MARK_BY_STATE: Readonly<Record<CaseConsultationStateLabel, CaseTrailMark>> = {
  held: 'held',
  scheduled: 'booked',
  pending_reschedule: 'booked',
  in_progress: 'booked',
  cancelled: 'cancelled',
  no_show_client: 'missed',
  missed_call: 'missed',
  outcome_pending: 'unrecorded',
};

export function caseTrailMark(state: CaseConsultationStateLabel): CaseTrailMark {
  return TRAIL_MARK_BY_STATE[state];
}

/**
 * The trail's accessible name — "Consultations: 2 held, 1 booked".
 *
 * ⚠ ORDERED BY `CASE_TRAIL_MARKS`, NEVER BY INSERTION. `Object.keys` order would make the
 * sentence depend on which consultation happened first, so two cases with identical trails could
 * read differently. Marks with a zero count are omitted rather than read out as "0 cancelled".
 */
export function caseTrailAriaLabel(trail: readonly CaseTrailEntry[]): string | null {
  if (trail.length === 0) return null;
  const parts: string[] = [];
  for (const mark of CASE_TRAIL_MARKS) {
    const count = trail.filter((entry) => entry.mark === mark).length;
    if (count > 0) parts.push(`${count} ${CASE_TRAIL_WORDS[mark]}`);
  }
  return casesIndexTrailLabel(parts);
}

// ── The eight card states ─────────────────────────────────────────────────────────────────────

/** The nudge kinds a card can be built from — `selectCaseNudge`'s non-null output. */
export type CaseNudgeKind =
  | 'upcoming'
  | 'reschedule_proposal'
  | 'reschedule_proposal_pending'
  | 'resolution_ask'
  | 'resolution_ask_pending'
  | 'nothing_booked';

/**
 * ⚠ A TOTAL LOOKUP, NOT A SWITCH. Seven of the eight states fall straight out of the nudge kind;
 * only `no_calls` needs a second input (an empty trail), and `live` is never produced here — it
 * is the VIEWER's clock's answer, resolved by {@link resolveFeaturedTiming} on the tick.
 */
const CARD_STATE_BY_NUDGE: Readonly<Record<CaseNudgeKind, CasesIndexCardState>> = {
  upcoming: 'booked',
  reschedule_proposal: 'proposal',
  reschedule_proposal_pending: 'proposal_pending',
  resolution_ask: 'resolution_ask',
  resolution_ask_pending: 'resolution_ask_pending',
  nothing_booked: 'nothing_booked',
};

export function resolveCaseCardState(
  kind: CaseNudgeKind,
  trailLength: number
): CasesIndexCardState {
  // "Nothing booked and nothing ever held" is a different invitation from "nothing booked
  // *right now*" — the first case has never had a consultation and gets the setup copy.
  if (kind === 'nothing_booked' && trailLength === 0) return 'no_calls';
  return CARD_STATE_BY_NUDGE[kind];
}

// ── The featured ticket's timing ──────────────────────────────────────────────────────────────

export interface FeaturedTiming {
  /** `calendarJoinAffordanceVisible` — −15 min inclusive .. end + 30 min exclusive, non-terminal. */
  readonly joinVisible: boolean;
  /** The pill's sentence: "Happening now" / "Starts in 9 mins" / `null` outside the window. */
  readonly statusText: string | null;
  /** `joinAffordanceTimingLabel`'s aria suffix, or `null` outside the window. */
  readonly timingLabel: string | null;
  /** `'live'` inside the window, the card's own server-derived state outside it. */
  readonly effectiveState: CasesIndexCardState;
}

/**
 * The featured card's clock-dependent half.
 *
 * ⚠⚠ `live` IS RESOLVED HERE AND NOWHERE ELSE, and only for a card that HAS a booking and a
 * join path — so at most ONE card per page can ever carry it, which is what
 * `CASES_INDEX_CARD_STATES`' documentation promises the analytics.
 *
 * ⚠ IT REUSES `calendarJoinAffordanceVisible` RATHER THAN COMPARING MINUTES. That predicate is
 * the product's one Join window (BAL-498/BAL-513): it opens at `CASE_JOIN_WINDOW_MINUTES` before
 * the start, closes at `scheduledEnd + MEETING_OVERRUN_GRACE_MINUTES`, and refuses outright on a
 * terminal status. A hand-rolled "within 15 minutes" here would disagree with the case page, the
 * calendar and the dashboard the moment any of those three moved.
 */
export function resolveFeaturedTiming(
  card: Pick<
    CasesIndexCardView,
    'cardState' | 'nextBookingStartIso' | 'nextBookingEndIso' | 'nextBookingStatus' | 'joinPath'
  >,
  now: Date
): FeaturedTiming {
  const { nextBookingStartIso, nextBookingEndIso, nextBookingStatus } = card;
  const bookingIsReadable =
    nextBookingStartIso !== null && nextBookingEndIso !== null && nextBookingStatus !== null;
  if (!bookingIsReadable || card.joinPath === null) {
    return {
      joinVisible: false,
      statusText: null,
      timingLabel: null,
      effectiveState: card.cardState,
    };
  }

  const scheduledStart = new Date(nextBookingStartIso);
  const scheduledEnd = new Date(nextBookingEndIso);
  const joinVisible = calendarJoinAffordanceVisible(
    now,
    scheduledStart,
    scheduledEnd,
    nextBookingStatus
  );
  if (!joinVisible) {
    return {
      joinVisible: false,
      statusText: null,
      timingLabel: null,
      effectiveState: card.cardState,
    };
  }

  const signedMinutes = signedMinutesUntilCalendarStart(now, scheduledStart);
  // `<= 0` covers `-0` (the boundary minute) as well as a call already under way.
  const happeningNow = nextBookingStatus === 'in_progress' || signedMinutes <= 0;
  return {
    joinVisible: true,
    statusText: happeningNow ? CASES_INDEX_HAPPENING_NOW : casesIndexStartsIn(signedMinutes),
    timingLabel: joinAffordanceTimingLabel(now, scheduledStart),
    // ⚠ `live` REPLACES the server's `booked`, and ONLY that: a card whose server state is
    // `proposal` keeps it, because a live proposal is the more urgent thing to say.
    effectiveState: card.cardState === 'booked' ? 'live' : card.cardState,
  };
}

// ── Date and time formatting ──────────────────────────────────────────────────────────────────

export interface CaseBookingParts {
  /** "Wed" / "Wednesday" — the ticket stub uses the short form on mobile, the long on desktop. */
  readonly dow: string;
  readonly dowLong: string;
  /** "16", zero-stripped. */
  readonly day: string;
  readonly mon: string;
  readonly monLong: string;
  /** "2:30 pm", lowercase meridiem. */
  readonly time: string;
  readonly durationMinutes: number;
  /** "Today" / "Tomorrow" / "In 2 days" / "In 6 weeks" / "3 days ago". */
  readonly relative: string;
}

/**
 * The featured ticket's and the mini stub's shared date parts, in the VIEWER's zone.
 *
 * ⚠ ONE BUILDER FOR BOTH STUBS. The ticket and the grid card show the same booking at different
 * sizes; two formatters would let them disagree about which day a late-evening call falls on.
 */
export function formatCaseBooking(
  startIso: string,
  endIso: string,
  now: Date,
  timeZone: string
): CaseBookingParts {
  const start = new Date(startIso);
  return {
    dow: formatInTimeZone(start, timeZone, 'EEE'),
    dowLong: formatInTimeZone(start, timeZone, 'EEEE'),
    day: formatInTimeZone(start, timeZone, 'd'),
    mon: formatInTimeZone(start, timeZone, 'MMM'),
    monLong: formatInTimeZone(start, timeZone, 'MMMM'),
    time: formatInTimeZone(start, timeZone, 'h:mm aaa'),
    durationMinutes: Math.round((new Date(endIso).getTime() - start.getTime()) / MS_PER_MINUTE),
    relative: relativeDayLabel(startIso, now, timeZone),
  };
}

/** "12 Sep" — the quiet slot's "Last call {date}" and the card footer's "Opened {date}". */
export function formatCaseDay(iso: string, timeZone: string): string {
  return formatInTimeZone(new Date(iso), timeZone, 'd MMM');
}

/**
 * "Today" / "Tomorrow" / "In 3 days" / "In 6 weeks", and the past forms.
 *
 * ⚠ DAY-KEY ARITHMETIC, NOT MILLISECOND DIVISION. Two instants 20 hours apart can be one, two or
 * the same calendar day depending on the zone and on DST; comparing `yyyy-MM-dd` keys in the
 * viewer's zone is the only version that says "Tomorrow" when the viewer would.
 */
export function relativeDayLabel(iso: string, now: Date, timeZone: string): string {
  const todayKey = todayDayKey(timeZone, now);
  const targetKey = zonedDayKey(iso, timeZone);
  if (targetKey === todayKey) return 'Today';
  if (targetKey === addDaysToDayKey(todayKey, 1)) return 'Tomorrow';
  if (targetKey === addDaysToDayKey(todayKey, -1)) return 'Yesterday';

  const days = dayKeyDelta(todayKey, targetKey);
  const magnitude = Math.abs(days);
  const unit =
    magnitude < 14 ? { n: magnitude, word: 'day' } : { n: Math.round(magnitude / 7), word: 'week' };
  const phrase = `${unit.n} ${unit.word}${unit.n === 1 ? '' : 's'}`;
  return days > 0 ? `In ${phrase}` : `${phrase} ago`;
}

/** Whole days from `fromKey` to `toKey`. Both are `yyyy-MM-dd`, so `Date.UTC` diffing is exact. */
function dayKeyDelta(fromKey: string, toKey: string): number {
  const asUtcMs = (key: string): number => {
    const [year, month, day] = key.split('-').map(Number);
    if (year === undefined || month === undefined || day === undefined) return Number.NaN;
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((asUtcMs(toKey) - asUtcMs(fromKey)) / 86_400_000);
}

// ── The eight states, as ONE table ────────────────────────────────────────────────────────────

/** Which affordance a slot offers. Every one of them OPENS THE CASE — see {@link SlotAction}. */
export interface SlotAction {
  readonly target: CasesIndexTarget;
  readonly label: string;
  readonly href: string;
  /** `amber` is the reschedule-proposal answer; everything else is the neutral outline button. */
  readonly tone: 'amber' | 'neutral';
}

/** Which icon a quiet slot draws. A NAME, not a component — this module renders nothing. */
export type QuietSlotIcon = 'calendar-plus' | 'circle-help';

export type NextSlotView =
  | {
      readonly kind: 'stub';
      readonly booking: CaseBookingParts;
      /** A small caption above the time, e.g. "Booked for now" while an answer is pending. */
      readonly label: string | null;
      /** An amber note under the time, e.g. "Priya suggested new times". */
      readonly note: string | null;
      readonly action: SlotAction | null;
    }
  | {
      readonly kind: 'quiet';
      readonly icon: QuietSlotIcon;
      readonly title: string;
      readonly sub: string | null;
      readonly action: SlotAction | null;
    };

/**
 * ⚠⚠ THE INDEX CARRIES NO CAPABILITY-GATED ACT AFFORDANCE AT ALL, and that is the rule this
 * type exists to keep. Every button on every card NAVIGATES TO THE CASE, where the real gate
 * (`resolveCaseAccess` → `authorizeEngagementConversation`, plus the engagement axis) runs. So
 * the index never resolves `hasEngagementCapability` — which would be four short-circuiting
 * calls PER CARD — and it can never show a button that fails.
 *
 * The one exception proves the rule: the featured card's JOIN is not an act on the case, it is a
 * navigation to the call route, which does its own admission.
 */
interface NextSlotContext {
  readonly card: CasesIndexCardView;
  readonly side: CasesIndexSide;
  readonly now: Date;
  readonly timeZone: string;
}

/** Only the CLIENT side can book, so only it is ever offered a booking action. */
const SHOWS_BOOK_ACTION: Readonly<Record<CasesIndexSide, boolean>> = {
  company: true,
  expert: false,
};

/** Only the CLIENT side renders a state band — the expert side reads the state in the slot. */
const SHOWS_STATE_BAND: Readonly<Record<CasesIndexSide, boolean>> = {
  company: true,
  expert: false,
};

/** "Book another" / "Book a time" — client side only, and only with a live destination. */
function bookAction(
  context: NextSlotContext,
  target: CasesIndexTarget,
  label: string
): SlotAction | null {
  const { bookAgainHref } = context.card;
  if (!SHOWS_BOOK_ACTION[context.side] || bookAgainHref === null) return null;
  return { target, label, href: bookAgainHref, tone: 'neutral' };
}

/** "Last call 12 Sep", or `null` when the case has never held one. */
function lastCallSub(context: NextSlotContext): string | null {
  const { lastCallAtIso } = context.card;
  return lastCallAtIso === null
    ? null
    : casesIndexLastCall(formatCaseDay(lastCallAtIso, context.timeZone));
}

/** The quiet "nothing is booked" slot every un-booked state falls back to. */
function nothingBookedSlot(context: NextSlotContext, action: SlotAction | null): NextSlotView {
  return {
    kind: 'quiet',
    icon: 'calendar-plus',
    title: CASES_INDEX_NOTHING_BOOKED,
    sub: lastCallSub(context),
    action,
  };
}

/**
 * A booked slot, or the quiet one when the booking cannot be read.
 *
 * ⚠ THE FALLBACK IS NOT DEFENSIVE NOISE. `nextBookingStartIso` is structurally nullable on the
 * view (a case with no booking has none), and a `!` here would be an assertion about a
 * relationship the type does not carry (memory `reference_sonar_nonnull_false_positive`). If the
 * two ever disagree, "nothing booked" is the honest answer rather than a crash or an invented
 * date.
 */
function stubSlot(
  context: NextSlotContext,
  parts: { label: string | null; note: string | null; action: SlotAction | null }
): NextSlotView {
  const { nextBookingStartIso, nextBookingEndIso } = context.card;
  if (nextBookingStartIso === null || nextBookingEndIso === null) {
    return nothingBookedSlot(context, parts.action);
  }
  return {
    kind: 'stub',
    booking: formatCaseBooking(
      nextBookingStartIso,
      nextBookingEndIso,
      context.now,
      context.timeZone
    ),
    label: parts.label,
    note: parts.note,
    action: parts.action,
  };
}

/**
 * ⚠⚠ THE EIGHT CARD STATES, AS A DATA TABLE RATHER THAN EIGHT `if` BRANCHES. Each entry is one
 * expression, so the dispatcher's cognitive complexity is 1 and a ninth state fails `tsc` here
 * (the `Record` is total over the union) instead of falling through to a default.
 *
 * `live` maps to the same stub as `booked`: on the GRID it cannot occur (only the featured card
 * resolves `live`), and on the featured card the ticket stub renders the booking itself — so
 * sharing the entry is the honest answer rather than an unreachable branch.
 */
const NEXT_SLOT_BY_STATE: Readonly<
  Record<CasesIndexCardState, (c: NextSlotContext) => NextSlotView>
> = {
  live: (c) => stubSlot(c, { label: null, note: null, action: null }),
  booked: (c) => stubSlot(c, { label: null, note: null, action: null }),
  proposal: (c) =>
    stubSlot(c, {
      label: CASES_INDEX_BOOKED_FOR_NOW,
      note: null,
      action: {
        target: 'choose_time',
        label: CASES_INDEX_CHOOSE_TIME,
        href: c.card.href,
        tone: 'amber',
      },
    }),
  proposal_pending: (c) =>
    stubSlot(c, {
      label: null,
      note: proposalPendingTitle(c.card.actorLabel ?? ''),
      action: null,
    }),
  resolution_ask: (c) => ({
    kind: 'quiet',
    icon: 'calendar-plus',
    title: CASES_INDEX_NOTHING_BOOKED,
    sub: lastCallSub(c),
    action: {
      target: 'review',
      label: CASES_INDEX_REVIEW,
      href: c.card.href,
      tone: 'neutral',
    },
  }),
  resolution_ask_pending: (c) => ({
    kind: 'quiet',
    icon: 'circle-help',
    title: resolutionAskPendingTitle(c.card.actorLabel ?? ''),
    sub: casesIndexWaitingOn(c.card.counterpartyName),
    action: null,
  }),
  nothing_booked: (c) =>
    nothingBookedSlot(c, bookAction(c, 'book_another', CASES_INDEX_BOOK_ANOTHER)),
  no_calls: (c) => ({
    kind: 'quiet',
    icon: 'calendar-plus',
    title: CASES_INDEX_NO_CALLS_TITLE,
    sub: CASES_INDEX_NO_CALLS_SUB,
    action: bookAction(c, 'book_time', CASES_INDEX_BOOK_TIME),
  }),
};

export function resolveNextSlot(
  card: CasesIndexCardView,
  side: CasesIndexSide,
  now: Date,
  timeZone: string
): NextSlotView {
  return NEXT_SLOT_BY_STATE[card.cardState]({ card, side, now, timeZone });
}

// ── The state band ────────────────────────────────────────────────────────────────────────────

export interface CardBand {
  readonly tone: 'amber' | 'violet';
  readonly icon: 'calendar-clock' | 'circle-help';
  readonly text: string;
}

/**
 * The coloured strip across the top of a card.
 *
 * ⚠⚠ BANDS RENDER ON THE CLIENT SIDE ONLY, AND ONLY FOR THE TWO STATES THE TICKET NAMES. Both
 * say "the other party is waiting on YOU"; on the expert side neither is true — the expert MADE
 * those asks — so a band there would be shouting somebody's own message back at them.
 *
 * ⚠ THE ACTOR IS NAMED, NOT THE COUNTERPARTY. The design reference says "{first name} asked if
 * this is sorted" using the expert on the card; the ticket's Attribution section overrides it, so
 * an agency colleague's ask reads "Priya @ CloudPeak", not the delivering expert's name.
 */
export function resolveCardBand(card: CasesIndexCardView, side: CasesIndexSide): CardBand | null {
  if (!SHOWS_STATE_BAND[side] || card.actorLabel === null) return null;
  if (card.cardState === 'proposal') {
    return {
      tone: 'amber',
      icon: 'calendar-clock',
      text: casesIndexProposalBand(card.actorLabel, card.proposalOptionCount ?? 0),
    };
  }
  if (card.cardState === 'resolution_ask') {
    return {
      tone: 'violet',
      icon: 'circle-help',
      text: casesIndexResolutionBand(card.actorLabel),
    };
  }
  return null;
}

// ── Product tags ──────────────────────────────────────────────────────────────────────────────

/**
 * The tags a card shows, plus how many it could not fit. Split HERE rather than server-side
 * because the cut depends on the card's DENSITY, which is a render-time fact.
 */
export function splitProductTags(
  tags: readonly string[],
  max: number
): { readonly shown: readonly string[]; readonly overflow: number } {
  const shown = tags.slice(0, max);
  return { shown, overflow: tags.length - shown.length };
}
