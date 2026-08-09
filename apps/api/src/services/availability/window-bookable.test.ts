import { describe, expect, it } from 'vitest';
import { isWindowBookable } from './resolver.js';
import type { BusyBlock, ResolverRule, WindowBookableInput } from './types.js';

/**
 * BAL-129 §2a — `isWindowBookable`, the AGGREGATE availability-DoS bound.
 *
 * ⚠ WHAT THESE TESTS ARE FOR. Before this function existed, `POST /meetings` bounded only the
 * SHAPE of one window (duration, horizon) and would have accepted ~1,095 consecutive 8-hour
 * bookings — a year of any reachable expert's calendar — plus any number of mutually
 * OVERLAPPING ones. Every `false` below is one of those attacks; every `true` is a legitimate
 * booking that must keep working.
 *
 * Every case injects `now` and a timezone explicitly — the function reads no clock and no env.
 */

const NOW = new Date('2026-09-07T00:00:00.000Z');
const START = new Date('2026-09-07T10:00:00.000Z');
const END = new Date('2026-09-07T11:00:00.000Z');

/**
 * The rule's `dayOfWeek` is DERIVED from the window rather than hard-coded, so the suite cannot
 * silently stop testing the intended day if the fixture dates are ever edited.
 */
const WINDOW_DOW = START.getUTCDay();

/** 09:00–17:00 on the window's own weekday, in the expert's timezone. */
const NINE_TO_FIVE: ResolverRule[] = [
  { dayOfWeek: WINDOW_DOW, startTime: '09:00:00', endTime: '17:00:00' },
];

/** A bookable base case: published 9–5, nothing busy, UTC. Individual tests override one key. */
function input(overrides: Partial<WindowBookableInput> = {}): WindowBookableInput {
  return {
    rules: NINE_TO_FIVE,
    baloConsultations: [],
    busyBlocks: [],
    overrideBlocks: [],
    timezone: 'UTC',
    now: NOW,
    start: START,
    end: END,
    ...overrides,
  };
}

/** A busy interval expressed as UTC hour offsets on the window's own date. */
function onWindowDate(startHour: number, endHour: number): BusyBlock {
  const day = START.toISOString().slice(0, 10);
  return {
    startAt: new Date(`${day}T${String(startHour).padStart(2, '0')}:00:00.000Z`),
    endAt: new Date(`${day}T${String(endHour).padStart(2, '0')}:00:00.000Z`),
  };
}

