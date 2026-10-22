import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Globe, Receipt, X } from 'lucide-react';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * Balo · Design reference — ExpertAvailabilityCalendar v2: ask for the length once
 * Repo path: .claude/design-references/availability-calendar-v2.jsx
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Supersedes the DURATION behaviour of `availability-calendar.jsx` (BAL-236). Everything this
 * file does not mention stays exactly as shipped in apps/web/src/components/availability/:
 * error / paused / not-configured / empty-window states, cross-midnight label, focus-follows-
 * step, per-expert reset, view and empty-state analytics.
 *
 * WHY
 * Internal testing (Oct 2026): clients were asked the length twice. The "Duration" pills were
 * a minimum-length FILTER, then the confirm step asked "How long do you need?" with the same
 * four values, and the filter's answer never carried forward. Cases bill per minute used, so
 * the length is a soft reservation of the expert's time; asking twice is pure friction.
 *
 * THE RULE: the length is asked once, up front, and every later screen echoes it.
 *
 * WHAT CHANGES (behaviour → shipped code)
 *  1. ONE QUESTION. "How long do you need?" is a single-choice radiogroup over the fixed
 *     SLOT_DURATION_LADDER (15/30/45/60). No "Any". Its value IS the booked length. Default
 *     60 via a new `defaultDurationMinutes` prop; if nothing in the window fits the default,
 *     fall back DOWN the ladder (60 → 45 → 30 → 15). A length nothing in the window can hold is disabled, never
 *     hidden, so the control doesn't reshuffle between days.
 *     → `derivePills` becomes the fixed ladder + an availability predicate; `DurationFilter`
 *       ('any' | n) becomes plain `SlotDurationMinutes`.
 *  2. IT SITS ABOVE BOTH PANELS, on one row with its label, because it now drives the month
 *     dots as well as the day's list. Under it: the length note (item 11), then the timezone
 *     line, which stays where it shipped, directly above the grid. → the control leaves
 *     `AvailabilitySlotsPanel` and renders in `ExpertAvailabilityCalendar`'s top block.
 *     Control style: compact segmented control (Cal.com's pattern), 44px targets on touch via
 *     `pointer: coarse`, full-width with equal segments below md. The selected fill is ONE
 *     indicator that slides to the chosen segment (260ms, ease-out cubic-bezier(.22,1,.36,1));
 *     the label colours cross-fade on the same curve. Reduced motion: it jumps, no slide.
 *     Real implementation: render `<motion.span layoutId="length-indicator">` inside the
 *     active item (Motion is already in the stack) with
 *     `transition={{ type: 'tween', duration: 0.26, ease: [0.22, 1, 0.36, 1] }}`, and
 *     `useReducedMotion()` → duration 0. No measuring code needed there.
 *  3. THE PICKER'S OWN CONFIRM STEP IS DELETED. "Continue with …" emits
 *     `onSlotSelect({ start, end, duration })` immediately. Every consumer already has its own
 *     next screen (BAL-400 StepConfirm, BAL-409 reschedule confirm), so that step was a double
 *     confirm everywhere. → remove `confirmStep`, `chosenDuration`, `onBack`,
 *     `confirmButtonLabel`, `confirmationDurations` and the B6 auto-set effect. The
 *     no-`onSlotSelect` "Time selected" state stays as it is.
 *  4. ROWS SHOW THE RANGE ("1:45 PM – 2:45 PM"), never "up to Xm". The pinned branch already
 *     renders `LocalDateTime variant="day-month-time-range"`; it becomes the only branch.
 *  5. MONTH MARKERS FOLLOW THE LENGTH. Filled dot = times at this length. Ring = shorter times
 *     only (still clickable, so the trade-off stays visible). → `daysWithSlots` splits into
 *     `daysAtLength` + `daysShorterOnly`; `AvailabilityMonthCalendar` gets a second marker and
 *     a second legend entry.
 *  6. "NEED IT SOONER?" When the chosen length hides earlier starts on the selected day, offer
 *     them, one per shorter length: for each length below the chosen one (longest first), its
 *     earliest start, kept only if it begins before every longer option already kept. That's
 *     the trade-off frontier, so every offer is a real choice (earlier = shorter) and a 30-min
 *     offer never shows at a time where 45 also fits. At most three (the ladder has four
 *     lengths), listed earliest first. Taking one switches the length and selects that time.
 *     See `soonerOffers`. This keeps the April rationale (an urgent client may take an
 *     earlier, shorter call) without asking everyone a second question.
 *  7. A DAY WITH NOTHING AT THIS LENGTH gives direction, not a blank list: "No 60-minute times
 *     on Thursday." + that day's shorter options + "Go to {next day at this length}".
 *     → replaces `shouldResetFilter`, `filterAutoReset` and the "Show all →" warning.
 *  8. CHANGING THE LENGTH KEEPS THE SELECTED TIME if it still fits; otherwise it clears.
 *  9. THE TIMES COLUMN widens from 300px to 340px (`md:grid-cols-[minmax(0,1fr)_340px]`) so a
 *     range row, three offers and "Continue with 1:45 PM – 2:45 PM →" each fit on one line.
 *     In the 640px booking and intro-call dialogs that leaves the month grid about 250px, enough
 *     for seven day columns; the reschedule and propose dialogs are 840px. Dialog widths do not
 *     change.
 * 10. THE DAY HEADING is always the date ("Thursday 22 October") with the Today badge beside
 *     it, never "Today [Today]".
 * 11. A LENGTH NOTE sits under the control: the length reserves the expert's time, it does not
 *     set the price. The WRAPPER owns it through a new `lengthNote?: ReactNode` slot, so the
 *     picker stays billing-agnostic and fee concealment stays in booking/. Both variants live
 *     beside BillingLine in billing-line.tsx (one place for the wording):
 *       per-minute Case (StepPickTime / BAL-400), Receipt icon:
 *         "You pay for the minutes you use, not the length you pick. {MIN_MEETING_MINUTES}-
 *          minute minimum."  ← interpolated, never hardcoded (D1b)
 *       project calls: ANY call booked in a project's context, before the project starts or
 *       after (intro-call-booking-dialog / BAL-283 today, plus any in-project call entry
 *       point), same Receipt icon:
 *         "Project calls are free at any length."
 *       Both notes use Receipt (owner, Oct 2026: Sparkles reads as an AI feature). This amends
 *       BAL-283 Ruling 2's "Sparkles, never Receipt" pin for this note. The intro-call confirm
 *       line ("Free — no charge, no commitment.") swaps to Receipt too, in BAL-614, so the two
 *       match.
 *       reschedule (pinned) and propose-times (expert side): no note.
 * 12. RESTORE ON "CHANGE". New optional `initialSelection` prop: when StepConfirm's "Change"
 *     returns to step 1, the length, day and time come back selected.
 *
 * MOBILE (below md, full-screen sheet as decided for BAL-400): one column; the length label
 * sits above a full-width control; the calendar and the day's times run edge to edge; the
 * times list is uncapped (the sheet scrolls); "Continue with …" is a sticky bottom bar so it
 * is reachable from anywhere in a long list. The segmented control does not need to wrap: four
 * fixed lengths get ≥72px each even at 320px wide. At very large text sizes a segment's own
 * label wraps inside it ("15" over "min"). If the ladder ever grows past five lengths, scroll
 * horizontally (Cal.com's booker does this, with arrow buttons) rather than wrap. The demo's
 * Viewport switch stands in for the shipped `md:` breakpoint, which the real component keeps.
 * Its Desktop view uses the real dialog widths: 640px for Case booking and project calls,
 * 840px for reschedule.
 *
 * PINNED (BAL-409 reschedule, `fixedDurationMinutes`): the pills are replaced by one read-only
 * line; no rings, no sooner offer; otherwise the SAME path. The B6 special cases collapse into
 * it, and B6(c)'s never-widen guarantee now holds by construction because 'any' no longer
 * exists.
 *
 * WRAPPER (StepConfirm, step-confirm.tsx): the summary card shows the range
 * ("Thursday 22 October, 1:45 PM – 2:45 PM" / "60-minute consultation"); "See other times"
 * becomes "Change" and passes the current selection back as `initialSelection`. Nothing else in
 * StepConfirm changes. The ConfirmMock below shows only that card.
 *
 * CONSUMERS TO CHECK: step-pick-time.tsx (BAL-400), reschedule-dialog.tsx (BAL-409),
 * propose-times-dialog.tsx (expert side; confirm the "Continue with …" copy still fits there).
 *
 * §8 in scope: route `private`; picker drops past starts on a ticking clock. The mock below
 * drops starts inside a 2-hour lead to model correct behaviour.
 *
 * COPY: BAL-400 D4c ("BillingLine is the ONLY billing copy in the flow") is AMENDED by the owner
 * (Oct 2026): a Case booking now says it twice, under the length control (the length doesn't
 * set the price) and in BillingLine on Confirm (the commitment). Update D4c where it's
 * recorded. The new strings (length question, length notes, sooner offer, empty day) need MJ's
 * copy sign-off.
 *
 * FOR THE TICKET
 *  Analytics: AVAILABILITY_EVENTS.DURATION_FILTER_USED → DURATION_CHOSEN
 *    { expert_id, duration_minutes, previous_minutes, source: 'pill' | 'sooner_offer' };
 *    new SOONER_OFFER_SHOWN { expert_id, chosen_minutes, offered_minutes: number[] }, once per
 *    day × length; SLOT_SELECTED gains `duration_is_default`.
 *  Notifications: none.
 *  Help doc: the client booking how-to's duration step changes, and can now say plainly that
 *    the length you pick doesn't set the price (clients, short).
 *  Tests: ExpertAvailabilityCalendar.test.tsx and booking-flow-dialog.test.tsx query the
 *    "How long do you need?" radios, the "Any" pill and the filter auto-reset; all three go.
 *
 * Colours below are prototype approximations of globals.css tokens, light and dark (the Theme
 * switch in the demo bar is review-only). The real component keeps its Tailwind token classes
 * (bg-primary, text-muted-foreground, border-border, …) and inherits the theme.
 */

// ── Product constants (mirror @balo/shared/availability) ────────────────────────────────────
const LADDER = [15, 30, 45, 60]; // SLOT_DURATION_LADDER
const STEP_MIN = 15; // SLOT_STEP_MINUTES
const WINDOW_DAYS = 14; // DEFAULT_AVAILABILITY_WINDOW_DAYS
const DEFAULT_LENGTH = 60;

// ── Mock availability (deterministic, so review sessions are repeatable) ────────────────────
const DEMO_LEAD_MIN = 120;
const WORK_START = 9 * 60;
const WORK_END = 17 * 60;

// Busy blocks as [startMin, endMin) from local midnight. Weekdays cycle through a scenario's
// patterns in order, starting today.
const SCENARIOS = {
  fragmented: [
    // M: a stepped morning. At 60 min the first time is 1:00 PM and THREE shorter options
    //    start earlier: 9:00 AM for 15, 9:30 AM for 30, 10:15 AM for 45.
    [
      [555, 570],
      [600, 615],
      [660, 780],
    ],
    // A: scattered morning, open afternoon. At 60 min the first time is 1:30 PM and ONE
    //    shorter option starts earlier: 9:00 AM for 45 (30 and 15 at 9:00 are dominated).
    [
      [585, 600],
      [630, 660],
      [690, 720],
      [750, 810],
    ],
    // B: clean hour blocks. 60 min fits at 10:00, 12:00, 2:00 and 4:00; no sooner offer.
    [
      [540, 600],
      [660, 720],
      [780, 840],
      [900, 960],
    ],
    // C: nothing reaches 60. At 60 min the day gets a ring; selecting it shows the empty-day
    //    state with TWO shorter options: 9:00 AM for 30, 12:00 PM for 45.
    [
      [570, 585],
      [615, 630],
      [660, 675],
      [705, 720],
      [765, 780],
      [810, 825],
      [870, 885],
      [930, 945],
      [975, 990],
    ],
  ],
  open: [[[750, 780]]],
};

const pad = (n) => String(n).padStart(2, '0');
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const monthsBetween = (a, b) =>
  (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
const fits = (slot, length) => slot.maxDuration >= length;
const ladderFloor = (minutes) => LADDER.filter((d) => d <= minutes).pop() ?? 0;

const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtRange = (ms, minutes) => `${fmtTime(ms)} – ${fmtTime(ms + minutes * 60_000)}`;
const fmtDay = (key) =>
  parseKey(key).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtWeekday = (key) => parseKey(key).toLocaleDateString('en-AU', { weekday: 'long' });

function freeMinutesFrom(t, busy) {
  if (busy.some(([s, e]) => t >= s && t < e)) return 0;
  const nextBusy = busy.filter(([s]) => s > t).reduce((m, [s]) => Math.min(m, s), WORK_END);
  return nextBusy - t;
}

/** Map<dayKey, { startMs, maxDuration }[]>, ascending. Mirrors AvailabilitySlotDto. */
function buildSlots(scenario, now = new Date()) {
  const patterns = SCENARIOS[scenario];
  const byDay = new Map();
  let weekday = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const busy = patterns[weekday % patterns.length];
    weekday++;
    const slots = [];
    for (let t = WORK_START; t < WORK_END; t += STEP_MIN) {
      const maxDuration = ladderFloor(freeMinutesFrom(t, busy));
      if (!maxDuration) continue;
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, t);
      // Minimum notice + lead guard: the server must never send a start before this.
      if (start.getTime() < now.getTime() + DEMO_LEAD_MIN * 60_000) continue;
      slots.push({ startMs: start.getTime(), maxDuration });
    }
    if (slots.length) byDay.set(dayKeyOf(day), slots);
  }
  return byDay;
}

/**
 * The trade-off frontier for one day: for each length shorter than `length` (longest first),
 * its earliest start, kept only if it begins before every longer option kept so far
 * (including the first time at `length` itself). Returns earliest first, at most three.
 * By construction each kept start's maxDuration equals its offered length.
 */
function soonerOffers(daySlots, length) {
  const firstAtLength = daySlots.find((s) => fits(s, length));
  let cutoff = firstAtLength ? firstAtLength.startMs : Infinity;
  const offers = [];
  for (const minutes of LADDER.filter((d) => d < length).reverse()) {
    const first = daySlots.find((s) => fits(s, minutes));
    if (first && first.startMs < cutoff) {
      offers.push({ startMs: first.startMs, minutes });
      cutoff = first.startMs;
    }
  }
  return offers.reverse();
}

function timezoneLabel() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const city = tz.split('/').pop().replace(/_/g, ' ');
  let offset = '';
  try {
    offset =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    offset = '';
  }
  return `Times in ${city}${offset ? ` (${offset})` : ''}`;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LENGTH PICKER — the one question, as a segmented control. A radiogroup, not toggle buttons:
// it is a single required choice now, not a filter. Sits on ONE row with its label. Targets
// are 44px on touch (pointer: coarse), as the shipped pills require, and compact with a mouse.
//
// The selected fill is a single indicator that slides to the chosen segment. This prototype
// measures the segment and transitions transform + width; the real component gets the same
// result from Motion's `layoutId` (see header).
// ═════════════════════════════════════════════════════════════════════════════════════════════
function LengthPicker({ value, onChange, isAvailable }) {
  const trackRef = useRef(null);
  const refs = useRef([]);
  const [indicator, setIndicator] = useState(null); // { x, width }
  const [placed, setPlaced] = useState(false);
  const enabled = LADDER.filter(isAvailable);

  // Measure the chosen segment; re-measure when the track resizes (segments flex on mobile).
  useLayoutEffect(() => {
    const measure = () => {
      const button = refs.current[LADDER.indexOf(value)];
      if (button) setIndicator({ x: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !trackRef.current) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [value]);

  // Turn the transition on only after the first placement, so the indicator never slides in
  // from the left edge on mount (or when the picker remounts after "Change").
  useEffect(() => {
    if (!indicator || placed) return undefined;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [indicator, placed]);

  function handleKeyDown(event, current) {
    const i = enabled.indexOf(current);
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = enabled[(i + 1) % enabled.length];
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = enabled[(i - 1 + enabled.length) % enabled.length];
    }
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    refs.current[LADDER.indexOf(next)]?.focus();
  }

  return (
    <div className="length">
      <span id="length-label" className="length-label">
        How long do you need?
      </span>
      <div
        ref={trackRef}
        className={`length-options${placed ? ' is-placed' : ''}`}
        role="radiogroup"
        aria-labelledby="length-label"
      >
        {indicator && (
          <span
            className="length-indicator"
            aria-hidden="true"
            style={{ width: indicator.width, transform: `translateX(${indicator.x}px)` }}
          />
        )}
        {LADDER.map((d, i) => {
          const available = isAvailable(d);
          const checked = value === d;
          return (
            <button
              key={d}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={!available}
              title={available ? undefined : `No ${d}-minute times in the next ${WINDOW_DAYS} days`}
              className={`length-option${checked ? ' is-on' : ''}`}
              onClick={() => onChange(d)}
              onKeyDown={(e) => handleKeyDown(e, d)}
            >
              {d} min
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LENGTH NOTE — lives in booking/billing-line.tsx next to BillingLine; the picker only renders
// whatever the wrapper passes as `lengthNote`.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const MIN_MEETING_MINUTES = 15; // mirrors @balo/shared/meetings

function LengthNote({ billing }) {
  if (billing === 'project') {
    return (
      <p className="length-note-line">
        <Receipt size={14} aria-hidden="true" />
        Project calls are free at any length.
      </p>
    );
  }
  return (
    <p className="length-note-line">
      <Receipt size={14} aria-hidden="true" />
      You pay for the minutes you use, not the length you pick. {MIN_MEETING_MINUTES}-minute
      minimum.
    </p>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MONTH CALENDAR — shipped grid (shadcnspace calendar-03 base), with markers that follow the
// chosen length. Days with no times at all stay disabled, as shipped.
// ═════════════════════════════════════════════════════════════════════════════════════════════
function cellLabel(key, atLength, shorterOnly, length) {
  if (atLength) return `${fmtDay(key)}, ${length}-minute times available`;
  if (shorterOnly) return `${fmtDay(key)}, shorter times only`;
  return `${fmtDay(key)}, no times`;
}

function MonthCalendar({
  todayKey,
  windowEndKey,
  selectedKey,
  daysAtLength,
  daysShorterOnly,
  length,
  onSelect,
}) {
  const today = parseKey(todayKey);
  const lastOffset = monthsBetween(today, parseKey(windowEndKey));
  const [offset, setOffset] = useState(() =>
    selectedKey ? monthsBetween(today, parseKey(selectedKey)) : 0
  );

  // "Go to {next day}" can land in the next month: follow it.
  useEffect(() => {
    if (selectedKey) setOffset(monthsBetween(parseKey(todayKey), parseKey(selectedKey)));
  }, [selectedKey, todayKey]);

  const base = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const firstDow = (base.getDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const cells = [
    ...Array(firstDow).fill(0),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7) cells.push(0);

  return (
    <div>
      <div className="month-nav">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setOffset((o) => o - 1)}
          disabled={offset <= 0}
          aria-label="Previous month"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span className="month-label" aria-live="polite">
          {base.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setOffset((o) => o + 1)}
          disabled={offset >= lastOffset}
          aria-label="Next month"
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="cal">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
          <div key={d} className="dow" aria-hidden="true">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`blank-${i}`} />;
          const key = dayKeyOf(new Date(base.getFullYear(), base.getMonth(), d));
          const atLength = daysAtLength.has(key);
          const shorterOnly = daysShorterOnly.has(key);
          const open = atLength || shorterOnly;
          const isSelected = key === selectedKey;
          const className = [
            'cell',
            open && 'is-open',
            isSelected && 'is-selected',
            key === todayKey && 'is-today',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={key}
              type="button"
              className={className}
              disabled={!open}
              aria-pressed={isSelected}
              aria-label={cellLabel(key, atLength, shorterOnly, length)}
              onClick={() => onSelect(key)}
            >
              {d}
              {atLength && !isSelected && <i className="dot" aria-hidden="true" />}
              {shorterOnly && !isSelected && <i className="ring" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <div className="legend">
        <span>
          <i className="dot" aria-hidden="true" />
          {length}-minute times
        </span>
        {daysShorterOnly.size > 0 && (
          <span>
            <i className="ring" aria-hidden="true" />
            Shorter times only
          </span>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// DAY PANEL — replaces the slot list + confirm step of AvailabilitySlotsPanel.
// ═════════════════════════════════════════════════════════════════════════════════════════════
function DayPanel({
  dayKey,
  isToday,
  length,
  matching,
  offers,
  nextDayKey,
  selected,
  onSelectSlot,
  onTakeOffer,
  onGoToDay,
  onContinue,
}) {
  // Shipped behaviour kept: focus lands on the day heading when a day is picked.
  const headingRef = useRef(null);
  useEffect(() => {
    if (dayKey) headingRef.current?.focus();
  }, [dayKey]);

  if (!dayKey) {
    return (
      <div className="select-date">
        <p className="select-date-title">Select a date</p>
        <p>Days with a dot have {length}-minute times.</p>
      </div>
    );
  }

  const hasTimes = matching.length > 0;

  return (
    <div>
      <div className="day-head" ref={headingRef} tabIndex={-1}>
        <h3 className="day-title">{fmtDay(dayKey)}</h3>
        {isToday && <span className="badge">Today</span>}
      </div>

      {hasTimes ? (
        <p className="count">
          {matching.length} {matching.length === 1 ? 'time' : 'times'} available
        </p>
      ) : (
        <p className="empty-title">
          No {length}-minute times on {fmtWeekday(dayKey)}.
        </p>
      )}

      {offers.length > 0 && (
        <div className="sooner">
          <p>
            {hasTimes
              ? 'Need it sooner? Try a shorter call:'
              : `${offers.length === 1 ? 'A shorter call' : 'Shorter calls'} on ${fmtWeekday(dayKey)}:`}
          </p>
          <ul className="offers">
            {offers.map((offer) => (
              <li key={offer.minutes}>
                <button
                  type="button"
                  className="offer"
                  onClick={() => onTakeOffer(offer)}
                  aria-label={`Switch to ${offer.minutes} minutes at ${fmtTime(offer.startMs)}`}
                >
                  <span className="offer-time">{fmtTime(offer.startMs)}</span>
                  <span className="offer-len">{offer.minutes} min</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasTimes && (
        <ul className="slots">
          {matching.map((slot) => {
            const isOn = selected?.startMs === slot.startMs;
            return (
              <li key={slot.startMs}>
                <button
                  type="button"
                  className={`slot${isOn ? ' is-on' : ''}`}
                  aria-pressed={isOn}
                  onClick={() => onSelectSlot(slot.startMs)}
                >
                  {fmtRange(slot.startMs, length)}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!hasTimes && nextDayKey && (
        <button type="button" className="btn-outline" onClick={() => onGoToDay(nextDayKey)}>
          Go to {fmtDay(nextDayKey)}
        </button>
      )}

      {selected && (
        // Sticky bottom bar on mobile, so it is reachable from anywhere in a long list.
        <div className="cta-bar">
          <button type="button" className="cta" onClick={onContinue}>
            Continue with {fmtRange(selected.startMs, length)} →
          </button>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PICKER — ExpertAvailabilityCalendar, v2 behaviour.
//
// Props (changes only):
//   defaultDurationMinutes?  NEW. SlotDurationMinutes, default 60.
//   lengthNote?              NEW. ReactNode under the control; hidden while pinned.
//   initialSelection?        NEW. { start, end, duration } to restore after StepConfirm's
//                            "Change". (The demo also carries dayKey; derive it from `start`
//                            with `slotDayKey` in the real component.)
//   fixedDurationMinutes?    unchanged contract, simpler path (see header).
//   onSlotSelect             now fires straight from "Continue with …".
// ═════════════════════════════════════════════════════════════════════════════════════════════
function ExpertAvailabilityCalendarV2({
  slotsByDay,
  fixedDurationMinutes,
  defaultDurationMinutes = DEFAULT_LENGTH,
  initialSelection,
  lengthNote,
  onSlotSelect,
}) {
  const pinned = fixedDurationMinutes !== undefined;
  const now = useMemo(() => new Date(), []);
  const todayKey = dayKeyOf(now);
  const windowEndKey = dayKeyOf(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + WINDOW_DAYS - 1)
  );
  const tzLabel = useMemo(timezoneLabel, []);
  const dayKeys = useMemo(() => [...slotsByDay.keys()].sort(), [slotsByDay]);
  const allSlots = useMemo(() => [...slotsByDay.values()].flat(), [slotsByDay]);
  const isLengthAvailable = (d) => allSlots.some((s) => fits(s, d));

  const [length, setLength] = useState(() => {
    if (pinned) return fixedDurationMinutes;
    if (initialSelection) return initialSelection.duration;
    // Lengths that fit form a prefix of the ladder, so fall back DOWN, never up.
    return (
      LADDER.filter((d) => d <= defaultDurationMinutes && allSlots.some((s) => fits(s, d))).pop() ??
      defaultDurationMinutes
    );
  });
  const [dayKey, setDayKey] = useState(initialSelection?.dayKey ?? null);
  const [slotStart, setSlotStart] = useState(initialSelection?.startMs ?? null);

  const { daysAtLength, daysShorterOnly } = useMemo(() => {
    const at = new Set();
    const shorter = new Set();
    for (const [key, slots] of slotsByDay) {
      if (slots.some((s) => fits(s, length))) at.add(key);
      else if (!pinned) shorter.add(key);
    }
    return { daysAtLength: at, daysShorterOnly: shorter };
  }, [slotsByDay, length, pinned]);

  const daySlots = dayKey ? (slotsByDay.get(dayKey) ?? []) : [];
  const matching = daySlots.filter((s) => fits(s, length));
  // Earlier, shorter options the chosen length hides (none while pinned).
  const offers = pinned ? [] : soonerOffers(daySlots, length);
  const nextDayKey = dayKey
    ? (dayKeys.find((k) => k > dayKey && daysAtLength.has(k)) ?? null)
    : null;
  const selected = matching.find((s) => s.startMs === slotStart) ?? null;

  function chooseLength(next /* , source: 'pill' | 'sooner_offer' */) {
    if (next === length) return;
    // Keep the chosen time if it can hold the new length; otherwise clear it.
    const current = daySlots.find((s) => s.startMs === slotStart);
    if (!current || !fits(current, next)) setSlotStart(null);
    setLength(next);
    // track(AVAILABILITY_EVENTS.DURATION_CHOSEN, { expert_id, duration_minutes: next,
    //   previous_minutes: length, source });
  }

  function selectDay(key) {
    setDayKey(key);
    setSlotStart(null);
  }

  function takeOffer(offer) {
    chooseLength(offer.minutes, 'sooner_offer');
    setSlotStart(offer.startMs);
  }

  function handleContinue() {
    if (!selected) return;
    // track(AVAILABILITY_EVENTS.SLOT_SELECTED, { …, duration_minutes: length,
    //   duration_is_default: length === defaultDurationMinutes });
    onSlotSelect({
      dayKey,
      startMs: selected.startMs,
      endMs: selected.startMs + length * 60_000,
      duration: length,
    });
  }

  return (
    <div className="picker">
      <div className="toprow">
        {pinned ? (
          <div className="length">
            <span className="length-label">Length</span>
            <span className="pinned-line">
              {length} minutes — same as your current consultation
            </span>
          </div>
        ) : (
          <LengthPicker
            value={length}
            onChange={(d) => chooseLength(d, 'pill')}
            isAvailable={isLengthAvailable}
          />
        )}
        {!pinned && lengthNote && <div className="length-note">{lengthNote}</div>}
        <p className="tz">
          <Globe size={14} aria-hidden="true" />
          {tzLabel}
        </p>
      </div>

      <div className="grid">
        <div className="panel">
          <MonthCalendar
            todayKey={todayKey}
            windowEndKey={windowEndKey}
            selectedKey={dayKey}
            daysAtLength={daysAtLength}
            daysShorterOnly={daysShorterOnly}
            length={length}
            onSelect={selectDay}
          />
        </div>
        <div className="panel">
          <DayPanel
            dayKey={dayKey}
            isToday={dayKey === todayKey}
            length={length}
            matching={matching}
            offers={offers}
            nextDayKey={nextDayKey}
            selected={selected}
            onSelectSlot={setSlotStart}
            onTakeOffer={takeOffer}
            onGoToDay={selectDay}
            onContinue={handleContinue}
          />
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WRAPPER MOCK — only the parts of the booking modal this change touches.
// ═════════════════════════════════════════════════════════════════════════════════════════════
function ModalHeader({ step }) {
  return (
    <>
      <div className="modal-head">
        <div className="avatar" aria-hidden="true">
          AO
        </div>
        <h2 id="expert-name" className="expert-name">
          Amara Okafor
        </h2>
        <button type="button" className="icon-btn close" aria-label="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <nav className="stepper" aria-label="Booking steps">
        <span aria-current={step === 'pick' ? 'step' : undefined}>Choose a time</span>
        <i aria-hidden="true" />
        <span aria-current={step === 'confirm' ? 'step' : undefined}>Confirm</span>
      </nav>
    </>
  );
}

/** StepConfirm's summary card: range + length, "Change" restores the picker's selection. */
function ConfirmMock({ selection, flow, onChange }) {
  const pinned = flow === 'reschedule';
  return (
    <div className="confirm">
      <div className="summary">
        <div>
          <p className="summary-when">
            {fmtDay(selection.dayKey)}, {fmtRange(selection.startMs, selection.duration)}
          </p>
          <p className="summary-len">
            {flow === 'reschedule' &&
              `${selection.duration} minutes — same as your current consultation`}
            {flow === 'project' && `Project call · ${selection.duration} min`}
            {flow === 'book' && `${selection.duration}-minute consultation`}
          </p>
        </div>
        <button type="button" className="link" onClick={onChange}>
          Change
        </button>
      </div>
      <div className="unchanged">
        {pinned && "The reschedule dialog's own confirm continues here, unchanged."}
        {flow === 'project' &&
          "The project call's confirm continues here (step-confirm-intro-call.tsx today)."}
        {flow === 'book' &&
          'Case details, guests, the billing line and Confirm & book continue here, unchanged (step-confirm.tsx).'}
      </div>
    </div>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="seg-wrap">
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AvailabilityCalendarV2Reference() {
  const [scenario, setScenario] = useState('fragmented');
  const [flow, setFlow] = useState('book');
  const [step, setStep] = useState('pick');
  const [selection, setSelection] = useState(null);
  const [theme, setTheme] = useState('light');
  const [viewport, setViewport] = useState('mobile');
  const slotsByDay = useMemo(() => buildSlots(scenario), [scenario]);
  const pinned = flow === 'reschedule';

  function resetDemo(apply) {
    apply();
    setSelection(null);
    setStep('pick');
  }

  return (
    <div className="ref-root" data-theme={theme}>
      <style>{CSS}</style>

      <div className="demo-bar">
        <Segmented
          label="Flow"
          value={flow}
          onChange={(v) => resetDemo(() => setFlow(v))}
          options={[
            ['book', 'Case booking'],
            ['project', 'Project call (free)'],
            ['reschedule', 'Reschedule (pinned 60 min)'],
          ]}
        />
        <Segmented
          label="Expert's calendar"
          value={scenario}
          onChange={(v) => resetDemo(() => setScenario(v))}
          options={[
            ['fragmented', 'Fragmented'],
            ['open', 'Wide open'],
          ]}
        />
        <Segmented
          label="Viewport"
          value={viewport}
          onChange={setViewport}
          options={[
            ['mobile', 'Mobile'],
            ['desktop', 'Desktop'],
          ]}
        />
        <Segmented
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]}
        />
        <p className="demo-note">
          Fragmented calendar (opens at 60 min): Tuesday-type days offer three shorter calls, rings
          mark days with only shorter times, and the ringed days offer two.
        </p>
      </div>

      <div className={viewport === 'mobile' ? 'device' : undefined}>
        <div
          className={[
            'modal',
            viewport === 'mobile' && 'is-sheet',
            viewport === 'desktop' && flow === 'reschedule' && 'is-wide',
          ]
            .filter(Boolean)
            .join(' ')}
          role="dialog"
          aria-labelledby="expert-name"
        >
          <ModalHeader step={step} />
          {step === 'pick' ? (
            <ExpertAvailabilityCalendarV2
              key={`${scenario}-${flow}`}
              slotsByDay={slotsByDay}
              fixedDurationMinutes={pinned ? 60 : undefined}
              initialSelection={selection}
              lengthNote={
                flow === 'book' || flow === 'project' ? (
                  <LengthNote billing={flow === 'project' ? 'project' : 'per_minute'} />
                ) : null
              }
              onSlotSelect={(next) => {
                setSelection(next);
                setStep('confirm');
              }}
            />
          ) : (
            <ConfirmMock selection={selection} flow={flow} onChange={() => setStep('pick')} />
          )}
        </div>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap');

.ref-root {
  --background: #eceef3;
  --card: #ffffff;
  --foreground: #101828;
  --muted: #f4f5f8;
  --muted-foreground: #667085;
  --faint: #c3c8d1;
  --border: #e3e6ec;
  --border-strong: #cfd4dc;
  --primary: #2563eb;
  --primary-strong: #1d4ed8;
  --primary-foreground: #ffffff;
  --primary-soft: #eef3fe;
  --primary-line: #bcd0fb;
  --notice: #f6f8fc;
  min-height: 100vh;
  padding: 24px 16px 48px;
  background: var(--background);
  color: var(--foreground);
  font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.ref-root { color-scheme: light; }
/* Demo-only switch. The real component inherits light/dark from globals.css tokens. */
.ref-root[data-theme='dark'] {
  color-scheme: dark;
  --background: #0d1117;
  --card: #161b24;
  --foreground: #e6e9ef;
  --muted: #1d2430;
  --muted-foreground: #98a2b3;
  --faint: #4a5263;
  --border: #262e3b;
  --border-strong: #354052;
  --primary: #4f86f7;
  --primary-strong: #6f9cf9;
  --primary-foreground: #ffffff;
  --primary-soft: #18243d;
  --primary-line: #2c4677;
  --notice: #1a2130;
}
.ref-root *, .ref-root *::before, .ref-root *::after { box-sizing: border-box; }
:where(.ref-root) button { font: inherit; color: inherit; }
.ref-root :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

/* Demo controls (not part of the design) */
.demo-bar { max-width: 880px; margin: 0 auto 16px; display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: center; font-size: 13px; color: var(--muted-foreground); }
.seg-wrap { display: inline-flex; align-items: center; gap: 8px; }
.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); }
.seg button { border: 0; background: transparent; padding: 6px 12px; border-radius: 7px; cursor: pointer; font-size: 13px; color: var(--muted-foreground); }
.seg button[aria-pressed='true'] { background: var(--primary-soft); color: var(--primary-strong); font-weight: 600; }
.demo-note { flex-basis: 100%; margin: 0; }

/* Modal chrome (as shipped) */
.modal { max-width: 640px; margin: 0 auto; background: var(--card); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 12px 40px rgba(16, 24, 40, 0.12); overflow: hidden; }
.modal.is-wide { max-width: 840px; }
.modal-head { display: flex; align-items: center; gap: 14px; padding: 22px 28px 0; }
.avatar { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); font-weight: 600; font-size: 15px; }
.expert-name { margin: 0; font-size: 17px; font-weight: 600; }
.close { margin-left: auto; }
.stepper { display: flex; align-items: center; gap: 10px; padding: 14px 28px 18px; border-bottom: 1px solid var(--border); font-size: 14px; }
.stepper span { color: var(--muted-foreground); }
.stepper span[aria-current='step'] { color: var(--primary); font-weight: 600; }
.stepper i { width: 20px; height: 1px; background: var(--border-strong); }

/* Picker */
.picker { padding: 22px 28px 28px; }
/* Top block: label + control on one row, then the length note, then the timezone line. */
.toprow { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 14px; }
.length { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 4px; }
.length-label { font-size: 14px; font-weight: 600; }
.length-note-line { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 13px; line-height: 1.4; color: var(--muted-foreground); }
.length-note-line svg { flex: none; margin-top: 2px; }
.length-options { display: flex; flex-wrap: wrap; }
.length-option { border: 0; background: transparent; font-size: 14px; font-variant-numeric: tabular-nums; cursor: pointer; }
.length-option:disabled { color: var(--faint); cursor: not-allowed; }
.pinned-line { font-size: 14px; color: var(--muted-foreground); }

/* Segmented control with a sliding indicator */
.length-options { position: relative; flex-wrap: nowrap; gap: 2px; padding: 3px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--muted); }
.length-indicator { position: absolute; top: 3px; bottom: 3px; left: 0; z-index: 0; border-radius: 7px; background: var(--primary); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.18); pointer-events: none; }
.length-option { position: relative; z-index: 1; min-height: 34px; padding: 0 14px; border-radius: 7px; color: var(--muted-foreground); font-weight: 500; }
.length-option:hover:not(:disabled):not(.is-on) { color: var(--foreground); }
.length-option.is-on { color: var(--primary-foreground); font-weight: 600; }
.is-placed .length-indicator { transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1), width 260ms cubic-bezier(0.22, 1, 0.36, 1); }
.is-placed .length-option { transition: color 260ms cubic-bezier(0.22, 1, 0.36, 1); }
@media (prefers-reduced-motion: reduce) {
  .is-placed .length-indicator, .is-placed .length-option { transition: none; }
}

/* Touch: 44px targets */
@media (pointer: coarse) { .length-option { min-height: 44px; } }
.tz { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; color: var(--muted-foreground); }

.grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.grid > .panel + .panel { border-left: 1px solid var(--border); }
.panel { min-width: 0; padding: 22px; background: var(--card); }

/* Month calendar */
.month-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.month-label { font-size: 15px; font-weight: 600; }
.icon-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: var(--muted); }
.icon-btn:disabled { opacity: 0.3; cursor: default; }
.cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.dow { padding-bottom: 6px; text-align: center; font-size: 12px; color: var(--muted-foreground); }
.cell { position: relative; height: 44px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; background: transparent; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--faint); cursor: default; }
.cell.is-open { color: var(--foreground); font-weight: 500; cursor: pointer; }
.cell.is-open:hover:not(.is-selected) { background: var(--primary-soft); }
.cell.is-today:not(.is-selected) { color: var(--primary); font-weight: 600; }
.cell.is-selected { background: var(--primary); color: var(--primary-foreground); font-weight: 600; }
.dot, .ring { display: inline-block; flex: none; width: 6px; height: 6px; border-radius: 50%; }
.dot { background: var(--primary); }
.ring { border: 1.5px solid var(--muted-foreground); }
.cell .dot, .cell .ring { position: absolute; left: 50%; bottom: 5px; transform: translateX(-50%); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted-foreground); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }

/* Day panel */
.select-date { min-height: 260px; display: grid; place-content: center; gap: 4px; text-align: center; font-size: 13px; color: var(--muted-foreground); }
.select-date p { margin: 0; }
.select-date-title { font-size: 14px; font-weight: 500; color: var(--foreground); }
.day-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; outline: none; }
.day-title { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.badge { padding: 2px 8px; border: 1px solid var(--primary-line); border-radius: 6px; background: var(--primary-soft); color: var(--primary); font-size: 12px; font-weight: 600; }
.count { margin: 4px 0 14px; font-size: 13px; color: var(--muted-foreground); }
.empty-title { margin: 6px 0 14px; font-size: 14px; font-weight: 500; }
.sooner { margin: 0 0 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--notice); font-size: 13px; line-height: 1.45; }
.sooner p { margin: 0 0 8px; }
/* Offers read left to right as the trade-off: earlier and shorter → later and longer. */
.offers { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 6px; }
.offer { width: 100%; min-height: 44px; padding: 6px 8px; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; border: 1px solid var(--primary-line); border-radius: 8px; background: var(--card); text-align: left; font-variant-numeric: tabular-nums; cursor: pointer; }
.offer:hover { border-color: var(--primary); background: var(--primary-soft); }
.offer-time { font-size: 13px; font-weight: 600; color: var(--foreground); white-space: nowrap; }
.offer-len { font-size: 12px; font-weight: 500; color: var(--primary); }
.link { padding: 0; border: 0; background: none; color: var(--primary); font-size: 13px; font-weight: 600; cursor: pointer; }
.link:hover { text-decoration: underline; }
.slots { list-style: none; margin: 0; padding: 0 2px 0 0; display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow-y: auto; }
.slot { width: 100%; min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--card); text-align: left; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; cursor: pointer; }
.slot:hover:not(.is-on) { border-color: var(--primary); background: var(--primary-soft); }
.slot.is-on { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
.btn-outline { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--card); font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-outline:hover { border-color: var(--primary); color: var(--primary); }
.cta-bar { margin-top: 14px; }
.cta { width: 100%; min-height: 44px; border: 0; border-radius: 10px; background: var(--primary); color: var(--primary-foreground); font-size: 14px; font-weight: 600; cursor: pointer; }
.cta:hover { background: var(--primary-strong); }

/* Confirm (wrapper) */
.confirm { display: grid; gap: 16px; padding: 22px 28px 28px; }
.summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--muted); }
.summary-when { margin: 0; font-size: 14px; font-weight: 600; }
.summary-len { margin: 2px 0 0; font-size: 12px; color: var(--muted-foreground); }
.unchanged { padding: 28px 16px; border: 1px dashed var(--border-strong); border-radius: 12px; text-align: center; font-size: 13px; color: var(--muted-foreground); }

/* Phone frame (demo only): the sheet scrolls inside it */
.device { width: 375px; height: 780px; margin: 0 auto; border: 10px solid #1c212b; border-radius: 44px; overflow: hidden; background: var(--card); box-shadow: 0 20px 50px rgba(16, 24, 40, 0.25); }
.modal.is-sheet { max-width: none; height: 100%; overflow-y: auto; border: 0; border-radius: 0; box-shadow: none; }

/* Below md: full-screen sheet layout (the demo's Mobile switch stands in for md:). */
.is-sheet .modal-head { padding: 18px 16px 0; }
.is-sheet .stepper, .is-sheet .picker, .is-sheet .confirm { padding-left: 16px; padding-right: 16px; }
.is-sheet .picker { padding-top: 18px; padding-bottom: 0; }
.is-sheet .toprow { align-items: stretch; }
.is-sheet .length-label { flex-basis: 100%; }
.is-sheet .length-options { width: 100%; }
.is-sheet .length-option { flex: 1 1 0; min-width: 0; padding: 4px 4px; line-height: 1.15; }
.is-sheet .grid { grid-template-columns: 1fr; overflow: visible; border: 0; border-radius: 0; }
.is-sheet .grid > .panel + .panel { border-left: 0; border-top: 1px solid var(--border); padding-top: 18px; }
.is-sheet .panel { padding: 0 0 18px; }
.is-sheet .slots { max-height: none; overflow: visible; }
.is-sheet .cta-bar { position: sticky; bottom: 0; margin: 12px -16px 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); background: var(--card); border-top: 1px solid var(--border); box-shadow: 0 -6px 16px rgba(16, 24, 40, 0.06); }
.is-sheet .summary { align-items: flex-start; }
.is-sheet .select-date { min-height: 0; place-content: start; text-align: left; padding-bottom: 8px; }
`;
