import { describe, it, expect } from 'vitest';
import { reminderSequenceKey, type ReminderSequenceId } from '@balo/shared/notifications';
import {
  buildLookupFollowUps,
  liveWaitKey,
  type BuildFollowUpsInput,
  type FollowUpSourceRow,
  type LiveWait,
} from './build-lookup-follow-ups';
import {
  EXEMPT_NOTE,
  REASON_SENTENCE,
  SEQUENCE_META,
  channelLabel,
  type FollowUpReasonKey,
} from './follow-ups-view';

const REQUEST_ID = 'req-1';
const USER_ID = 'user-1';
/** Mon 16 Nov 2026, 2:00 pm in Melbourne. */
const ANCHOR_ISO = '2026-11-16T03:00:00.000Z';
const ANCHOR = new Date(ANCHOR_ISO);
/** Mon 23 Nov 2026, 4:00 pm in Melbourne. */
const NOW = new Date('2026-11-23T05:00:00.000Z');

const MELBOURNE = { firstName: 'Dana', lastName: 'Whitfield', timezone: 'Australia/Melbourne' };

function keyFor(stepKey: string, anchorIso = ANCHOR_ISO, entityId = REQUEST_ID): string {
  return reminderSequenceKey({
    sequenceId: 'proposal_review',
    entityId,
    stepKey,
    userId: USER_ID,
    anchorIso,
  });
}

function row(
  stepKey: string,
  over: Partial<FollowUpSourceRow> = {},
  anchorIso = ANCHOR_ISO,
  entityId = REQUEST_ID
): FollowUpSourceRow {
  return {
    id: `${stepKey}-${anchorIso}-${entityId}`,
    dedupeKey: keyFor(stepKey, anchorIso, entityId),
    status: 'pending',
    scheduledFor: new Date('2026-11-24T22:00:00.000Z'),
    publishedAt: null,
    skipReason: null,
    lastError: null,
    attempts: 0,
    createdAt: ANCHOR,
    updatedAt: new Date('2026-11-22T00:00:00.000Z'),
    payload: { entityId: REQUEST_ID, awaitingCount: 2, title: 'Stored title' },
    correlationId: null,
    recipient: MELBOURNE,
    entity: {
      title: 'Salesforce CPQ rollout',
      companyName: 'Northwind Industrial',
      agencyName: null,
    },
    ...over,
  };
}

function published(stepKey: string, at: string, over: Partial<FollowUpSourceRow> = {}) {
  return row(stepKey, {
    status: 'published',
    publishedAt: new Date(at),
    scheduledFor: new Date(at),
    ...over,
  });
}

function live(over: Partial<LiveWait> = {}): ReadonlyMap<string, LiveWait> {
  return new Map([
    [
      liveWaitKey('proposal_review', REQUEST_ID),
      { anchorIso: ANCHOR_ISO, awaitingCount: 2, title: 'Salesforce CPQ rollout', ...over },
    ],
  ]);
}

function build(over: Partial<BuildFollowUpsInput>): ReturnType<typeof buildLookupFollowUps> {
  return buildLookupFollowUps({
    lens: 'person',
    rows: [],
    live: live(),
    subject: { firstName: 'Dana', timezone: 'Australia/Melbourne' },
    origin: null,
    outcomes: [],
    truncated: { rows: null, relationships: null },
    now: NOW,
    ...over,
  });
}