describe('a window inside published availability', () => {
  it('is bookable when nothing is busy', () => {
    expect(isWindowBookable(input())).toBe(true);
  });

  it('is bookable when it exactly EQUALS the published window', () => {
    const day = START.toISOString().slice(0, 10);
    expect(
      isWindowBookable(
        input({
          start: new Date(`${day}T09:00:00.000Z`),
          end: new Date(`${day}T17:00:00.000Z`),
        })
      )
    ).toBe(true);
  });

  it('is bookable across two ADJACENT published rules (they merge)', () => {
    // 09–12 and 12–17 are one continuous window, so an 11:00–13:00 booking spans both.
    const day = START.toISOString().slice(0, 10);
    expect(
      isWindowBookable(
        input({
          rules: [
            { dayOfWeek: WINDOW_DOW, startTime: '09:00:00', endTime: '12:00:00' },
            { dayOfWeek: WINDOW_DOW, startTime: '12:00:00', endTime: '17:00:00' },
          ],
          start: new Date(`${day}T11:00:00.000Z`),
          end: new Date(`${day}T13:00:00.000Z`),
        })
      )
    ).toBe(true);
  });

  it('is bookable FAR beyond the resolver’s 14-day display horizon', () => {
    // ⚠ THE POINT OF THIS CASE. `resolve()`'s `horizonDays` (14 by default) bounds how far the
    // EARLIEST-AVAILABLE scan looks; the BOOKING horizon is `MAX_BOOKING_HORIZON_DAYS = 365`
    // and is enforced by `validateBookingWindow`. Applying the display horizon here would
    // refuse every legitimate booking more than a fortnight out — hence no `horizonDays` on
    // `WindowBookableInput` at all.
    const start = new Date(START.getTime() + 300 * 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    expect(
      isWindowBookable(
        input({
          rules: [{ dayOfWeek: start.getUTCDay(), startTime: '09:00:00', endTime: '17:00:00' }],
          start,
          end,
        })
      )
    ).toBe(true);
  });
});

describe('a window OUTSIDE published availability is refused', () => {
  it('refuses when the expert has published NO weekly rules at all', () => {
    // An expert with no schedule is bookable at no time. Fail-closed: "nothing found" must not
    // read as "no constraints".
    expect(isWindowBookable(input({ rules: [] }))).toBe(false);
  });

  it('refuses a window wholly outside the published hours', () => {
    const day = START.toISOString().slice(0, 10);
    expect(
      isWindowBookable(
        input({
          start: new Date(`${day}T20:00:00.000Z`),
          end: new Date(`${day}T21:00:00.000Z`),
        })
      )
    ).toBe(false);
  });

  it('refuses a window that STRADDLES the end of published hours', () => {
    // Partial coverage is not coverage: 16:30–17:30 against a 09:00–17:00 rule is refused, not
    // trimmed. This is the case a naive "does any free slot overlap?" check would allow.
    const day = START.toISOString().slice(0, 10);
    expect(
      isWindowBookable(
        input({
          start: new Date(`${day}T16:30:00.000Z`),
          end: new Date(`${day}T17:30:00.000Z`),
        })
      )
    ).toBe(false);
  });

  it('refuses a window on a weekday the expert publishes nothing for', () => {
    // Three days off the window's own weekday, so neither the day itself nor the previous day
    // (which `expandRulesInRange` also visits, for midnight-crossing rules) carries a rule.
    const otherDay: ResolverRule[] = [
      { dayOfWeek: (WINDOW_DOW + 3) % 7, startTime: '09:00:00', endTime: '17:00:00' },
    ];
    expect(isWindowBookable(input({ rules: otherDay }))).toBe(false);
  });
});

describe('busy intervals — this is what makes each booking CONSUME a slot', () => {
  it('refuses a window overlapping an existing confirmed consultation', () => {
    // ⚠ THE ANTI-OVERLAP PROPERTY. Every successful booking writes a `confirmed` consultation,
    // which the very next call reads here as busy — so N bookings cannot occupy the same hour,
    // and the ceiling on consumption is the expert's own published calendar.
    expect(isWindowBookable(input({ baloConsultations: [onWindowDate(10, 12)] }))).toBe(false);
  });

  it('refuses a window overlapping by a single minute at the tail', () => {
    const day = START.toISOString().slice(0, 10);
    expect(
      isWindowBookable(
        input({
          baloConsultations: [
            {
              startAt: new Date(`${day}T10:59:00.000Z`),
              endAt: new Date(`${day}T12:00:00.000Z`),
            },
          ],
        })
      )
    ).toBe(false);
  });

  it('ALLOWS a window exactly adjacent to a consultation when no buffer is configured', () => {
    expect(isWindowBookable(input({ baloConsultations: [onWindowDate(9, 10)] }))).toBe(true);
  });

  it('refuses that same adjacent window once a trailing buffer is configured', () => {
    // The buffers come from `expert_profiles` (BAL-234) and are honoured identically to the way
    // `resolveAndCacheAvailability` honours them, so a booking check and the advertised cache
    // cannot disagree.
    expect(
      isWindowBookable(input({ baloConsultations: [onWindowDate(9, 10)], bufferAfterMinutes: 15 }))
    ).toBe(false);
  });

  it('refuses a window inside a time-off override block', () => {
    expect(isWindowBookable(input({ overrideBlocks: [onWindowDate(0, 23)] }))).toBe(false);
  });

  it('refuses a window inside a vendor free/busy block', () => {
    expect(isWindowBookable(input({ busyBlocks: [onWindowDate(10, 11)] }))).toBe(false);
  });
});

describe('minimum notice', () => {
  it('refuses a window starting inside the expert’s minimum-notice period', () => {
    // 10:00 is 600 minutes after `now`, so a 12-hour notice requirement refuses it.
    expect(isWindowBookable(input({ minimumNoticeMinutes: 720 }))).toBe(false);
  });

  it('allows a window just outside it', () => {
    expect(isWindowBookable(input({ minimumNoticeMinutes: 599 }))).toBe(true);
  });
});

describe('timezone handling', () => {
  it('interprets the published wall-clock hours in the EXPERT’s timezone', () => {
    // 09:00–17:00 Australia/Sydney on 2026-09-07 (AEST, UTC+10) is 23:00Z the previous day to
    // 07:00Z. A 00:00Z–01:00Z window is 10:00–11:00 local: inside. The same window is OUTSIDE
    // a UTC 09:00–17:00 rule, so this case would pass vacuously if the timezone were ignored.
    const start = new Date('2026-09-07T00:00:00.000Z');
    const end = new Date('2026-09-07T01:00:00.000Z');
    const sydney = input({
      timezone: 'Australia/Sydney',
      rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
      now: new Date('2026-09-06T00:00:00.000Z'),
      start,
      end,
    });

    expect(isWindowBookable(sydney)).toBe(true);
    expect(isWindowBookable({ ...sydney, timezone: 'UTC' })).toBe(false);
  });
});

describe('degenerate inputs FAIL CLOSED', () => {
  it.each([
    { label: 'an inverted window', patch: { start: END, end: START } },
    { label: 'a zero-length window', patch: { start: START, end: START } },
    { label: 'a non-finite start', patch: { start: new Date('x') } },
    { label: 'a non-finite end', patch: { end: new Date('x') } },
    { label: 'a non-finite now', patch: { now: new Date('x') } },
  ])('refuses $label', ({ patch }) => {
    // A NaN endpoint has no position on the timeline, so every interval comparison downstream
    // would be NaN-blind and silently PERMISSIVE — the same trap `validateBookingWindow` guards.
    expect(isWindowBookable(input(patch))).toBe(false);
  });
});
