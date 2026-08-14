import { describe, it, expect } from 'vitest';
import { durationMinutesOf } from './meeting-duration';

const START = new Date('2026-08-12T09:00:00.000Z');

function at(minutes: number, seconds = 0): Date {
  return new Date(START.getTime() + minutes * 60_000 + seconds * 1000);
}

describe('durationMinutesOf', () => {
  it('returns whole minutes when BOTH stamps are present', () => {
    expect(durationMinutesOf({ startedAt: START, endedAt: at(45) })).toBe(45);
    expect(durationMinutesOf({ startedAt: START, endedAt: at(1) })).toBe(1);
  });

  it('rounds to the nearest minute', () => {
    // 45m29s rounds down, 45m31s rounds up — half-minute boundary behaviour, pinned.
    expect(durationMinutesOf({ startedAt: START, endedAt: at(45, 29) })).toBe(45);
    expect(durationMinutesOf({ startedAt: START, endedAt: at(45, 31) })).toBe(46);
  });

  it('returns NULL when either stamp is missing — never a bare zero', () => {
    // ⚠ This is the 100%-of-sessions case today: BAL-134 owns the lifecycle stamps and is
    // Backlog, so nothing writes `started_at` / `ended_at` yet.
    expect(durationMinutesOf({ startedAt: null, endedAt: at(45) })).toBeNull();
    expect(durationMinutesOf({ startedAt: START, endedAt: null })).toBeNull();
    expect(durationMinutesOf({ startedAt: null, endedAt: null })).toBeNull();
  });

  it('returns 0 for a sub-30-second call rather than rounding up', () => {
    expect(durationMinutesOf({ startedAt: START, endedAt: at(0, 20) })).toBe(0);
  });

  it('FLOORS a reversed pair at 0 rather than returning a negative duration', () => {
    // A clock skew or an out-of-order stamp must never render "You spoke for -3 min".
    expect(durationMinutesOf({ startedAt: at(10), endedAt: START })).toBe(0);
  });
});
