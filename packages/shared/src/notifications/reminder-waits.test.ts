import { describe, expect, it } from 'vitest';
import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  reminderSequenceKey,
  REMINDER_SEQUENCE_STEPS,
} from './reminder-sequences';
import {
  groupReminderWaits,
  parseReminderSequenceKey,
  PROPOSAL_REVIEW_STALLED_AFTER_MS,
  reminderSentToday,
  reminderStepMissed,
  reminderWaitFollowUpsFinished,
  reminderWaitSendTimes,
  reminderSequenceStepLabel,
  reminderWaitsLastStep,
  reminderWaitsStalled,
  type ReminderWaitRowFacts,
} from './reminder-waits';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '2026-11-02T01:00:00.000Z';
const NOW = new Date('2026-11-20T00:00:00.000Z');
const ZONE = 'Australia/Melbourne';
const zoneOf = (): string => ZONE;

function keyFor(
  stepKey: string,
  over: { entityId?: string; userId?: string; anchorIso?: string } = {}
): string {
  return reminderSequenceKey({
    sequenceId: 'proposal_review',
    entityId: over.entityId ?? ENTITY,
    stepKey,
    userId: over.userId ?? USER,
    anchorIso: over.anchorIso ?? ANCHOR,
  });
}

let counter = 0;
function row(over: Partial<ReminderWaitRowFacts> & { step?: string }): ReminderWaitRowFacts {
  counter += 1;
  return {
    id: `row-${String(counter).padStart(4, '0')}`,
    dedupeKey: keyFor(over.step ?? 'day_2'),
    status: 'pending',
    createdAt: new Date('2026-11-04T00:00:00.000Z'),
    publishedAt: null,
    scheduledFor: new Date('2026-11-04T00:00:00.000Z'),
    skipReason: null,
    ...over,
  };
}

describe('parseReminderSequenceKey', () => {
  it('is the inverse of reminderSequenceKey', () => {
    expect(parseReminderSequenceKey(keyFor('day_5'))).toEqual({
      sequenceId: 'proposal_review',
      entityId: ENTITY,
      stepKey: 'day_5',
      userId: USER,
      anchorIso: ANCHOR,
    });
  });

  it.each([
    ['not a sequence key', 'meeting_expert_absent:abc'],
    ['an unknown sequence', `seq:other:${ENTITY}:day_2:${USER}:${ANCHOR}`],
    ['an unknown step', `seq:proposal_review:${ENTITY}:day_3:${USER}:${ANCHOR}`],
    ['an empty entity', `seq:proposal_review::day_2:${USER}:${ANCHOR}`],
    ['an empty user', `seq:proposal_review:${ENTITY}:day_2::${ANCHOR}`],
    ['a missing anchor', `seq:proposal_review:${ENTITY}:day_2:${USER}`],
    ['a missing user', `seq:proposal_review:${ENTITY}:day_2`],
    ['an anchor that is not an ISO instant', `seq:proposal_review:${ENTITY}:day_2:${USER}:soon`],
    [
      'an anchor that does not round-trip',
      `seq:proposal_review:${ENTITY}:day_2:${USER}:2026-11-02T01:00:00Z`,
    ],
    ['an anchor with trailing space', `seq:proposal_review:${ENTITY}:day_2:${USER}:${ANCHOR} `],
    ['a key with leading space', ` ${keyFor('day_2')}`],
    ['a prefix with no sequence terminator', 'seq:proposal_review'],
  ])('rejects %s', (_label, key) => {
    expect(parseReminderSequenceKey(key)).toBeNull();
  });
});