describe('buildLookupFollowUps — grouping and sections', () => {
  it('drops already_decided rows, and a wait made only of them yields no wait (AC3)', () => {
    const view = build({
      rows: [row('day_2', { status: 'skipped', skipReason: 'already_decided' })],
    });
    expect(view.now).toEqual([]);
    expect(view.earlier).toEqual([]);
  });

  it('keeps a wait that has an already_decided step beside a real one', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-19T22:00:00.000Z'),
        row('day_5', { status: 'skipped', skipReason: 'already_decided' }),
      ],
    });
    expect(view.now).toHaveLength(1);
    expect(view.now[0]?.summary.startsWith('1 of 3 sent')).toBe(true);
  });

  it('orders Waiting now by oldest anchor first', () => {
    const olderIso = '2026-11-10T03:00:00.000Z';
    const view = build({
      rows: [row('day_2', {}, ANCHOR_ISO), row('day_2', {}, olderIso, 'req-2')],
      live: new Map([
        [
          liveWaitKey('proposal_review', REQUEST_ID),
          { anchorIso: ANCHOR_ISO, awaitingCount: 1, title: 'Newer' },
        ],
        [
          liveWaitKey('proposal_review', 'req-2'),
          { anchorIso: olderIso, awaitingCount: 1, title: 'Older' },
        ],
      ]),
    });
    expect(view.now.map((w) => w.headline)).toEqual(['Older', 'Newer']);
  });

  it('orders Earlier by most recently touched first', () => {
    const stopped = (anchorIso: string, updatedAt: string): FollowUpSourceRow =>
      row(
        'day_2',
        { status: 'published', publishedAt: ANCHOR, updatedAt: new Date(updatedAt) },
        anchorIso
      );
    const view = build({
      rows: [
        stopped('2026-10-20T03:00:00.000Z', '2026-11-01T00:00:00.000Z'),
        stopped('2026-10-25T03:00:00.000Z', '2026-11-05T00:00:00.000Z'),
      ],
      live: new Map(),
    });
    expect(view.earlier.map((w) => w.context.at(-1))).toEqual([
      'began waiting Sun 25 Oct',
      'began waiting Tue 20 Oct',
    ]);
  });

  it('leaves out an Earlier wait last touched more than 90 days ago', () => {
    const view = build({
      rows: [
        row('day_2', {
          status: 'published',
          publishedAt: ANCHOR,
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
      ],
      live: new Map(),
    });
    expect(view.earlier).toEqual([]);
    expect(view.now).toEqual([]);
  });
});

describe('buildLookupFollowUps — wait state', () => {
  it('is waiting while a step is still to come', () => {
    const view = build({ rows: [published('day_2', '2026-11-19T22:00:00.000Z')] });
    expect(view.now[0]?.state).toBe('waiting');
    expect(view.now[0]?.steps).toHaveLength(3);
  });

  it('is finished when every step has gone and it is still waiting', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-19T22:00:00.000Z'),
        published('day_5', '2026-11-22T22:00:00.000Z'),
        row('day_9', { status: 'skipped', skipReason: 'over_daily_limit' }),
      ],
    });
    expect(view.now[0]?.state).toBe('finished');
  });

  it('is finished when the last step has no row and its armable window has passed', () => {
    const olderIso = '2026-11-02T03:00:00.000Z';
    const view = build({
      rows: [
        row('day_2', { status: 'published', publishedAt: ANCHOR }, olderIso),
        row('day_5', { status: 'published', publishedAt: ANCHOR }, olderIso),
      ],
      live: live({ anchorIso: olderIso }),
    });
    expect(view.now[0]?.state).toBe('finished');
    expect(view.now[0]?.steps[2]).toMatchObject({ key: 'day_9', state: 'not_sent', code: null });
  });

  it('stays waiting while the rowless last step is still inside its window', () => {
    const view = build({
      rows: [published('day_2', '2026-11-19T22:00:00.000Z')],
    });
    expect(view.now[0]?.state).toBe('waiting');
  });

  it('is stopped when the live anchor moved, and renders only the stored steps', () => {
    const view = build({
      rows: [published('day_2', '2026-11-19T22:00:00.000Z')],
      live: live({ anchorIso: '2026-11-20T03:00:00.000Z' }),
    });
    expect(view.now).toEqual([]);
    expect(view.earlier[0]?.state).toBe('stopped');
    expect(view.earlier[0]?.steps).toHaveLength(1);
    expect(view.earlier[0]?.context.join(' ')).toContain('began waiting Mon 16 Nov');
  });

  it('counts a stopped wait against the whole sequence, not just the rows it has', () => {
    const view = build({
      rows: [published('day_2', '2026-11-19T22:00:00.000Z')],
      live: new Map(),
    });
    expect(view.earlier[0]?.steps).toHaveLength(1);
    expect(view.earlier[0]?.summary).toBe('1 of 3 sent');
  });

  it('is stopped when nothing is waiting any more', () => {
    const view = build({
      rows: [published('day_2', '2026-11-19T22:00:00.000Z')],
      live: new Map(),
    });
    expect(view.earlier[0]?.state).toBe('stopped');
  });

  it.each(['no_longer_waiting', 'recipient_gone', 'malformed_payload'])(
    'is stopped when the newest row was skipped with %s, even if the anchor still matches',
    (skipReason) => {
      const view = build({
        rows: [
          published('day_2', '2026-11-19T22:00:00.000Z'),
          row('day_5', {
            status: 'skipped',
            skipReason,
            createdAt: new Date('2026-11-22T00:00:00.000Z'),
          }),
        ],
      });
      expect(view.earlier[0]?.state).toBe('stopped');
    }
  );
});

