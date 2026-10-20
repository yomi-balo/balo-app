import { describe, expect, it, vi } from 'vitest';
import {
  BOOKING_PHASES,
  BOOKING_PHASE_TIMING_MESSAGE,
  createBookingPhaseTimer,
  timeBookingPhase,
} from './booking-phase-timing.js';

/** A clock that returns each queued value once, then holds the last. */
function steppingClock(...ticks: number[]): () => number {
  let index = 0;
  return () => {
    const tick = ticks[Math.min(index, ticks.length - 1)] ?? 0;
    index += 1;
    return tick;
  };
}

describe('BOOKING_PHASE_TIMING_MESSAGE', () => {
  it('is the exact literal Axiom queries filter on', () => {
    expect(BOOKING_PHASE_TIMING_MESSAGE).toBe('Meeting booking phase timings');
  });
});

describe('createBookingPhaseTimer', () => {
  it('exposes exactly the nine phase keys plus totalMs, all null before anything is recorded', () => {
    const timer = createBookingPhaseTimer(steppingClock(0, 0));

    expect(timer.fields()).toEqual({
      tenancyGateMs: null,
      replayProbeMs: null,
      expertEligibilityMs: null,
      caseFundingMs: null,
      expertGuardsMs: null,
      vendorFreeBusyMs: null,
      bookingTransactionMs: null,
      venueMs: null,
      calendarMs: null,
      totalMs: 0,
    });
    expect(BOOKING_PHASES).toHaveLength(9);
  });

  it('reports a recorded phase under its Ms key and leaves the others null', () => {
    const timer = createBookingPhaseTimer(steppingClock(0, 0));

    timer.record('venue', 120);

    const fields = timer.fields();
    expect(fields.venueMs).toBe(120);
    expect(fields.calendarMs).toBeNull();
  });

  it('overwrites a phase recorded twice', () => {
    const timer = createBookingPhaseTimer(steppingClock(0, 0));

    timer.record('venue', 120);
    timer.record('venue', 7);

    expect(timer.fields().venueMs).toBe(7);
  });

  it('hasRecorded is false until the phase is recorded, even at zero ms', () => {
    const timer = createBookingPhaseTimer(steppingClock(0));

    expect(timer.hasRecorded('bookingTransaction')).toBe(false);
    timer.record('bookingTransaction', 0);
    expect(timer.hasRecorded('bookingTransaction')).toBe(true);
    expect(timer.hasRecorded('venue')).toBe(false);
  });

  it('derives totalMs from the clock at creation and at fields() time', () => {
    const timer = createBookingPhaseTimer(steppingClock(1_000, 1_450));

    expect(timer.fields().totalMs).toBe(450);
  });
});

describe('timeBookingPhase', () => {
  it('records the elapsed ms and returns the result when the phase resolves', async () => {
    const record = vi.fn();

    const result = await timeBookingPhase(
      { record },
      'caseFunding',
      () => Promise.resolve('ok'),
      steppingClock(10, 35)
    );

    expect(result).toBe('ok');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('caseFunding', 25);
  });

  it('rethrows the original error and records nothing when the phase rejects', async () => {
    const record = vi.fn();
    const failure = new Error('boom');

    await expect(
      timeBookingPhase({ record }, 'venue', () => Promise.reject(failure), steppingClock(0, 5))
    ).rejects.toBe(failure);

    expect(record).not.toHaveBeenCalled();
  });

  it('passes through when no recorder is supplied', async () => {
    await expect(timeBookingPhase(undefined, 'venue', () => Promise.resolve(3))).resolves.toBe(3);
  });
});