describe('groupReminderWaits', () => {
  it('groups one recipient and anchor into a wait keyed by step', () => {
    const waits = groupReminderWaits([row({ step: 'day_2' }), row({ step: 'day_5' })]);
    expect(waits).toHaveLength(1);
    const [wait] = waits;
    expect(wait?.sequenceId).toBe('proposal_review');
    expect(wait?.entityId).toBe(ENTITY);
    expect(wait?.userId).toBe(USER);
    expect(wait?.anchorIso).toBe(ANCHOR);
    expect([...(wait?.steps.keys() ?? [])]).toEqual(['day_2', 'day_5']);
  });

  it('splits a moved anchor, another recipient and another entity into separate waits', () => {
    const waits = groupReminderWaits([
      row({ dedupeKey: keyFor('day_2') }),
      row({ dedupeKey: keyFor('day_2', { anchorIso: '2026-11-09T01:00:00.000Z' }) }),
      row({ dedupeKey: keyFor('day_2', { userId: 'other-user' }) }),
      row({ dedupeKey: keyFor('day_2', { entityId: 'other-entity' }) }),
    ]);
    expect(waits).toHaveLength(4);
  });

  it('drops unparsable keys, cancelled rows and already_decided skips (AC3)', () => {
    const waits = groupReminderWaits([
      row({ dedupeKey: 'not-a-sequence-key' }),
      row({ status: 'cancelled' }),
      row({ status: 'skipped', skipReason: 'already_decided' }),
    ]);
    expect(waits).toEqual([]);
  });

  it('yields no wait when every row is already_decided, and keeps other skips', () => {
    expect(
      groupReminderWaits([
        row({ step: 'day_2', status: 'skipped', skipReason: 'already_decided' }),
        row({ step: 'day_5', status: 'skipped', skipReason: 'already_decided' }),
      ])
    ).toEqual([]);
    const kept = groupReminderWaits([
      row({ step: 'day_2', status: 'skipped', skipReason: 'already_decided' }),
      row({ step: 'day_5', status: 'skipped', skipReason: 'no_longer_waiting' }),
    ]);
    expect(kept).toHaveLength(1);
    expect([...(kept[0]?.steps.keys() ?? [])]).toEqual(['day_5']);
  });

  it('keeps the newest row for a re-armed step, by createdAt then id', () => {
    const older = row({ id: 'a', status: 'failed', createdAt: new Date('2026-11-03T00:00:00Z') });
    const newer = row({ id: 'b', status: 'pending', createdAt: new Date('2026-11-04T00:00:00Z') });
    expect(groupReminderWaits([newer, older])[0]?.steps.get('day_2')?.id).toBe('b');
    expect(groupReminderWaits([older, newer])[0]?.steps.get('day_2')?.id).toBe('b');

    const sameTimeLowId = row({ id: 'a1', createdAt: new Date('2026-11-04T00:00:00Z') });
    const sameTimeHighId = row({ id: 'a2', createdAt: new Date('2026-11-04T00:00:00Z') });
    expect(groupReminderWaits([sameTimeHighId, sameTimeLowId])[0]?.steps.get('day_2')?.id).toBe(
      'a2'
    );
    expect(groupReminderWaits([sameTimeLowId, sameTimeHighId])[0]?.steps.get('day_2')?.id).toBe(
      'a2'
    );
  });
});

function waitOf(rows: ReminderWaitRowFacts[]) {
  const [wait] = groupReminderWaits(rows);
  if (wait === undefined) throw new Error('expected a wait');
  return wait;
}

const ALL_STEPS = REMINDER_SEQUENCE_STEPS.proposal_review.map((s) => s.key);

function published(step: string, at: string): ReminderWaitRowFacts {
  return row({ step, status: 'published', publishedAt: new Date(at) });
}