describe('buildLookupFollowUps — steps', () => {
  it('reads a published row as Sent by email, at its published time', () => {
    const view = build({ rows: [published('day_2', '2026-11-18T22:00:00.000Z')] });
    const step = view.now[0]?.steps[0];
    expect(step).toMatchObject({
      key: 'day_2',
      ordinal: '1st',
      offsetLabel: '2 days after',
      state: 'sent',
      channel: 'Email',
      whenLabel: 'Thu 19 Nov, 9:00 am',
      sentence: null,
    });
  });

  it('reads a pending row as Due at its scheduled time', () => {
    const view = build({
      rows: [row('day_2', { scheduledFor: new Date('2026-11-24T22:00:00.000Z') })],
    });
    expect(view.now[0]?.steps[0]).toMatchObject({
      state: 'due',
      whenLabel: 'Wed 25 Nov, 9:00 am',
    });
  });

  it('reads a skipped row as Not sent with the sentence, the code and a "Was due" time', () => {
    const view = build({
      rows: [
        row('day_2', {
          status: 'skipped',
          skipReason: 'over_daily_limit',
          scheduledFor: new Date('2026-11-22T22:00:00.000Z'),
        }),
      ],
    });
    expect(view.now[0]?.steps[0]).toMatchObject({
      state: 'not_sent',
      sentence: 'Dana had already had two follow-up emails that day.',
      code: 'over_daily_limit',
      whenLabel: 'Was due Mon 23 Nov, 9:00 am',
      channel: null,
    });
  });

  it('reads a failed row as Failed with its attempts, last error and the admin Home pointer', () => {
    const view = build({
      rows: [row('day_2', { status: 'failed', attempts: 3, lastError: 'Brevo rejected it.' })],
    });
    const step = view.now[0]?.steps[0];
    expect(step).toMatchObject({
      state: 'failed',
      sentence: 'It could not be sent after 3 attempts.',
      code: 'status = failed',
      detail: 'Brevo rejected it. Also on admin Home.',
    });
    expect(view.now[0]?.hasFailed).toBe(true);
  });

  it('keeps the admin Home pointer when a failed row has no last error', () => {
    const view = build({
      rows: [row('day_2', { status: 'failed', attempts: 1, lastError: null })],
    });
    expect(view.now[0]?.steps[0]?.detail).toBe('Also on admin Home.');
    expect(view.now[0]?.steps[0]?.sentence).toBe('It could not be sent after 1 attempt.');
  });

  it('shows an unrecognised skip code as small print under a plain sentence', () => {
    const view = build({
      rows: [row('day_2', { status: 'skipped', skipReason: 'something_new' })],
    });
    expect(view.now[0]?.steps[0]).toMatchObject({
      state: 'not_sent',
      sentence: 'It was not sent.',
      code: 'something_new',
    });
  });

  it('computes a missing step as Due at its send time, and holds a weekend step to Monday morning', () => {
    const view = build({ rows: [published('day_2', '2026-11-18T22:00:00.000Z')] });
    const [, day5, day9] = view.now[0]?.steps ?? [];
    expect(day5).toMatchObject({
      key: 'day_5',
      state: 'due',
      whenLabel: 'Mon 23 Nov, 9:00 am',
      held: 'Fell due on Saturday. Held to Monday morning.',
    });
    expect(day9).toMatchObject({
      state: 'due',
      whenLabel: 'Thu 26 Nov, 9:00 am',
      held: null,
    });
  });

  it('holds a Friday-afternoon step to Monday and says nothing for a plain next-morning send', () => {
    const fridayDue = '2026-11-18T03:00:00.000Z';
    const view = build({
      rows: [row('day_2', {}, fridayDue)],
      live: live({ anchorIso: fridayDue }),
    });
    expect(view.now[0]?.steps[0]?.held).toBe('Fell due on Friday. Held to Monday morning.');
    expect(view.now[0]?.steps[1]?.held).toBeNull();
  });

  it('marks a missing step Not sent (missed) once its armable window has passed', () => {
    const view = build({
      rows: [published('day_5', '2026-11-22T22:00:00.000Z')],
      now: new Date('2026-11-23T05:00:00.000Z'),
    });
    expect(view.now[0]?.steps[0]).toMatchObject({
      key: 'day_2',
      state: 'not_sent',
      sentence: 'Its send window passed before it could go out.',
      code: null,
      whenLabel: 'Was due Thu 19 Nov, 9:00 am',
    });
  });

  it('reads a Pacific/Auckland recipient’s Due step in NZ local time (AC4)', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-18T20:00:00.000Z', {
          recipient: { firstName: 'Hemi', lastName: 'Tane', timezone: 'Pacific/Auckland' },
        }),
      ],
      now: new Date('2026-11-22T20:00:00.000Z'),
    });
    expect(view.now[0]?.steps[0]?.whenLabel).toBe('Thu 19 Nov, 9:00 am');
    expect(view.now[0]?.steps[1]?.whenLabel).toBe('Mon 23 Nov, 9:00 am');
  });

  it('uses Melbourne for a null zone, which sets the missed boundary an hour-block later than Auckland', () => {
    const base = {
      rows: [published('day_5', '2026-11-22T22:00:00.000Z')],
      now: new Date('2026-11-19T21:00:00.000Z'),
    };
    const melbourne = build({
      rows: base.rows.map((r) => ({ ...r, recipient: { ...MELBOURNE, timezone: null } })),
      now: base.now,
    });
    const auckland = build({
      rows: base.rows.map((r) => ({
        ...r,
        recipient: { ...MELBOURNE, timezone: 'Pacific/Auckland' },
      })),
      now: base.now,
    });
    expect(melbourne.now[0]?.steps[0]?.state).toBe('due');
    expect(auckland.now[0]?.steps[0]?.state).toBe('not_sent');
  });
});

