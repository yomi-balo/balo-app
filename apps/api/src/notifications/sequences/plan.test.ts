import { describe, expect, it } from 'vitest';
import { REMINDER_SEQUENCE_STEPS, reminderDays } from '@balo/shared/notifications';
import { planDueSteps } from './plan.js';

const HOUR_MS = 3_600_000;
const STEPS = REMINDER_SEQUENCE_STEPS.proposal_review;
// Monday 2026-11-02 12:00 UTC.
const ANCHOR = new Date('2026-11-02T12:00:00.000Z');

function plan(now: Date, anchor = ANCHOR, steps = STEPS) {
  return planDueSteps({ steps, anchor, now, leadMs: HOUR_MS, zone: 'UTC' });
}

describe('planDueSteps', () => {
  it('arms nothing before the first step is one lead away', () => {
    expect(plan(new Date('2026-11-03T12:00:00.000Z'))).toEqual([]);
  });

  it('arms a step one lead ahead of its send time', () => {
    // day_2 is due Wed 2026-11-04 12:00 UTC, so it sends Thu 09:00 UTC.
    const planned = plan(new Date('2026-11-05T08:30:00.000Z'));
    expect(planned.map((step) => step.stepKey)).toEqual(['day_2']);
    expect(planned[0]?.fireAt.toISOString()).toBe('2026-11-05T09:00:00.000Z');
  });

  it('arms a step whose send time was 23 hours ago and not one that was 25 hours ago', () => {
    expect(plan(new Date('2026-11-06T08:00:00.000Z')).map((s) => s.stepKey)).toEqual(['day_2']);
    expect(plan(new Date('2026-11-06T10:00:00.000Z'))).toEqual([]);
  });

  it('measures the grace on the send time, so a Saturday step still arms for Monday', () => {
    // day_2 is due Saturday 2026-10-31 02:00 UTC and sends Monday 11-02 09:00 UTC, 55 hours later.
    const wednesday = new Date('2026-10-29T02:00:00.000Z');
    const planned = plan(new Date('2026-11-02T08:30:00.000Z'), wednesday);
    expect(planned.map((step) => step.stepKey)).toEqual(['day_2']);
    expect(planned[0]?.fireAt.toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('an offset moved so its send time is more than a day old is not armed', () => {
    const moved = [{ key: 'day_2', offsetMinutes: reminderDays(1), timing: 'weekday_morning' }];
    expect(plan(new Date('2026-11-06T12:00:00.000Z'), ANCHOR, moved as typeof STEPS)).toEqual([]);
  });

  describe('delivery_review', () => {
    const DELIVERY_STEPS = REMINDER_SEQUENCE_STEPS.delivery_review;
    const DAY_MS = 86_400_000;

    it('plans only pre_auto_accept, always at the same fireAt, on every hourly tick for 7 days', () => {
      const fireAts = new Set<number>();
      const planned: string[] = [];
      for (let hour = 0; hour <= 7 * 24; hour += 1) {
        const now = new Date(ANCHOR.getTime() + hour * HOUR_MS + 20 * 60_000);
        for (const step of plan(now, ANCHOR, DELIVERY_STEPS)) {
          planned.push(step.stepKey);
          fireAts.add(step.fireAt.getTime());
        }
      }
      expect(new Set(planned)).toEqual(new Set(['pre_auto_accept']));
      expect([...fireAts]).toEqual([ANCHOR.getTime() + 5 * DAY_MS]);
    });

    it('arms nothing once the step is more than the grace past due', () => {
      const late = new Date(ANCHOR.getTime() + 6 * DAY_MS + HOUR_MS);
      expect(plan(late, ANCHOR, DELIVERY_STEPS)).toEqual([]);
    });
  });

  it('arms an exact step one lead ahead with at equal to the due time', () => {
    const exact = [{ key: 'ping', offsetMinutes: 60, timing: 'exact' }] as typeof STEPS;
    const planned = plan(new Date('2026-11-02T12:30:00.000Z'), ANCHOR, exact);
    expect(planned).toEqual([{ stepKey: 'ping', fireAt: new Date('2026-11-02T13:00:00.000Z') }]);
  });
});
