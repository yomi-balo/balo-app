import { describe, it, expect } from 'vitest';
import { END_OF_CALL_EVENTS, END_OF_CALL_SERVER_EVENTS } from './end-of-call';
import type { EndOfCallAction, EndOfCallRatingState, EndOfCallRecapState } from './end-of-call';
import type { EndOfCallReviewState } from '@balo/shared/reviews';

// Both values share the `end_of_call_` prefix, but the guard uses the GENERIC snake_case
// matcher for consistency with `recap.test.ts` — anchored and with no nested quantifier
// (SonarCloud S5852).
const SNAKE_CASE = /^[a-z]+(_[a-z]+)*$/;

describe('END_OF_CALL_EVENTS (client)', () => {
  it('exposes exactly the BAL-389 end-of-call client events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare .sort() is a SonarCloud reliability bug.
    expect(Object.keys(END_OF_CALL_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual(['ACTION']);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(END_OF_CALL_EVENTS.ACTION).toBe('end_of_call_action');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(END_OF_CALL_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

describe('END_OF_CALL_SERVER_EVENTS (server)', () => {
  it('exposes exactly the BAL-389 end-of-call server events', () => {
    expect(Object.keys(END_OF_CALL_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(END_OF_CALL_SERVER_EVENTS.VIEWED).toBe('end_of_call_viewed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(END_OF_CALL_SERVER_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

/**
 * Compile-time exhaustive maps. A member added to any of these unions WITHOUT updating the
 * map fails `tsc` (missing key), and the runtime assertions below fail too — which is what
 * binds the no-producer rule to enum VALUES and not just to event names.
 */
const ACTIONS: Record<EndOfCallAction, true> = {
  view_recap: true,
  back_to_case: true,
  rated: true,
  rating_revised: true,
};
const RECAP_STATES: Record<EndOfCallRecapState, true> = { ready: true, processing: true };
const RATING_STATES: Record<EndOfCallRatingState, true> = {
  none: true,
  rated_ok: true,
  rated_low: true,
};

describe('BAL-389 enum values', () => {
  it('declares only ACTIONS a producer can fire today', () => {
    expect(Object.keys(ACTIONS).sort((a, b) => a.localeCompare(b))).toEqual([
      'back_to_case',
      'rated',
      'rating_revised',
      'view_recap',
    ]);
  });

  it('declares a TWO-way recap readiness, not the recap page SIX-way state', () => {
    // The end-of-call screen renders a two-way toggle. Four of `RecapState`'s six values have
    // no producer here, and a dimension value nothing emits reads as a 100%-drop-off step.
    expect(Object.keys(RECAP_STATES).sort((a, b) => a.localeCompare(b))).toEqual([
      'processing',
      'ready',
    ]);
  });

  it('ALIASES the shipped review-state discriminant rather than restating it', () => {
    // The assignment is the assertion: it only compiles while the two types are identical, so
    // a fourth `EndOfCallReviewState` arm reaches this dimension through `tsc`. The ticket's
    // prose spelling (none / high / low) is deliberately NOT used.
    const fromResolver: EndOfCallReviewState['kind'] = 'rated_low';
    const asRatingState: EndOfCallRatingState = fromResolver;
    expect(asRatingState).toBe('rated_low');
    expect(Object.keys(RATING_STATES).sort((a, b) => a.localeCompare(b))).toEqual([
      'none',
      'rated_low',
      'rated_ok',
    ]);
  });
});

describe('BAL-389 declares no value without a producer', () => {
  const actionValues: readonly string[] = Object.keys(ACTIONS);

  it('does not declare a case_resolved ACTION (it is the server event with a `source`)', () => {
    // Closing a case is ONE business fact with ONE event name,
    // `RECAP_SERVER_EVENTS.CASE_RESOLVED`, carrying `source: 'end_of_call'`. A parallel client
    // action value would make `count(case_resolved)` wrong forever.
    expect(actionValues).not.toContain('case_resolved');
  });

  it('DOES declare back_to_case — the destination is real as of BAL-421', () => {
    // ⚠⚠ THIS PIN WAS INVERTED ON PURPOSE; DO NOT "RESTORE" IT. `back_to_case` was withheld
    // while the onward CTA was unconditionally "View recap", for one reason only: `/cases` did
    // not exist, so the button could not be clicked. BAL-421 shipped that surface and the owner
    // restored the design's two-state CTA, so the value and its producer arrived together —
    // which is the no-producer rule being FOLLOWED, not waived. The producer is
    // `end/_components/onward-cta.tsx`, on the processing arm.
    expect(actionValues).toContain('back_to_case');
  });

  it('does not declare rejoin (no live destination on any arm — BAL-435 owns it)', () => {
    // `/join/m/{id}` is the ANONYMOUS lobby, `joinAsMemberAction` has no entry point by
    // design, and both terminate at MeetingCallSurface's "Connecting…". BAL-435 adds the
    // button, its destination and this value together.
    expect(actionValues).not.toContain('rejoin');
  });

  it('does not declare an event whose surface does not exist', () => {
    const all: readonly string[] = [
      ...Object.values(END_OF_CALL_EVENTS),
      ...Object.values(END_OF_CALL_SERVER_EVENTS),
    ];
    expect(all).not.toContain('end_of_call_rejoined');
    expect(all).not.toContain('end_of_call_case_resolved');
  });
});