describe('buildLookupFollowUps — summary, headline and context', () => {
  it('summarises the sent count, then not sent, failed and the next due time', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-18T22:00:00.000Z'),
        row('day_5', { status: 'skipped', skipReason: 'over_daily_limit' }),
        row('day_9', { status: 'failed', attempts: 3 }),
      ],
    });
    expect(view.now[0]?.summary).toBe('1 of 3 sent · 1 not sent · 1 failed');
  });

  it('adds the next due time to a waiting summary', () => {
    const view = build({ rows: [published('day_2', '2026-11-18T22:00:00.000Z')] });
    expect(view.now[0]?.summary).toBe('1 of 3 sent · next Mon 23 Nov, 9:00 am');
  });

  it('on a person lens, names the thing, then type, fact and since', () => {
    const view = build({ rows: [published('day_2', '2026-11-18T22:00:00.000Z')] });
    expect(view.now[0]).toMatchObject({
      title: 'Proposals to review',
      headline: 'Salesforce CPQ rollout',
      context: ['Project request', '2 proposals', 'waiting since Mon 16 Nov'],
    });
  });

  it('on an entity lens, names the person @ company, then fact and since', () => {
    const view = build({
      lens: 'entity',
      subject: null,
      rows: [published('day_2', '2026-11-18T22:00:00.000Z')],
    });
    expect(view.now[0]).toMatchObject({
      headline: 'Dana Whitfield @ Northwind Industrial',
      context: ['2 proposals', 'waiting since Mon 16 Nov'],
    });
    expect(view.limit).toBeNull();
    expect(view.subjectFirstName).toBeNull();
  });

  it('leaves out the company when the row has none, and names a gone recipient "A former user"', () => {
    const view = build({
      lens: 'entity',
      subject: null,
      rows: [row('day_2', { recipient: null, entity: null })],
    });
    expect(view.now[0]?.headline).toBe('A former user');
    const noCompany = build({
      lens: 'entity',
      subject: null,
      rows: [row('day_2', { entity: { title: 'T', companyName: null, agencyName: null } })],
    });
    expect(noCompany.now[0]?.headline).toBe('Dana Whitfield');
  });

  it('falls back from the live count to the stored count, and singularises one proposal', () => {
    const stored = build({
      rows: [row('day_2', { payload: { entityId: REQUEST_ID, awaitingCount: 1 } })],
      live: new Map(),
    });
    expect(stored.earlier[0]?.context).toContain('1 proposal');
    const none = build({
      rows: [row('day_2', { payload: { entityId: REQUEST_ID } })],
      live: new Map(),
    });
    expect(none.earlier[0]?.context.some((part) => part.includes('proposal'))).toBe(false);
  });

  it('falls back to the joined title, then the stored title', () => {
    const joined = build({ rows: [row('day_2')], live: new Map() });
    expect(joined.earlier[0]?.headline).toBe('Salesforce CPQ rollout');
    const stored = build({ rows: [row('day_2', { entity: null })], live: new Map() });
    expect(stored.earlier[0]?.headline).toBe('Stored title');
    const neither = build({
      rows: [row('day_2', { entity: null, payload: { entityId: REQUEST_ID } })],
      live: new Map(),
    });
    expect(neither.earlier[0]?.headline).toBe('A request');
  });

  it('carries the engagement origin through', () => {
    const view = build({ lens: 'entity', subject: null, origin: { requestTitle: 'CPQ' } });
    expect(view.origin).toEqual({ requestTitle: 'CPQ' });
  });

  it('identifies a wait by its newest row, never by anything holding the user id', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-19T22:00:00.000Z'),
        published('day_5', '2026-11-22T22:00:00.000Z', {
          createdAt: new Date('2026-11-21T00:00:00Z'),
        }),
      ],
    });
    expect(view.now).toHaveLength(1);
    expect(view.now[0]?.id).toBe(`day_5-${ANCHOR_ISO}-${REQUEST_ID}`);
    const everyId = [...view.now, ...view.earlier].map((w) => w.id);
    expect(everyId.some((id) => id.includes(USER_ID))).toBe(false);
  });
});