describe('reminderWaitFollowUpsFinished', () => {
  it('is true when every step is published, failed or gone', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      row({ step: 'day_5', status: 'failed' }),
      row({ step: 'day_9', status: 'skipped', skipReason: 'over_daily_limit' }),
    ]);
    expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(true);
  });

  it('counts an anchor_moved skip as gone', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
      row({ step: 'day_9', status: 'skipped', skipReason: 'anchor_moved' }),
    ]);
    expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(true);
  });

  it.each(['pending', 'claimed'])('is false while a step is %s', (status) => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
      row({ step: 'day_9', status }),
    ]);
    expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(false);
  });

  it('is false when a step has no row yet and is still inside its window', () => {
    const wait = waitOf([published('day_2', '2026-11-04T22:00:00Z')]);
    const insideWindow = new Date('2026-11-09T00:00:00.000Z');
    expect(reminderWaitFollowUpsFinished(wait, insideWindow, ZONE)).toBe(false);
  });

  it('counts a never-armed step past its window as gone, and not before it', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
    ]);
    // Due Wed 11 Nov 12:00 Melbourne, past 09:00, so it sends Thu 12 Nov 09:00 Melbourne.
    const sendAt = new Date('2026-11-11T22:00:00.000Z');
    const justInside = new Date(sendAt.getTime() + 86_400_000);
    const justPast = new Date(sendAt.getTime() + 86_400_000 + 1);
    expect(reminderWaitFollowUpsFinished(wait, justInside, ZONE)).toBe(false);
    expect(reminderWaitFollowUpsFinished(wait, justPast, ZONE)).toBe(true);
  });

  it.each(['no_longer_waiting', 'recipient_gone', 'malformed_payload'])(
    'is false when a step was skipped for %s',
    (skipReason) => {
      const wait = waitOf([
        published('day_2', '2026-11-04T22:00:00Z'),
        published('day_5', '2026-11-07T22:00:00Z'),
        row({ step: 'day_9', status: 'skipped', skipReason }),
      ]);
      expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(false);
    }
  );

  it('is false for a skipped step with no reason', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
      row({ step: 'day_9', status: 'skipped', skipReason: null }),
    ]);
    expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(false);
  });
});

describe('reminderStepMissed', () => {
  const day9 = REMINDER_SEQUENCE_STEPS.proposal_review.find((step) => step.key === 'day_9');

  it('is false for a step that has a row, however late', () => {
    if (day9 === undefined) throw new Error('expected day_9');
    const wait = waitOf([row({ step: 'day_9', status: 'pending' })]);
    expect(reminderStepMissed(wait, day9, NOW, ZONE)).toBe(false);
  });

  it('is true only once a rowless step is past its armable window', () => {
    if (day9 === undefined) throw new Error('expected day_9');
    const wait = waitOf([published('day_2', '2026-11-04T22:00:00Z')]);
    expect(reminderStepMissed(wait, day9, new Date('2026-11-09T00:00:00.000Z'), ZONE)).toBe(false);
    expect(reminderStepMissed(wait, day9, NOW, ZONE)).toBe(true);
  });
});

describe('reminderWaitSendTimes', () => {
  // Thursday 2026-11-05 15:00 AEDT.
  const THU_ANCHOR = '2026-11-05T04:00:00.000Z';
  const invitationWait = { sequenceId: 'invitation' as const, anchorIso: THU_ANCHOR };

  it('reads the planner send times, with day_3 bumped to Tuesday', () => {
    const times = reminderWaitSendTimes(invitationWait, ZONE);
    expect(times.get('day_1')?.toISOString()).toBe('2026-11-08T22:00:00.000Z');
    expect(times.get('day_3')?.toISOString()).toBe('2026-11-09T22:00:00.000Z');
  });

  it('has one entry per step of the sequence', () => {
    const times = reminderWaitSendTimes({ sequenceId: 'delivery_review', anchorIso: ANCHOR }, ZONE);
    expect([...times.keys()]).toEqual(['pre_auto_accept']);
    expect(times.get('pre_auto_accept')?.toISOString()).toBe('2026-11-07T01:00:00.000Z');
  });
});

describe('reminderStepMissed with the same-morning bump', () => {
  const day3 = REMINDER_SEQUENCE_STEPS.invitation.find((step) => step.key === 'day_3');
  const wait = {
    sequenceId: 'invitation' as const,
    anchorIso: '2026-11-05T04:00:00.000Z',
    steps: new Map<string, unknown>(),
  };
  // day_3 sends Tue 10 Nov 09:00 AEDT (Mon 22:00Z), not Mon 9 Nov.
  const tuesdaySend = new Date('2026-11-09T22:00:00.000Z');

  it('is missed only once past the Tuesday send plus the armable window', () => {
    if (day3 === undefined) throw new Error('expected day_3');
    const edge = new Date(tuesdaySend.getTime() + REMINDER_ARMABLE_AFTER_DUE_MS);
    expect(reminderStepMissed(wait, day3, edge, ZONE)).toBe(false);
    expect(reminderStepMissed(wait, day3, new Date(edge.getTime() + 1), ZONE)).toBe(true);
  });

  it('is not missed once past the window of the unbumped Monday send', () => {
    if (day3 === undefined) throw new Error('expected day_3');
    const afterMondayWindow = new Date('2026-11-10T00:00:00.000Z');
    expect(reminderStepMissed(wait, day3, afterMondayWindow, ZONE)).toBe(false);
  });

  it('is false for a step key the sequence does not have', () => {
    expect(
      reminderStepMissed(wait, { key: 'nope', offsetMinutes: 1, timing: 'exact' }, NOW, ZONE)
    ).toBe(false);
  });
});

