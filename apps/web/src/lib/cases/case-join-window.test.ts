import { describe, it, expect } from 'vitest';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { insideCaseJoinWindow } from './case-join-window';

const SCHEDULED_START = new Date('2026-06-15T10:00:00.000Z');

function minutesBeforeStart(minutes: number): Date {
  return new Date(SCHEDULED_START.getTime() - minutes * 60_000);
}

/** Every boundary is expressed against the imported `CASE_JOIN_WINDOW_MINUTES` constant, never
 *  a literal, so the test can't silently drift from the constant it guards. */
describe('insideCaseJoinWindow', () => {
  it('is false one minute before the window opens', () => {
    expect(
      insideCaseJoinWindow(
        minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES + 1),
        SCHEDULED_START.toISOString()
      )
    ).toBe(false);
  });

  it('is true at exactly CASE_JOIN_WINDOW_MINUTES before the start — the boundary is inclusive', () => {
    expect(
      insideCaseJoinWindow(
        minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES),
        SCHEDULED_START.toISOString()
      )
    ).toBe(true);
  });

  it('is true at the scheduled start', () => {
    expect(insideCaseJoinWindow(SCHEDULED_START, SCHEDULED_START.toISOString())).toBe(true);
  });

  it('stays true well past the start — no closing bound, mirroring the nudge', () => {
    const wellPast = new Date(SCHEDULED_START.getTime() + 6 * 60 * 60_000);
    expect(insideCaseJoinWindow(wellPast, SCHEDULED_START.toISOString())).toBe(true);
  });

  it('is true for a start already in the past — a never-joined overdue meeting reads live', () => {
    const overdueStart = new Date(SCHEDULED_START.getTime() - 60 * 60_000);
    const laterNow = SCHEDULED_START;
    expect(insideCaseJoinWindow(laterNow, overdueStart.toISOString())).toBe(true);
  });
});