describe('buildLookupFollowUps — the daily limit strip', () => {
  const sentToday = [
    published('day_2', '2026-11-22T22:00:00.000Z'),
    published('day_5', '2026-11-22T23:00:00.000Z'),
  ];

  it('counts follow-ups published since local midnight and marks the strip full at two', () => {
    const view = build({ rows: sentToday });
    expect(view.limit).toEqual({ used: 2, of: 2, full: true });
    expect(view.subjectFirstName).toBe('Dana');
  });

  it('is not full below the limit, and does not count yesterday', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-22T22:00:00.000Z'),
        published('day_5', '2026-11-20T22:00:00.000Z'),
      ],
    });
    expect(view.limit).toEqual({ used: 1, of: 2, full: false });
  });

  it('counts "today" from local midnight in the person’s own zone', () => {
    const rows = [published('day_2', '2026-11-22T10:00:00.000Z')];
    const now = new Date('2026-11-22T12:30:00.000Z');
    // 11:30 pm Sunday in Melbourne, but 1:30 am Monday in Auckland.
    const melbourne = build({ rows, now, subject: { firstName: 'D', timezone: null } });
    const auckland = build({
      rows,
      now,
      subject: { firstName: 'H', timezone: 'Pacific/Auckland' },
    });
    expect(melbourne.limit?.used).toBe(1);
    expect(auckland.limit?.used).toBe(0);
  });

  it('has no first name when the subject is unknown', () => {
    expect(build({ subject: null }).subjectFirstName).toBeNull();
  });
});

describe('buildLookupFollowUps — what the view carries', () => {
  const view = build({
    rows: [
      published('day_2', '2026-11-18T22:00:00.000Z'),
      row('day_5', { status: 'failed', attempts: 3, lastError: 'Rejected' }),
      row('day_9', { status: 'skipped', skipReason: 'over_daily_limit' }),
    ],
  });
  const json = JSON.stringify(view);

  it('has no payload key and no price, fee, margin, markup or amount key (AC5)', () => {
    expect(json).not.toContain('"payload"');
    expect(json).not.toMatch(/"[A-Za-z]*(price|fee|margin|markup|amount)[A-Za-z]*":/i);
  });

  it('never says "24 hours" (decision 2)', () => {
    expect(json).not.toMatch(/24 hours/i);
    for (const key of Object.keys(REASON_SENTENCE) as FollowUpReasonKey[]) {
      expect(REASON_SENTENCE[key]('Dana', 3)).not.toMatch(/24 hours/i);
    }
  });
});

const DELIVERY_ANCHOR_ISO = '2026-11-18T01:00:00.000Z';
const ENGAGEMENT_ID = 'eng-1';
const RELATIONSHIP_ID = 'rel-1';
const TOM = { firstName: 'Tom', lastName: 'Okafor', timezone: 'Australia/Melbourne' };

function seqRow(
  sequenceId: ReminderSequenceId,
  entityId: string,
  stepKey: string,
  anchorIso: string,
  over: Partial<FollowUpSourceRow> = {}
): FollowUpSourceRow {
  return {
    ...row(stepKey, {}, anchorIso, entityId),
    id: `${sequenceId}-${stepKey}-${entityId}`,
    dedupeKey: reminderSequenceKey({ sequenceId, entityId, stepKey, userId: USER_ID, anchorIso }),
    createdAt: new Date(anchorIso),
    ...over,
  };
}

function liveFor(
  sequenceId: ReminderSequenceId,
  entityId: string,
  anchorIso: string,
  over: Partial<LiveWait> = {}
): ReadonlyMap<string, LiveWait> {
  return new Map([
    [liveWaitKey(sequenceId, entityId), { anchorIso, awaitingCount: null, title: null, ...over }],
  ]);
}

