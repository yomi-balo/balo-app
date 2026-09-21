import { describe, it, expect } from 'vitest';
import { CASE_JOIN_WINDOW_MINUTES, selectCaseNudge } from '@balo/shared/engagements';
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

/**
 * `insideCaseJoinWindow` and the private `withinJoinWindow` (`@balo/shared/engagements`) are two
 * hand-duplicated formulas that MUST agree (see both functions' docblocks). `selectCaseNudge` is
 * the private predicate's ONE public door, so this table drives it straight through and asserts
 * agreement at exactly the offsets where the two could diverge without either module's own tests
 * noticing.
 */
describe('insideCaseJoinWindow agrees with the shared withinJoinWindow at the boundary', () => {
  const BOUNDARY = minutesBeforeStart(CASE_JOIN_WINDOW_MINUTES).getTime();

  const CASES: readonly { readonly label: string; readonly now: Date }[] = [
    { label: '1ms before the window opens', now: new Date(BOUNDARY - 1) },
    {
      label: 'exactly CASE_JOIN_WINDOW_MINUTES before the start — inclusive boundary',
      now: new Date(BOUNDARY),
    },
    { label: '1ms inside the window', now: new Date(BOUNDARY + 1) },
    { label: '1 minute before the start', now: minutesBeforeStart(1) },
    { label: 'at the scheduled start', now: SCHEDULED_START },
    { label: '1 minute past the start', now: new Date(SCHEDULED_START.getTime() + 60_000) },
  ];

  it('covers every boundary case (guards a shrunken table)', () => {
    expect(CASES).toHaveLength(6);
  });

  it.each(CASES)('agrees $label', ({ now }) => {
    const nudge = selectCaseNudge({
      lens: 'client',
      isOpen: true,
      nextScheduled: { meetingId: 'm1', scheduledStart: SCHEDULED_START },
      resolutionRequestedAt: null,
      rescheduleProposal: null,
      now,
    });
    if (nudge === null || nudge.kind !== 'upcoming') {
      throw new Error('expected an upcoming nudge');
    }
    expect(insideCaseJoinWindow(now, SCHEDULED_START.toISOString())).toBe(nudge.live);
  });
});
