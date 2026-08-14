import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn, mockError, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: mockError }),
}));

import { DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings';
import { resolveMeetingTimers } from './meeting-timers.js';

const VARIABLES = [
  'MEETING_EXPERT_ABSENT_ALERT_MINUTES',
  'MEETING_MISSED_CALL_MINUTES',
  'MEETING_CLIENT_ABSENT_NUDGE_MINUTES',
  'MEETING_NO_SHOW_FLOOR_MINUTES',
  'MEETING_IDLE_END_MINUTES',
] as const;

const MINUTE = 60_000;

function clearAll(): void {
  for (const variable of VARIABLES) {
    delete process.env[variable];
  }
}

describe('resolveMeetingTimers (BAL-134 D8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAll();
  });

  afterEach(clearAll);

  it('ABSENT — every timer falls back to its shipped default, silently', () => {
    expect(resolveMeetingTimers()).toEqual(DEFAULT_MEETING_TIMERS);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  /** One row per variable — each override must reach its OWN field and no other. */
  const WIRING: ReadonlyArray<{
    variable: (typeof VARIABLES)[number];
    field: keyof typeof DEFAULT_MEETING_TIMERS;
    minutes: number;
  }> = [
    { variable: 'MEETING_EXPERT_ABSENT_ALERT_MINUTES', field: 'expertAbsentAlertMs', minutes: 3 },
    { variable: 'MEETING_MISSED_CALL_MINUTES', field: 'missedCallTerminationMs', minutes: 12 },
    { variable: 'MEETING_CLIENT_ABSENT_NUDGE_MINUTES', field: 'clientAbsentNudgeMs', minutes: 2 },
    { variable: 'MEETING_NO_SHOW_FLOOR_MINUTES', field: 'noShowFloorMs', minutes: 20 },
    { variable: 'MEETING_IDLE_END_MINUTES', field: 'idleEndEmptyMs', minutes: 7 },
  ];

  it.each(WIRING)(
    'VALID — $variable overrides $field and nothing else',
    ({ variable, field, minutes }) => {
      process.env[variable] = String(minutes);

      const timers = resolveMeetingTimers();

      expect(timers[field]).toBe(minutes * MINUTE);
      for (const other of Object.keys(DEFAULT_MEETING_TIMERS) as Array<keyof typeof timers>) {
        if (other !== field) {
          expect(timers[other]).toBe(DEFAULT_MEETING_TIMERS[other]);
        }
      }
      expect(mockInfo).toHaveBeenCalledWith(
        { applied: { [variable]: minutes } },
        'Meeting timer overrides applied'
      );
    }
  );

  it('accepts a fractional number of minutes', () => {
    process.env.MEETING_IDLE_END_MINUTES = '0.5';
    expect(resolveMeetingTimers().idleEndEmptyMs).toBe(30_000);
  });

  /** ⚠ `parseInt('5x')` would be `5`. `Number('5x')` is `NaN`, and a typo must not be honoured. */
  const MALFORMED = ['abc', '5x', '-3', '0', 'NaN', 'Infinity', ' '];

  it.each(MALFORMED)('MALFORMED (%s) — default + one warn naming the variable', (raw) => {
    process.env.MEETING_IDLE_END_MINUTES = raw;

    const timers = resolveMeetingTimers();

    expect(timers).toEqual(DEFAULT_MEETING_TIMERS);
    // A blank string is treated as ABSENT, so it warns about nothing; everything else warns.
    if (raw.trim().length > 0) {
      expect(mockWarn).toHaveBeenCalledWith(
        {
          variable: 'MEETING_IDLE_END_MINUTES',
          defaultMs: DEFAULT_MEETING_TIMERS.idleEndEmptyMs,
        },
        'Meeting timer override is not a positive number of minutes — using the default'
      );
    } else {
      expect(mockWarn).not.toHaveBeenCalled();
    }
  });

  it('⚠ a BLANK value reads as ABSENT, not as zero — `Number("")` is 0 and would disarm a timer', () => {
    process.env.MEETING_NO_SHOW_FLOOR_MINUTES = '';
    expect(resolveMeetingTimers().noShowFloorMs).toBe(DEFAULT_MEETING_TIMERS.noShowFloorMs);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('applies several overrides together', () => {
    process.env.MEETING_EXPERT_ABSENT_ALERT_MINUTES = '2';
    process.env.MEETING_MISSED_CALL_MINUTES = '6';

    expect(resolveMeetingTimers()).toEqual({
      ...DEFAULT_MEETING_TIMERS,
      expertAbsentAlertMs: 2 * MINUTE,
      missedCallTerminationMs: 6 * MINUTE,
    });
  });

  /**
   * ⚠⚠ AN INCOHERENT SET DISCARDS **ALL** OVERRIDES. A partial application could leave a
   * 20-minute alert against a 10-minute missed-call termination — Balo told "nobody turned up"
   * only after already closing the meeting, i.e. a zero-second salvage window.
   */
  it('⚠ INCOHERENT — the alert at/after its own termination discards EVERY override, loudly', () => {
    process.env.MEETING_EXPERT_ABSENT_ALERT_MINUTES = '20';
    process.env.MEETING_IDLE_END_MINUTES = '9';

    expect(resolveMeetingTimers()).toEqual(DEFAULT_MEETING_TIMERS);
    expect(mockError).toHaveBeenCalledWith(
      { applied: { MEETING_EXPERT_ABSENT_ALERT_MINUTES: 20, MEETING_IDLE_END_MINUTES: 9 } },
      expect.stringContaining('INCOHERENT')
    );
  });

  it('⚠ INCOHERENT — a no-show floor at or below the client nudge is refused too', () => {
    process.env.MEETING_NO_SHOW_FLOOR_MINUTES = '5';

    expect(resolveMeetingTimers()).toEqual(DEFAULT_MEETING_TIMERS);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('reads the environment at CALL time, not at import time', () => {
    expect(resolveMeetingTimers().idleEndEmptyMs).toBe(DEFAULT_MEETING_TIMERS.idleEndEmptyMs);
    process.env.MEETING_IDLE_END_MINUTES = '9';
    expect(resolveMeetingTimers().idleEndEmptyMs).toBe(9 * MINUTE);
  });
});
