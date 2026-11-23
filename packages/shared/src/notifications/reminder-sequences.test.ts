import { describe, expect, it } from 'vitest';
import { AUTO_ACCEPT_DAYS } from '../engagements/delivery-review';
import {
  MAX_REMINDER_STEPS,
  REMINDER_ARMABLE_AFTER_DUE_MS,
  REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT,
  REMINDER_SEQUENCE_SHARED_RULES,
  REMINDER_SKIP_REASONS,
  reminderSequenceSpanMs,
  REMINDER_DEFAULT_ZONE,
  REMINDER_SEQUENCE_AUDIENCE,
  REMINDER_SEQUENCE_CHANNELS,
  REMINDER_SEQUENCE_IDS,
  REMINDER_SEQUENCE_STEPS,
  reminderLocalDayStart,
  reminderRecipientZone,
  reminderSendAt,
  reminderSequenceKey,
  reminderStepSendTimes,
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

  it('invitation is day 1 / 3, weekday mornings', () => {
    expect(REMINDER_SEQUENCE_STEPS.invitation).toEqual([
      { key: 'day_1', offsetMinutes: 1440, timing: 'weekday_morning' },
      { key: 'day_3', offsetMinutes: 4320, timing: 'weekday_morning' },
    ]);
  });

  it('proposal_review is day 2 / 5 / 9, weekday mornings', () => {
    expect(REMINDER_SEQUENCE_STEPS.proposal_review).toEqual([
      { key: 'day_2', offsetMinutes: 2880, timing: 'weekday_morning' },
      { key: 'day_5', offsetMinutes: 7200, timing: 'weekday_morning' },
      { key: 'day_9', offsetMinutes: 12960, timing: 'weekday_morning' },
    ]);
  });

  it('delivery_review is one exact step, 5 days after the completion request', () => {
    expect(REMINDER_SEQUENCE_STEPS.delivery_review).toEqual([
      { key: 'pre_auto_accept', offsetMinutes: 7200, timing: 'exact' },
    ]);
  });

  it('delivery_review step cannot fire after auto-accept unless dispatch lags', () => {
    const [step] = REMINDER_SEQUENCE_STEPS.delivery_review;
    const autoAcceptMs = AUTO_ACCEPT_DAYS * 86_400_000;
    expect((step?.offsetMinutes ?? 0) * 60_000 + REMINDER_ARMABLE_AFTER_DUE_MS).toBeLessThan(
      autoAcceptMs
    );
  });

  it('delivery_review names its wait rule', () => {
    expect(REMINDER_SEQUENCE_SHARED_RULES.delivery_review).toEqual(['deliveryReviewWait']);
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

describe('reminderStepSendTimes', () => {
  const melbourne = 'Australia/Melbourne';
  const times = (sequence: 'invitation' | 'proposal_review', anchor: string) =>
    reminderStepSendTimes({
      steps: REMINDER_SEQUENCE_STEPS[sequence],
      anchor: new Date(anchor),
      zone: melbourne,
    }).map(({ stepKey, fireAt }) => [stepKey, fireAt.toISOString()]);

  it('applies each step timing when no two steps share a morning', () => {
    // Monday 2026-11-02 10:00 AEDT.
    expect(times('proposal_review', '2026-11-01T23:00:00.000Z')).toEqual([
      ['day_2', '2026-11-04T22:00:00.000Z'],
      ['day_5', '2026-11-08T22:00:00.000Z'],
      ['day_9', '2026-11-11T22:00:00.000Z'],
    ]);
  });

  it('moves a Thursday-afternoon invitation day_3 off day_1 Monday to Tuesday', () => {
    // Thursday 2026-11-05 14:00 AEDT: both steps would otherwise send Monday 09:00.
    expect(times('invitation', '2026-11-05T03:00:00.000Z')).toEqual([
      ['day_1', '2026-11-08T22:00:00.000Z'],
      ['day_3', '2026-11-09T22:00:00.000Z'],
    ]);
  });

  it('moves a proposal_review day_5 off day_2 Monday in the week clocks go back', () => {
    // Wednesday 2027-03-31 09:30 AEDT; clocks go back on Sunday 2027-04-04, so day_5 falls due
    // at Monday 08:30 AEST, the same morning day_2 slipped to.
    expect(times('proposal_review', '2027-03-30T22:30:00.000Z')).toEqual([
      ['day_2', '2027-04-04T23:00:00.000Z'],
      ['day_5', '2027-04-05T23:00:00.000Z'],
      ['day_9', '2027-04-08T23:00:00.000Z'],
    ]);
  });

  it('leaves exact steps where they fall', () => {
    const steps = [
      { key: 'a', offsetMinutes: 60, timing: 'exact' as const },
      { key: 'b', offsetMinutes: 60, timing: 'exact' as const },
    ];
    const out = reminderStepSendTimes({
      steps,
      anchor: new Date('2026-11-02T00:00:00.000Z'),
      zone: melbourne,
    });
    expect(out.map(({ fireAt }) => fireAt.toISOString())).toEqual([
      '2026-11-02T01:00:00.000Z',
      '2026-11-02T01:00:00.000Z',
    ]);
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
    expect(reminderSequenceKeyPrefix('delivery_review')).toBe('seq:delivery_review:');
  });
});

describe('reminderLocalDayStart', () => {
  const melbourne = 'Australia/Melbourne';

  // Each instant falls on Tue 2026-11-24 Melbourne (AEDT, UTC+11), whose midnight is Mon 13:00Z.
  it.each([
    ['09:00:00.050 local (Mon 22:00:00.050Z)', '2026-11-23T22:00:00.050Z'],
    ['23:59 local, the last minute of the day (12:59Z)', '2026-11-24T12:59:00Z'],
    ['07:00 local, while UTC is still Monday (Mon 20:00Z)', '2026-11-23T20:00:00Z'],
  ])('Tuesday %s gives Tuesday 00:00 Melbourne', (_label, instant) => {
    const out = reminderLocalDayStart(new Date(instant), melbourne);
    expect(out.toISOString()).toBe('2026-11-23T13:00:00.000Z');
  });

  it('the DST-start day (23h, Sun 4 Oct 2026) starts at AEST midnight', () => {
    // Sun 2026-10-04 12:00 AEDT = 01:00Z; midnight AEST (UTC+10) = Sat 14:00Z
    const out = reminderLocalDayStart(new Date('2026-10-04T01:00:00Z'), melbourne);
    expect(out.toISOString()).toBe('2026-10-03T14:00:00.000Z');
  });

  it('the DST-end day (25h, Sun 5 Apr 2026) starts at AEDT midnight', () => {
    // Sun 2026-04-05 12:00 AEST = 02:00Z; midnight AEDT (UTC+11) = Sat 13:00Z
    const out = reminderLocalDayStart(new Date('2026-04-05T02:00:00Z'), melbourne);
    expect(out.toISOString()).toBe('2026-04-04T13:00:00.000Z');
  });

  it('works in a non-Melbourne zone', () => {
    // Tue 2026-11-24 09:00 EST (UTC-5) = 14:00Z; midnight = 05:00Z
    const out = reminderLocalDayStart(new Date('2026-11-24T14:00:00Z'), 'America/New_York');
    expect(out.toISOString()).toBe('2026-11-24T05:00:00.000Z');
  });
});

describe('reminderSequenceSpanMs', () => {
  it('is the largest step offset plus four days', () => {
    expect(reminderSequenceSpanMs()).toBe((9 + 4) * 86_400_000);
  });
});

describe('REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT', () => {
  it.each(REMINDER_SEQUENCE_IDS)('%s has an explicit flag', (id) => {
    expect(typeof REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT[id]).toBe('boolean');
  });

  it('proposal_review counts toward the daily limit', () => {
    expect(REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT.proposal_review).toBe(false);
  });
});

describe('REMINDER_SKIP_REASONS', () => {
  it('lists every skip the recheck guard records', () => {
    expect([...REMINDER_SKIP_REASONS]).toEqual([
      'malformed_payload',
      'already_decided',
      'no_longer_waiting',
      'anchor_moved',
      'recipient_gone',
      'over_daily_limit',
    ]);
  });
});

describe('REMINDER_SEQUENCE_SHARED_RULES', () => {
  it('names the proposal-review wait rule beside the awaiting rule', () => {
    expect(REMINDER_SEQUENCE_SHARED_RULES.proposal_review).toEqual([
      'proposalAwaitsClientReview',
      'proposalReviewWait',
    ]);
  });
});

describe('REMINDER_SEQUENCE_SHARED_RULES for invitation', () => {
  it('names the move rule beside the wait rule', () => {
    expect(REMINDER_SEQUENCE_SHARED_RULES.invitation).toEqual([
      'expertInvitationMove',
      'invitationReminderWait',
    ]);
  });
});

describe('REMINDER_SEQUENCE_CHANNELS', () => {
  it.each(REMINDER_SEQUENCE_IDS)('%s lists at least one channel', (id) => {
    expect(REMINDER_SEQUENCE_CHANNELS[id].length).toBeGreaterThanOrEqual(1);
  });

  it('matches each sequence event rule', () => {
    expect(REMINDER_SEQUENCE_CHANNELS).toEqual({
      proposal_review: ['email'],
      delivery_review: ['email', 'in_app'],
      invitation: ['email'],
    });
  });
});

describe('REMINDER_SEQUENCE_AUDIENCE', () => {
  it.each(REMINDER_SEQUENCE_IDS)('%s has an audience', (id) => {
    expect(['client', 'expert']).toContain(REMINDER_SEQUENCE_AUDIENCE[id]);
  });

  it('reminds the expert only on invitation', () => {
    expect(REMINDER_SEQUENCE_AUDIENCE).toEqual({
      proposal_review: 'client',
      delivery_review: 'client',
      invitation: 'expert',
    });
  });
});
