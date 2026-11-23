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

  it('arms an exact step one lead ahead with at equal to the due time', () => {
    const exact = [{ key: 'ping', offsetMinutes: 60, timing: 'exact' }] as typeof STEPS;
    const planned = plan(new Date('2026-11-02T12:30:00.000Z'), ANCHOR, exact);
    expect(planned).toEqual([{ stepKey: 'ping', fireAt: new Date('2026-11-02T13:00:00.000Z') }]);
  });

  describe('steps that would land on the same morning', () => {
    const INVITATION = REMINDER_SEQUENCE_STEPS.invitation;
    const MELBOURNE = 'Australia/Melbourne';
    // Thursday 2026-11-05 14:00 Melbourne (UTC+11) is 03:00 UTC.
    const THURSDAY = new Date('2026-11-05T03:00:00.000Z');

    function planInvitation(now: Date) {
      return planDueSteps({
        steps: INVITATION,
        anchor: THURSDAY,
        now,
        leadMs: HOUR_MS,
        zone: MELBOURNE,
      });
    }

    it('sends day_1 on Monday and day_3 on Tuesday for a Thursday afternoon invite', () => {
      // day_1 is due Friday 14:00 and slips to Monday 09:00 (22:00 UTC Sunday); day_3 is due
      // Sunday 14:00 and would also be Monday 09:00.
      expect(planInvitation(new Date('2026-11-08T21:30:00.000Z'))).toEqual([
        { stepKey: 'day_1', fireAt: new Date('2026-11-08T22:00:00.000Z') },
      ]);
      expect(planInvitation(new Date('2026-11-09T22:30:00.000Z'))).toEqual([
        { stepKey: 'day_3', fireAt: new Date('2026-11-09T22:00:00.000Z') },
      ]);
    });

    it('arms the moved step within its own window', () => {
      expect(planInvitation(new Date('2026-11-09T21:30:00.000Z')).map((s) => s.stepKey)).toContain(
        'day_3'
      );
      expect(
        planInvitation(new Date('2026-11-09T20:30:00.000Z')).map((s) => s.stepKey)
      ).not.toContain('day_3');
    });

    it('leaves a proposal_review step alone when no other step shares its morning', () => {
      const planned = plan(new Date('2026-11-05T08:30:00.000Z'));
      expect(planned[0]?.fireAt.toISOString()).toBe('2026-11-05T09:00:00.000Z');
    });
  });
});