describe('reminderWaitsLastStep', () => {
  it('is null with no waits', () => {
    expect(reminderWaitsLastStep([], NOW, zoneOf)).toBeNull();
  });

  it('uses scheduledFor for an unpublished row and counts sent against every step', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      row({
        step: 'day_5',
        status: 'skipped',
        skipReason: 'over_daily_limit',
        scheduledFor: new Date('2026-11-08T00:00:00Z'),
      }),
      row({
        step: 'day_9',
        status: 'skipped',
        skipReason: 'anchor_moved',
        scheduledFor: new Date('2026-11-10T00:00:00Z'),
      }),
    ]);
    const last = reminderWaitsLastStep([wait], NOW, zoneOf);
    expect(last?.at.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(last?.sent).toBe(1);
    expect(last?.total).toBe(3);
  });

  it('uses the planner send time for a missed step with no row', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
    ]);
    const last = reminderWaitsLastStep([wait], NOW, zoneOf);
    expect(last?.row).toBeNull();
    expect(last?.at).toEqual(reminderWaitSendTimes(wait, ZONE).get('day_9'));
    expect(last?.sent).toBe(2);
    expect(last?.total).toBe(3);
  });

  it('returns the newest step across every wait', () => {
    const early = waitOf([published('day_2', '2026-11-04T22:00:00Z')]);
    const late = waitOf([
      row({
        dedupeKey: keyFor('day_5', { userId: 'u2' }),
        status: 'published',
        publishedAt: new Date('2026-11-12T00:00:00Z'),
      }),
    ]);
    expect(reminderWaitsLastStep([early, late], NOW, zoneOf)?.at.toISOString()).toBe(
      '2026-11-12T00:00:00.000Z'
    );
  });
});