describe('buildLookupFollowUps — delivery review (decision 16)', () => {
  const sent = seqRow('delivery_review', ENGAGEMENT_ID, 'pre_auto_accept', DELIVERY_ANCHOR_ISO, {
    status: 'published',
    publishedAt: new Date('2026-11-23T01:05:00.000Z'),
    scheduledFor: new Date('2026-11-23T01:00:00.000Z'),
    entity: {
      title: 'Data migration, phase 1',
      companyName: 'Northwind Industrial',
      agencyName: null,
    },
  });
  const delivery = (over: Partial<BuildFollowUpsInput> = {}): ReturnType<typeof build> =>
    build({
      rows: [sent],
      live: liveFor('delivery_review', ENGAGEMENT_ID, DELIVERY_ANCHOR_ISO),
      ...over,
    });

  it('words the wait from the reference, with the auto-accept day and the exempt note', () => {
    const [wait] = delivery().now;
    expect(wait?.title).toBe('Work to review');
    expect(wait?.headline).toBe('Data migration, phase 1');
    expect(wait?.context).toEqual([
      'Engagement',
      'Auto-accepts Wed 25 Nov',
      'marked complete Wed 18 Nov',
    ]);
    expect(wait?.note).toBe(EXEMPT_NOTE);
    expect(wait?.steps[0]).toMatchObject({
      offsetLabel: '5 days after, exact time',
      state: 'sent',
      channel: 'Email and in-app',
    });
  });

  it('says the auto-accept was due, never accepted, once its date has passed on a live wait', () => {
    const due = delivery({ now: new Date('2026-11-25T01:00:00.000Z') }).now[0];
    expect(due?.state).toBe('waiting');
    expect(due?.context).toEqual([
      'Engagement',
      'Auto-accept was due Wed 25 Nov',
      'marked complete Wed 18 Nov',
    ]);
    const later = delivery({ now: new Date('2026-11-27T05:00:00.000Z') }).now[0];
    expect(later?.context[1]).toBe('Auto-accept was due Wed 25 Nov');
  });

  it('still says Auto-accepts a moment before the auto-accept date', () => {
    const before = delivery({ now: new Date('2026-11-25T00:59:59.000Z') }).now[0];
    expect(before?.context[1]).toBe('Auto-accepts Wed 25 Nov');
  });

  it('reads waiting, not finished, once its one step has sent: auto-accept closes it', () => {
    expect(delivery().now[0]?.state).toBe('waiting');
    expect(delivery().earlier).toEqual([]);
  });

  it('a proposal wait that has run out of follow-ups still reads finished', () => {
    const view = build({
      rows: [
        published('day_2', '2026-11-18T22:00:00.000Z'),
        published('day_5', '2026-11-19T22:00:00.000Z'),
        published('day_9', '2026-11-20T22:00:00.000Z'),
      ],
    });
    expect(view.now[0]?.state).toBe('finished');
    expect(view.now[0]?.note).toBeNull();
  });

  it('drops the auto-accept fact and says "marked complete" on a stopped wait', () => {
    const [wait] = delivery({ live: new Map() }).earlier;
    expect(wait?.state).toBe('stopped');
    expect(wait?.context).toEqual(['Engagement', 'marked complete Wed 18 Nov']);
  });

  it('falls back to "A project" when nothing names the engagement', () => {
    const untitled = seqRow(
      'delivery_review',
      ENGAGEMENT_ID,
      'pre_auto_accept',
      DELIVERY_ANCHOR_ISO,
      {
        payload: {},
        entity: { title: null, companyName: 'Northwind Industrial', agencyName: null },
      }
    );
    const [wait] = delivery({ rows: [untitled] }).now;
    expect(wait?.headline).toBe('A project');
  });

  it('names the person at the company on an entity lens', () => {
    const [wait] = delivery({ lens: 'entity', subject: null }).now;
    expect(wait?.headline).toBe('Dana Whitfield @ Northwind Industrial');
    expect(wait?.context).toEqual(['Auto-accepts Wed 25 Nov', 'marked complete Wed 18 Nov']);
  });

  it('does not count a delivery warning against the daily limit', () => {
    const view = delivery({
      rows: [sent, published('day_2', '2026-11-22T22:00:00.000Z')],
    });
    expect(view.limit).toEqual({ used: 1, of: 2, full: false });
  });
});

