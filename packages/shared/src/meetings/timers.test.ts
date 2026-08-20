import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ABSENT_NUDGE_MS,
  DEFAULT_MEETING_TIMERS,
  EXPERT_ABSENT_ALERT_MS,
  IDLE_END_EMPTY_MS,
  MISSED_CALL_TERMINATION_MS,
  NO_SHOW_FLOOR_MS,
  meetingTimersAreCoherent,
  type MeetingTimers,
} from './timers';

const MINUTE = 60_000;

describe('meeting lifecycle timers (BAL-134 D8)', () => {
  it('ships the five documented defaults, in milliseconds', () => {
    expect(EXPERT_ABSENT_ALERT_MS).toBe(5 * MINUTE);
    expect(MISSED_CALL_TERMINATION_MS).toBe(10 * MINUTE);
    expect(CLIENT_ABSENT_NUDGE_MS).toBe(5 * MINUTE);
    expect(NO_SHOW_FLOOR_MS).toBe(15 * MINUTE);
    expect(IDLE_END_EMPTY_MS).toBe(5 * MINUTE);
  });

  it('every default is a positive finite number of milliseconds', () => {
    for (const value of Object.values(DEFAULT_MEETING_TIMERS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('DEFAULT_MEETING_TIMERS names exactly the five timers', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare `.sort()` is a SonarCloud reliability bug.
    expect(Object.keys(DEFAULT_MEETING_TIMERS).sort((a, b) => a.localeCompare(b))).toEqual([
      'clientAbsentNudgeMs',
      'expertAbsentAlertMs',
      'idleEndEmptyMs',
      'missedCallTerminationMs',
      'noShowFloorMs',
    ]);
  });

  it('DEFAULT_MEETING_TIMERS carries the module constants, not a second copy of the numbers', () => {
    expect(DEFAULT_MEETING_TIMERS).toEqual({
      expertAbsentAlertMs: EXPERT_ABSENT_ALERT_MS,
      missedCallTerminationMs: MISSED_CALL_TERMINATION_MS,
      clientAbsentNudgeMs: CLIENT_ABSENT_NUDGE_MS,
      noShowFloorMs: NO_SHOW_FLOOR_MS,
      idleEndEmptyMs: IDLE_END_EMPTY_MS,
    });
  });

  /**
   * ⚠⚠ THE TWO FIVE-MINUTE TIMERS SHARE A DEFAULT AND MUST STAY **INDEPENDENTLY DECLARED**.
   * Their ANCHORS differ (`scheduled_start` vs the expert-present clock start), so aliasing one
   * to the other — `export const CLIENT_ABSENT_NUDGE_MS = EXPERT_ABSENT_ALERT_MS` — would be a
   * silent behaviour change the moment either is overridden: `MEETING_EXPERT_ABSENT_ALERT_MINUTES`
   * would start moving the CLIENT nudge too.
   *
   * ⚠ IT READS THE SOURCE, AND IT HAS TO. Two constants that are EQUAL are indistinguishable at
   * runtime from one constant referenced twice — no value assertion can tell them apart, which
   * is exactly why the previous version of this test (`expect(A).toBe(B)`, then two comparisons
   * of unrelated pairs that are trivially unequal) stayed GREEN against the aliasing it was
   * named for. Reading the declaration is the only real guard.
   *
   * ⚠ `import.meta.url`, NOT `process.cwd()` — CI runs vitest from the repo root, so a
   * cwd-relative read would `ENOENT` there while passing locally.
   */
  it('⚠⚠ each five-minute timer is declared with its OWN literal — aliasing one to the other must fail', () => {
    const source = readFileSync(new URL('./timers.ts', import.meta.url), 'utf8');

    // Anchored, fixed-width, no nested quantifiers — ReDoS-safe (SonarCloud S5852).
    const DECLARATIONS: ReadonlyArray<{ name: string; minutes: number }> = [
      { name: 'EXPERT_ABSENT_ALERT_MS', minutes: 5 },
      { name: 'MISSED_CALL_TERMINATION_MS', minutes: 10 },
      { name: 'CLIENT_ABSENT_NUDGE_MS', minutes: 5 },
      { name: 'IDLE_END_EMPTY_MS', minutes: 5 },
    ];

    for (const { name, minutes } of DECLARATIONS) {
      expect(source).toContain(`export const ${name} = ${minutes} * MS_PER_MINUTE;`);
    }

    // …and no timer is declared in terms of another TIMER (NO_SHOW_FLOOR_MS is exempt — it is
    // deliberately derived from `bounds.ts`'s `MIN_MEETING_MINUTES`, D5's anti-drift fix, and is
    // asserted separately below).
    for (const { name } of DECLARATIONS) {
      for (const other of DECLARATIONS) {
        if (other.name === name) continue;
        expect(source).not.toContain(`export const ${name} = ${other.name}`);
      }
    }
  });

  /**
   * ⚠ D5 — THE ANTI-DRIFT ASSERTION. `bounds.ts`'s `MIN_MEETING_MINUTES` (the booking floor) and
   * this module's `NO_SHOW_FLOOR_MS` (the settlement floor, ms) MUST NOT be able to drift apart:
   * `NO_SHOW_FLOOR_MS` is DERIVED from `MIN_MEETING_MINUTES`, not a second copy of `15`.
   */
  it('⚠ D5 — NO_SHOW_FLOOR_MS is derived from bounds.ts MIN_MEETING_MINUTES, not a second copy', async () => {
    const { MIN_MEETING_MINUTES } = await import('./bounds');
    expect(NO_SHOW_FLOOR_MS).toBe(MIN_MEETING_MINUTES * MINUTE);

    const source = readFileSync(new URL('./timers.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'export const NO_SHOW_FLOOR_MS = MIN_MEETING_MINUTES * MS_PER_MINUTE;'
    );
    expect(source).toContain("import { MIN_MEETING_MINUTES } from './bounds';");
  });

  it('the five values are what the anchors need — the alert precedes its termination', () => {
    expect(DEFAULT_MEETING_TIMERS.expertAbsentAlertMs).toBeLessThan(
      DEFAULT_MEETING_TIMERS.missedCallTerminationMs
    );
    expect(DEFAULT_MEETING_TIMERS.clientAbsentNudgeMs).toBeLessThan(
      DEFAULT_MEETING_TIMERS.noShowFloorMs
    );
  });
});

describe('meetingTimersAreCoherent', () => {
  function withOverride(patch: Partial<MeetingTimers>): MeetingTimers {
    return { ...DEFAULT_MEETING_TIMERS, ...patch };
  }

  it('accepts the shipped defaults', () => {
    expect(meetingTimersAreCoherent(DEFAULT_MEETING_TIMERS)).toBe(true);
  });

  /** Each row is an override that would DISARM an alert or an anchor. */
  const INCOHERENT: ReadonlyArray<{ label: string; patch: Partial<MeetingTimers> }> = [
    {
      label: 'missed call at the same instant as the alert',
      patch: { missedCallTerminationMs: EXPERT_ABSENT_ALERT_MS },
    },
    { label: 'missed call BEFORE the alert', patch: { missedCallTerminationMs: MINUTE } },
    {
      label: 'no-show floor at the same instant as the nudge',
      patch: { noShowFloorMs: CLIENT_ABSENT_NUDGE_MS },
    },
    { label: 'no-show floor BEFORE the nudge', patch: { noShowFloorMs: MINUTE } },
    { label: 'zero expert alert', patch: { expertAbsentAlertMs: 0 } },
    { label: 'zero client nudge', patch: { clientAbsentNudgeMs: 0 } },
    { label: 'zero idle window', patch: { idleEndEmptyMs: 0 } },
    { label: 'negative idle window', patch: { idleEndEmptyMs: -1 } },
  ];

  it.each(INCOHERENT)('rejects $label', ({ patch }) => {
    expect(meetingTimersAreCoherent(withOverride(patch))).toBe(false);
  });
});
