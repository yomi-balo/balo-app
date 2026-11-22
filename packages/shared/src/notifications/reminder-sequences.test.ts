import { describe, expect, it } from 'vitest';
import {
  MAX_REMINDER_STEPS,
  REMINDER_DEFAULT_ZONE,
  REMINDER_SEQUENCE_IDS,
  REMINDER_SEQUENCE_STEPS,
  reminderRecipientZone,
  reminderSendAt,
  reminderSequenceKey,
  reminderSequenceKeyPrefix,
} from './reminder-sequences';

describe('REMINDER_SEQUENCE_STEPS', () => {
  it.each(REMINDER_SEQUENCE_IDS)(
    '%s has 1-3 steps, unique keys, ascending integer offsets',
    (id) => {
      const steps = REMINDER_SEQUENCE_STEPS[id];
      expect(steps.length).toBeGreaterThanOrEqual(1);
      expect(steps.length).toBeLessThanOrEqual(MAX_REMINDER_STEPS);
      expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
      const offsets = steps.map((s) => s.offsetMinutes);
      expect(offsets.every(Number.isInteger)).toBe(true);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }
  );

  it('proposal_review is day 2 / 5 / 9, weekday mornings', () => {
    expect(REMINDER_SEQUENCE_STEPS.proposal_review).toEqual([
      { key: 'day_2', offsetMinutes: 2880, timing: 'weekday_morning' },
      { key: 'day_5', offsetMinutes: 7200, timing: 'weekday_morning' },
      { key: 'day_9', offsetMinutes: 12960, timing: 'weekday_morning' },
    ]);
  });
});

describe('reminderRecipientZone', () => {
  it.each([null, undefined, '', 'UTC', 'Not/AZone', 'Etc/UTC'])(
    '%s falls back to Melbourne',
    (z) => {
      expect(reminderRecipientZone(z)).toBe(REMINDER_DEFAULT_ZONE);
    }
  );

  it('keeps a valid saved zone, canonicalised', () => {
    expect(reminderRecipientZone('Australia/Sydney')).toBe('Australia/Sydney');
    expect(reminderRecipientZone('US/Pacific')).toBe('America/Los_Angeles');
  });
});

describe('reminderSendAt', () => {
  const sydney = 'Australia/Sydney';

  it('exact returns the due instant', () => {
    const due = new Date('2026-11-21T04:00:00Z');
    expect(reminderSendAt(due, 'exact', sydney)).toEqual(due);
  });

  it('Saturday afternoon due moves to Monday 09:00 local', () => {
    // Sat 2026-11-21 14:00 Sydney (UTC+11) = 03:00Z
    const out = reminderSendAt(new Date('2026-11-21T03:00:00Z'), 'weekday_morning', sydney);
    expect(out.toISOString()).toBe('2026-11-22T22:00:00.000Z'); // Mon 23 Nov 09:00 AEDT
  });

  it('Wednesday 08:00 due sends the same day at 09:00', () => {
    // Wed 2026-11-25 08:00 Sydney = Tue 21:00Z
    const out = reminderSendAt(new Date('2026-11-24T21:00:00Z'), 'weekday_morning', sydney);
    expect(out.toISOString()).toBe('2026-11-24T22:00:00.000Z');
  });

  it('Wednesday 09:01 due moves to Thursday 09:00', () => {
    const out = reminderSendAt(new Date('2026-11-24T22:01:00Z'), 'weekday_morning', sydney);
    expect(out.toISOString()).toBe('2026-11-25T22:00:00.000Z');
  });

  it('Friday 09:01 due moves to Monday 09:00', () => {
    // Fri 2026-11-27 09:01 Sydney = Thu 22:01Z
    const out = reminderSendAt(new Date('2026-11-26T22:01:00Z'), 'weekday_morning', sydney);
    expect(out.toISOString()).toBe('2026-11-29T22:00:00.000Z');
  });

  it('a Monday after the Sydney DST start uses the new offset', () => {
    // Sat 2026-10-03 12:00 AEST (UTC+10) = 02:00Z; Monday 5 Oct 09:00 AEDT = Sun 22:00Z
    const out = reminderSendAt(new Date('2026-10-03T02:00:00Z'), 'weekday_morning', sydney);
    expect(out.toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });
});

describe('reminderSequenceKey', () => {
  it('names the step key, never the offset', () => {
    expect(
      reminderSequenceKey({
        sequenceId: 'proposal_review',
        entityId: 'e1',
        stepKey: 'day_2',
        userId: 'u1',
        anchorIso: '2026-11-20T00:00:00.000Z',
      })
    ).toBe('seq:proposal_review:e1:day_2:u1:2026-11-20T00:00:00.000Z');
  });

  it('prefix is seq:{id}:', () => {
    expect(reminderSequenceKeyPrefix('proposal_review')).toBe('seq:proposal_review:');
  });
});