describe('buildLookupFollowUps — invitation (decision 16)', () => {
  const INVITED_ISO = '2026-11-17T03:00:00.000Z';
  const invited = (over: Partial<FollowUpSourceRow['entity'] & object> = {}): FollowUpSourceRow =>
    seqRow('invitation', RELATIONSHIP_ID, 'day_1', INVITED_ISO, {
      status: 'published',
      publishedAt: new Date('2026-11-17T22:00:00.000Z'),
      recipient: TOM,
      entity: {
        title: 'Field Service rollout',
        companyName: 'Bright Foods',
        agencyName: 'CloudPeak',
        ...over,
      },
    });
  const liveInvitation = liveFor('invitation', RELATIONSHIP_ID, INVITED_ISO, {
    title: 'Field Service rollout',
  });

  it('shows who invited the expert on a person lens', () => {
    const [wait] = build({ rows: [invited()], live: liveInvitation }).now;
    expect(wait?.title).toBe('Invitation to answer');
    expect(wait?.headline).toBe('Field Service rollout');
    expect(wait?.context).toEqual(['Project request', 'From Bright Foods', 'invited Tue 17 Nov']);
    expect(wait?.note).toBeNull();
    expect(wait?.steps[0]?.channel).toBe('Email');
  });

  it('names the expert at their agency on an entity lens, with no fact', () => {
    const [wait] = build({
      lens: 'entity',
      subject: null,
      rows: [invited()],
      live: liveInvitation,
    }).now;
    expect(wait?.headline).toBe('Tom Okafor @ CloudPeak');
    expect(wait?.context).toEqual(['invited Tue 17 Nov']);
  });

  it('says "Independent expert" with a bare name when there is no agency', () => {
    const [wait] = build({
      lens: 'entity',
      subject: null,
      rows: [invited({ agencyName: null })],
      live: liveInvitation,
    }).now;
    expect(wait?.headline).toBe('Tom Okafor');
    expect(wait?.context).toEqual(['Independent expert', 'invited Tue 17 Nov']);
  });

  it('says nothing about the agency when the relationship is gone', () => {
    const [wait] = build({
      lens: 'entity',
      subject: null,
      rows: [{ ...invited(), entity: null }],
      live: liveInvitation,
    }).now;
    expect(wait?.context).toEqual(['invited Tue 17 Nov']);
  });

  it('still reads finished once both follow-ups have gone: nothing closes it by itself', () => {
    const rows = [
      invited(),
      seqRow('invitation', RELATIONSHIP_ID, 'day_3', INVITED_ISO, {
        status: 'published',
        publishedAt: new Date('2026-11-20T22:00:00.000Z'),
        recipient: TOM,
      }),
    ];
    expect(build({ rows, live: liveInvitation }).now[0]?.state).toBe('finished');
  });
});

describe('buildLookupFollowUps — send times agree with the planner', () => {
  /** Thu 19 Nov 2026, 3:00 pm in Melbourne. */
  const THURSDAY_ISO = '2026-11-19T04:00:00.000Z';
  const rows = [
    seqRow('invitation', RELATIONSHIP_ID, 'day_1', THURSDAY_ISO, {
      status: 'published',
      publishedAt: new Date('2026-11-22T22:00:00.000Z'),
      recipient: TOM,
    }),
  ];
  const liveInvitation = liveFor('invitation', RELATIONSHIP_ID, THURSDAY_ISO);

  it('puts day 3 on Tuesday morning, not the Monday its due day would suggest', () => {
    const view = build({
      rows,
      live: liveInvitation,
      now: new Date('2026-11-23T01:00:00.000Z'),
    });
    const day3 = view.now[0]?.steps.find((step) => step.key === 'day_3');
    expect(day3).toMatchObject({ state: 'due', whenLabel: 'Tue 24 Nov, 9:00 am' });
  });

  it('does not call day 3 missed while its Tuesday send is still armable', () => {
    // Tue 24 Nov, 4:00 pm Melbourne: past Monday 9 am + 24 h, inside Tuesday 9 am + 24 h.
    const view = build({
      rows,
      live: liveInvitation,
      now: new Date('2026-11-24T05:00:00.000Z'),
    });
    const day3 = view.now[0]?.steps.find((step) => step.key === 'day_3');
    expect(day3?.state).toBe('due');
    expect(day3?.code).toBeNull();
  });

  it('calls day 3 missed once Tuesday’s window has passed', () => {
    const view = build({
      rows,
      live: liveInvitation,
      now: new Date('2026-11-25T23:00:00.000Z'),
    });
    const day3 = view.now[0]?.steps.find((step) => step.key === 'day_3');
    expect(day3?.state).toBe('not_sent');
    expect(day3?.sentence).toBe(REASON_SENTENCE.missed('Dana', 0));
  });
});

describe('follow-up wording tables', () => {
  it('has a title, aboutType and untitled fallback for every sequence', () => {
    expect(Object.keys(SEQUENCE_META).sort()).toEqual([
      'delivery_review',
      'invitation',
      'proposal_review',
    ]);
  });

  it('joins channels into a label', () => {
    expect(channelLabel(['email'])).toBe('Email');
    expect(channelLabel(['email', 'in_app'])).toBe('Email and in-app');
  });
});