describe('reminderWaitsStalled', () => {
  const finished = (lastPublishedAt: string): ReminderWaitRowFacts[] => [
    published('day_2', '2026-11-04T22:00:00Z'),
    published('day_5', '2026-11-07T22:00:00Z'),
    published('day_9', lastPublishedAt),
  ];

  it('is false with no waits', () => {
    expect(reminderWaitsStalled([], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('is true once the last publish is more than the window ago', () => {
    const last = new Date(NOW.getTime() - PROPOSAL_REVIEW_STALLED_AFTER_MS - 1);
    const wait = waitOf(finished(last.toISOString()));
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(true);
  });

  it('is false at exactly the window', () => {
    const last = new Date(NOW.getTime() - PROPOSAL_REVIEW_STALLED_AFTER_MS);
    const wait = waitOf(finished(last.toISOString()));
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('is false while any wait still has a pending step', () => {
    const open = waitOf([
      row({
        dedupeKey: keyFor('day_2', { userId: 'u2' }),
        status: 'published',
        publishedAt: new Date('2026-11-04T00:00:00Z'),
      }),
      row({ dedupeKey: keyFor('day_5', { userId: 'u2' }), status: 'pending' }),
    ]);
    const done = waitOf(finished('2026-11-10T00:00:00Z'));
    expect(reminderWaitsStalled([done, open], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(
      false
    );
  });

  it('is true when the last step was missed and the last publish is over two days old', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
    ]);
    expect(reminderWaitFollowUpsFinished(wait, NOW, ZONE)).toBe(true);
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(true);
  });

  it('is false while the last step is still inside its window', () => {
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      published('day_5', '2026-11-07T22:00:00Z'),
    ]);
    const insideWindow = new Date('2026-11-12T22:00:00.000Z');
    expect(
      reminderWaitsStalled([wait], insideWindow, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)
    ).toBe(false);
  });

  const allSkippedAt = (scheduledFor: Date): ReminderWaitRowFacts[] =>
    ALL_STEPS.map((step) =>
      row({ step, status: 'skipped', skipReason: 'over_daily_limit', scheduledFor })
    );

  it('is true when every step was skipped and the last was due more than the window ago', () => {
    const wait = waitOf(
      allSkippedAt(new Date(NOW.getTime() - PROPOSAL_REVIEW_STALLED_AFTER_MS - 1))
    );
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(true);
  });

  it('is false for an all-skipped wait whose last step was due exactly the window ago', () => {
    const wait = waitOf(allSkippedAt(new Date(NOW.getTime() - PROPOSAL_REVIEW_STALLED_AFTER_MS)));
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('measures from the latest step time when sent and skipped steps are mixed', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const wait = waitOf([
      published('day_2', '2026-11-04T22:00:00Z'),
      row({ step: 'day_5', status: 'skipped', skipReason: 'anchor_moved', scheduledFor: recent }),
      row({
        step: 'day_9',
        status: 'skipped',
        skipReason: 'over_daily_limit',
        scheduledFor: new Date('2026-11-09T00:00:00Z'),
      }),
    ]);
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('is false for a failed-only wait whose last step was due moments ago', () => {
    const wait = waitOf(
      ALL_STEPS.map((step) =>
        row({ step, status: 'failed', scheduledFor: new Date(NOW.getTime() - 60_000) })
      )
    );
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('is false while a step is still pending, however old', () => {
    const wait = waitOf([
      ...allSkippedAt(new Date('2026-11-01T00:00:00Z')).slice(0, 2),
      row({ step: 'day_9', status: 'pending', scheduledFor: new Date('2026-11-01T00:00:00Z') }),
    ]);
    expect(reminderWaitsStalled([wait], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)).toBe(false);
  });

  it('uses the latest publish across every wait', () => {
    const stale = waitOf(finished('2026-11-10T00:00:00Z'));
    const recent = waitOf(
      finished('2026-11-19T00:00:00Z').map((r) => ({
        ...r,
        dedupeKey: r.dedupeKey.replace(USER, 'other-user'),
      }))
    );
    expect(
      reminderWaitsStalled([stale, recent], NOW, PROPOSAL_REVIEW_STALLED_AFTER_MS, zoneOf)
    ).toBe(false);
  });
});

describe('reminderSequenceStepLabel', () => {
  it('reads the sequence name and the 1-based step', () => {
    expect(reminderSequenceStepLabel(keyFor('day_2'))).toBe('Proposal review follow-up, step 1');
    expect(reminderSequenceStepLabel(keyFor('day_9'))).toBe('Proposal review follow-up, step 3');
  });

  it('is null for a key that is not a sequence key', () => {
    expect(reminderSequenceStepLabel('meeting_expert_absent:abc')).toBeNull();
  });
});

describe('reminderSentToday', () => {
  const ZONE = 'Australia/Melbourne';
  // 2026-11-20 09:00 Melbourne (UTC+11) = 22:00Z the day before; local midnight = 13:00Z.
  const now = new Date('2026-11-19T23:00:00.000Z');

  it('counts published rows since local midnight on a non-exempt sequence', () => {
    const rows = [
      published('day_2', '2026-11-19T22:00:00Z'),
      published('day_5', '2026-11-19T13:00:00Z'),
      published('day_9', '2026-11-19T12:59:59Z'),
      row({ step: 'day_2', status: 'pending' }),
      row({ step: 'day_5', status: 'skipped', skipReason: 'over_daily_limit' }),
    ];
    expect(reminderSentToday(rows, now, ZONE)).toBe(2);
  });

  it('ignores rows whose key is not a reminder sequence key', () => {
    const rows = [
      row({ dedupeKey: 'meeting_expert_absent:x', status: 'published', publishedAt: now }),
    ];
    expect(reminderSentToday(rows, now, ZONE)).toBe(0);
  });

  it('reads the day in the recipient zone', () => {
    // 12:00Z is before Melbourne's local midnight (13:00Z) but after Auckland's (11:00Z).
    const rows = [published('day_2', '2026-11-19T12:00:00Z')];
    expect(reminderSentToday(rows, now, ZONE)).toBe(0);
    expect(reminderSentToday(rows, now, 'Pacific/Auckland')).toBe(1);
  });
});