describe('buildLookupFollowUps — delivery result on a sent step (decision 19)', () => {
  const SENT_AT = '2026-11-19T22:00:00.000Z';

  function sentStep(outcomes: BuildFollowUpsInput['outcomes']) {
    const view = build({
      rows: [published('day_2', SENT_AT, { correlationId: 'corr-1' })],
      outcomes,
    });
    const step = view.now[0]?.steps[0];
    if (step === undefined) throw new Error('no step');
    return { view, step };
  }

  it('reads Email sent and keeps the Sent state', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'sent', error: null },
    ]);
    expect(step.state).toBe('sent');
    expect(step.label).toBe('Sent');
    expect(step.delivery.map((l) => l.text)).toEqual(['Email sent']);
  });

  it('reads Email failed with its error, but another channel sent keeps Sent', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'failed', error: 'Mailbox full' },
      { correlationId: 'corr-1', channel: 'in-app', status: 'sent', error: null },
    ]);
    expect(step.state).toBe('sent');
    expect(step.label).toBe('Sent');
    expect(step.delivery.map((l) => l.text)).toEqual(['Email failed: Mailbox full', 'In-app sent']);
  });

  it('reads an sms outcome as SMS sent', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'sms', status: 'sent', error: null },
    ]);
    expect(step.delivery.map((l) => l.text)).toEqual(['SMS sent']);
  });

  it('reads Email skipped with its error', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'skipped', error: 'Unsubscribed' },
      { correlationId: 'corr-1', channel: 'in-app', status: 'sent', error: null },
    ]);
    expect(step.delivery.map((l) => l.text)).toEqual([
      'Email skipped: Unsubscribed',
      'In-app sent',
    ]);
  });

  it('says Delivery not recorded yet when the log has no row, and stays Sent', () => {
    const { step } = sentStep([
      { correlationId: 'other', channel: 'email', status: 'sent', error: null },
    ]);
    expect(step.state).toBe('sent');
    expect(step.delivery.map((l) => l.text)).toEqual(['Delivery not recorded yet']);
  });

  it('says Delivery not recorded yet for a row with no correlation id', () => {
    const view = build({ rows: [published('day_2', SENT_AT)] });
    expect(view.now[0]?.steps[0]?.delivery.map((l) => l.text)).toEqual([
      'Delivery not recorded yet',
    ]);
  });

  it('becomes failed and reads Not delivered when every logged channel failed or was skipped', () => {
    const { view, step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'failed', error: 'Bounced' },
      { correlationId: 'corr-1', channel: 'in-app', status: 'skipped', error: 'Muted' },
    ]);
    expect(step.state).toBe('failed');
    expect(step.label).toBe('Not delivered');
    expect(step.channel).toBeNull();
    expect(view.now[0]?.hasFailed).toBe(true);
    expect(view.now[0]?.summary.startsWith('0 of 3 sent · 1 failed')).toBe(true);
  });

  it('keeps an error of exactly 160 characters whole', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'failed', error: 'x'.repeat(160) },
    ]);
    expect(step.delivery[0]?.text).toBe(`Email failed: ${'x'.repeat(160)}`);
  });

  it('cuts an error of 161 characters to 160 plus an ellipsis', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'failed', error: 'x'.repeat(161) },
    ]);
    expect(step.delivery[0]?.text).toBe(`Email failed: ${'x'.repeat(160)}…`);
  });

  it('truncates a long error to 160 characters', () => {
    const { step } = sentStep([
      { correlationId: 'corr-1', channel: 'email', status: 'failed', error: 'x'.repeat(400) },
    ]);
    expect(step.delivery[0]?.text).toBe(`Email failed: ${'x'.repeat(160)}…`);
  });

  it('shows no delivery line on a step that was not published', () => {
    const view = build({
      rows: [row('day_2', { correlationId: 'corr-1' })],
      outcomes: [{ correlationId: 'corr-1', channel: 'email', status: 'sent', error: null }],
    });
    expect(view.now[0]?.steps[0]?.delivery).toEqual([]);
    expect(view.now[0]?.steps[0]?.label).toBe('Due');
  });
});

describe('buildLookupFollowUps — truncation', () => {
  it('passes the truncation through to the view', () => {
    expect(build({ truncated: { rows: 500, relationships: 200 } }).truncated).toEqual({
      rows: 500,
      relationships: 200,
    });
    expect(build({}).truncated).toEqual({ rows: null, relationships: null });
  });
});
