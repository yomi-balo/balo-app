import { describe, expect, it } from 'vitest';
import { HANDLED_DAILY_EVENT_TYPES, parseDailyWebhookEvent } from './webhook-events.js';

const ROOM = 'balo-22222222222242228222222222222222';
const RECEIVED_AT = new Date('2026-08-14T10:05:00.000Z');
const EVENT_TS = Math.floor(new Date('2026-08-14T10:01:00.000Z').getTime() / 1000);

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'evt_1',
    type: 'participant.joined',
    event_ts: EVENT_TS,
    payload: { room: ROOM, user_id: `u${'a'.repeat(32)}` },
    ...overrides,
  };
}

describe('parseDailyWebhookEvent (BAL-134 §5.1 / BAL-473 §7.3)', () => {
  it('handles exactly eight event types, in order', () => {
    expect([...HANDLED_DAILY_EVENT_TYPES]).toEqual([
      'participant.joined',
      'participant.left',
      'meeting.ended',
      'recording.started',
      'recording.ready-to-download',
      'recording.error',
      'batch-processor.job-finished',
      'batch-processor.error',
    ]);
  });

  it('parses a participant.joined into an open-shaped event', () => {
    const result = parseDailyWebhookEvent(envelope(), RECEIVED_AT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'participant.joined',
      eventId: 'evt_1',
      roomName: ROOM,
      participantId: `u${'a'.repeat(32)}`,
      occurredAt: new Date(EVENT_TS * 1000),
    });
  });

  it('accepts `room_name` as well as `room`, and `userId` as well as `user_id`', () => {
    const result = parseDailyWebhookEvent(
      envelope({ payload: { room_name: ROOM, userId: `g${'b'.repeat(32)}` } }),
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (
      !result.ok ||
      (result.event.kind !== 'participant.joined' && result.event.kind !== 'participant.left')
    ) {
      throw new Error('expected a participant event');
    }
    expect(result.event.roomName).toBe(ROOM);
    expect(result.event.participantId).toBe(`g${'b'.repeat(32)}`);
  });

  it('prefers the event`s OWN timestamp over the envelope`s', () => {
    const joinedAt = '2026-08-14T10:02:30.000Z';
    const result = parseDailyWebhookEvent(
      envelope({ payload: { room: ROOM, user_id: `u${'a'.repeat(32)}`, joined_at: joinedAt } }),
      RECEIVED_AT
    );

    expect(
      result.ok &&
        (result.event.kind === 'participant.joined' || result.event.kind === 'participant.left') &&
        result.event.occurredAt
    ).toEqual(new Date(joinedAt));
  });

  it('reads `left_at` on a participant.left', () => {
    const leftAt = '2026-08-14T10:30:00.000Z';
    const result = parseDailyWebhookEvent(
      envelope({
        type: 'participant.left',
        payload: { room: ROOM, user_id: `u${'a'.repeat(32)}`, left_at: leftAt },
      }),
      RECEIVED_AT
    );

    expect(
      result.ok &&
        (result.event.kind === 'participant.joined' || result.event.kind === 'participant.left') &&
        result.event.occurredAt
    ).toEqual(new Date(leftAt));
  });

  it('falls back to the RECEIPT time when the vendor names no instant at all', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_1', type: 'participant.joined', payload: { room: ROOM } },
      RECEIVED_AT
    );

    expect(
      result.ok &&
        (result.event.kind === 'participant.joined' || result.event.kind === 'participant.left') &&
        result.event.occurredAt
    ).toEqual(RECEIVED_AT);
  });

  /**
   * ⚠⚠ A PRESENT-BUT-UNPARSEABLE TIMESTAMP TRAVELS AS AN **INVALID DATE**, NOT AS THE RECEIPT
   * TIME. Silently substituting a plausible instant on a BILLING CLOCK would be the worst
   * possible answer. It reaches the write seam, where `InvalidPresenceTimestampError` rejects it
   * loudly — and the route still acks `200` so Daily does not retry a body that can never be
   * written (edge case 22).
   */
  it('⚠⚠ an UNPARSEABLE timestamp becomes an Invalid Date — never a plausible substitute', () => {
    const result = parseDailyWebhookEvent(
      envelope({ payload: { room: ROOM, user_id: `u${'a'.repeat(32)}`, joined_at: 'nonsense' } }),
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (
      !result.ok ||
      (result.event.kind !== 'participant.joined' && result.event.kind !== 'participant.left')
    )
      return;
    expect(Number.isNaN(result.event.occurredAt.getTime())).toBe(true);
  });

  it('carries a NULL participant id for a vendor participant we cannot map', () => {
    const result = parseDailyWebhookEvent(envelope({ payload: { room: ROOM } }), RECEIVED_AT);

    expect(result.ok).toBe(true);
    if (
      !result.ok ||
      (result.event.kind !== 'participant.joined' && result.event.kind !== 'participant.left')
    ) {
      throw new Error('expected a participant event');
    }
    expect(result.event.participantId).toBeNull();
  });

  it('parses meeting.ended, preferring `end_ts`', () => {
    const endTs = Math.floor(new Date('2026-08-14T10:45:00.000Z').getTime() / 1000);
    const result = parseDailyWebhookEvent(
      envelope({ type: 'meeting.ended', payload: { room: ROOM, end_ts: endTs } }),
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'meeting.ended',
      occurredAt: new Date(endTs * 1000),
    });
  });

  /**
   * ⚠ AN UNKNOWN TYPE IS A FIRST-CLASS OUTCOME, NOT AN ERROR. Daily fires types Balo does not
   * handle; a failure on one would flood the retry queue and eventually get the WEBHOOK
   * DISABLED, taking the three handled types down with it.
   */
  it('⚠ an unknown type is `unhandled`, not a parse failure', () => {
    const result = parseDailyWebhookEvent(envelope({ type: 'room.created' }), RECEIVED_AT);

    expect(result.ok && result.event).toMatchObject({
      kind: 'unhandled',
      type: 'room.created',
      roomName: ROOM,
    });
  });

  it('a HANDLED type with no resolvable room degrades to `unhandled` rather than failing', () => {
    const result = parseDailyWebhookEvent(envelope({ payload: { user_id: 'u1' } }), RECEIVED_AT);

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled', roomName: null });
  });

  /**
   * ⚠ THE EVENT ID IS REQUIRED. Without it the `daily_webhook_events` marker cannot do its job
   * (D2), and a replayed `participant.joined` after a legitimate close would open a SECOND
   * interval anchored in the past with no `left_at` — a silent, unbounded over-bill.
   */
  it.each([
    ['no id', { type: 'participant.joined', payload: { room: ROOM } }],
    ['a blank id', { id: '', type: 'participant.joined', payload: { room: ROOM } }],
    ['no type', { id: 'evt_1', payload: { room: ROOM } }],
    ['not an object', 'nonsense'],
    ['null (an unparseable body)', null],
  ])('⚠ refuses a body with %s', (_label, body) => {
    expect(parseDailyWebhookEvent(body, RECEIVED_AT)).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
  });

  /**
   * ⚠ ZOD STRIPS UNKNOWN KEYS BY DEFAULT, AND THAT IS RIGHT HERE: nothing downstream may read a
   * field this module has not named, so a vendor adding one cannot silently become an input.
   */
  it('⚠ ignores vendor fields this module does not name', () => {
    const result = parseDailyWebhookEvent(
      envelope({ version: '1.0', unexpected: { nested: true } }),
      RECEIVED_AT
    );

    expect(result.ok && Object.keys(result.event).sort((a, b) => a.localeCompare(b))).toEqual([
      'eventId',
      'kind',
      'occurredAt',
      'participantId',
      'roomName',
      'type',
    ]);
  });
});

describe('parseDailyWebhookEvent — recording.started (BAL-473)', () => {
  const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  /**
   * ⚠⚠ THE HIGHEST-VALUE ASSERTION IN THIS FILE. `recording.started` carries NO `room_name` —
   * the naive room-gate would swallow every delivery as `unhandled` and silently kill this arm.
   */
  it('⚠⚠ parses with NO `room_name` in the payload — NOT `unhandled`', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_1',
        type: 'recording.started',
        event_ts: EVENT_TS,
        payload: { instance_id: INSTANCE_ID, recording_id: 'daily-rec-1', start_ts: EVENT_TS },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'recording.started',
      eventId: 'evt_rec_1',
      roomName: null,
      instanceId: INSTANCE_ID,
      dailyRecordingId: 'daily-rec-1',
      startedAt: new Date(EVENT_TS * 1000),
    });
  });

  it('accepts `instanceId`/`recordingId` as well as `instance_id`/`recording_id`', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_1',
        type: 'recording.started',
        payload: { instanceId: INSTANCE_ID, recordingId: 'daily-rec-1' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'recording.started',
      instanceId: INSTANCE_ID,
      dailyRecordingId: 'daily-rec-1',
    });
  });

  it('a non-UUID instance_id ⇒ `unhandled` — it is by definition not ours', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_1',
        type: 'recording.started',
        payload: { instance_id: 'not-a-uuid', recording_id: 'daily-rec-1' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled', roomName: null });
  });

  it('a missing instance_id ⇒ `unhandled`', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_rec_1', type: 'recording.started', payload: { recording_id: 'daily-rec-1' } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled' });
  });

  it('a missing recording_id ⇒ `unhandled` — T2 cannot stamp without a daily_recording_id', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_rec_1', type: 'recording.started', payload: { instance_id: INSTANCE_ID } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled' });
  });

  it('falls back to the envelope `event_ts`, then to `receivedAt`, for `startedAt`', () => {
    const withEnvelope = parseDailyWebhookEvent(
      {
        id: 'evt_rec_1',
        type: 'recording.started',
        event_ts: EVENT_TS,
        payload: { instance_id: INSTANCE_ID, recording_id: 'daily-rec-1' },
      },
      RECEIVED_AT
    );
    expect(
      withEnvelope.ok &&
        withEnvelope.event.kind === 'recording.started' &&
        withEnvelope.event.startedAt
    ).toEqual(new Date(EVENT_TS * 1000));

    const withNeither = parseDailyWebhookEvent(
      {
        id: 'evt_rec_1',
        type: 'recording.started',
        payload: { instance_id: INSTANCE_ID, recording_id: 'daily-rec-1' },
      },
      RECEIVED_AT
    );
    expect(
      withNeither.ok &&
        withNeither.event.kind === 'recording.started' &&
        withNeither.event.startedAt
    ).toEqual(RECEIVED_AT);
  });
});

describe('parseDailyWebhookEvent — recording.ready-to-download (BAL-473)', () => {
  it('parses with a numeric duration', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_2',
        type: 'recording.ready-to-download',
        payload: { recording_id: 'daily-rec-1', room: ROOM, duration: 125.6 },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'recording.ready-to-download',
      dailyRecordingId: 'daily-rec-1',
      roomName: ROOM,
      durationSeconds: 126,
    });
  });

  it('accepts `recordingId` as well as `recording_id`', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_2',
        type: 'recording.ready-to-download',
        payload: { recordingId: 'daily-rec-1' },
      },
      RECEIVED_AT
    );

    expect(
      result.ok &&
        result.event.kind === 'recording.ready-to-download' &&
        result.event.dailyRecordingId
    ).toBe('daily-rec-1');
  });

  /**
   * ⚠⚠ BAL-480 FIX ROUND 1 — `start_ts` IN EITHER SPELLING. It was snake_case only, the ONE
   * exception in this file, and a silent one: this value is the discriminator for the room
   * -fallback guard in `routes/daily/webhook.ts`, and this module's header records that the
   * field names could NOT be verified against docs.daily.co. Read only as `start_ts`, a
   * camelCase payload would leave `startedAt` permanently `null` and the guard permanently
   * inert, with nothing to say so.
   */
  it("⚠⚠ accepts `startTs` as well as `start_ts` — the guard's discriminator", () => {
    for (const key of ['start_ts', 'startTs']) {
      const result = parseDailyWebhookEvent(
        {
          id: 'evt_rec_2',
          type: 'recording.ready-to-download',
          payload: { recording_id: 'daily-rec-1', room: ROOM, [key]: EVENT_TS },
        },
        RECEIVED_AT
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.event.kind !== 'recording.ready-to-download') {
        throw new Error('expected a ready-to-download event');
      }
      expect(result.event.startedAt?.toISOString()).toBe(new Date(EVENT_TS * 1000).toISOString());
    }
  });

  /**
   * ⚠ AN INVALID DATE, NOT `null`, FOR A PRESENT-BUT-UNPARSEABLE VALUE — the distinction
   * `instantFrom`'s docblock calls load-bearing, preserved through `startTsFrom`. The consumer
   * (`resolveRecordingByRoomFallback`) answers the two cases DIFFERENTLY: absent ⇒ accept and
   * log; uninterpretable ⇒ refuse. Collapsing them here would re-open the fail-open.
   */
  it('⚠ a present-but-unparseable `start_ts` yields an INVALID Date, never `null`', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_2',
        type: 'recording.ready-to-download',
        payload: { recording_id: 'daily-rec-1', room: ROOM, start_ts: 'not-a-timestamp' },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.event.kind !== 'recording.ready-to-download') {
      throw new Error('expected a ready-to-download event');
    }
    expect(result.event.startedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(result.event.startedAt?.getTime())).toBe(true);
  });

  it('a non-numeric/negative/absent `duration` ⇒ `durationSeconds: null`, never a guess', () => {
    for (const duration of [undefined, 'nonsense', -5, Number.POSITIVE_INFINITY]) {
      const result = parseDailyWebhookEvent(
        {
          id: 'evt_rec_2',
          type: 'recording.ready-to-download',
          payload: { recording_id: 'daily-rec-1', duration },
        },
        RECEIVED_AT
      );
      expect(
        result.ok &&
          result.event.kind === 'recording.ready-to-download' &&
          result.event.durationSeconds
      ).toBeNull();
    }
  });

  it('a missing recording_id ⇒ `unhandled`', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_rec_2', type: 'recording.ready-to-download', payload: { room: ROOM } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled', roomName: ROOM });
  });

  it('tolerates an ABSENT room — the fallback carries it, not a hard requirement', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_2',
        type: 'recording.ready-to-download',
        payload: { recording_id: 'daily-rec-1' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'recording.ready-to-download',
      roomName: null,
    });
  });
});

describe('parseDailyWebhookEvent — recording.error (BAL-473)', () => {
  const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('parses with an instance id and an error message', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_rec_3',
        type: 'recording.error',
        payload: { instance_id: INSTANCE_ID, room: ROOM, error_msg: 'disk full' },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'recording.error',
      instanceId: INSTANCE_ID,
      roomName: ROOM,
      errorMessage: 'disk full',
    });
  });

  it('⚠ `instance_id` IS OPTIONAL on this payload — an absent one still parses, room intact', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_rec_3', type: 'recording.error', payload: { room: ROOM } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'recording.error',
      instanceId: null,
      roomName: ROOM,
      errorMessage: null,
    });
  });

  it('accepts `errorMsg` as well as `error_msg`', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_rec_3', type: 'recording.error', payload: { errorMsg: 'timeout' } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'recording.error',
      errorMessage: 'timeout',
    });
  });
});

describe('parseDailyWebhookEvent — batch-processor.job-finished / .error (BAL-483)', () => {
  const JOB_ID = '02c2508e-8835-4f3e-bcf2-e319d00f0eec';

  it('parses batch-processor.job-finished into its arm with roomName: null', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_1',
        type: 'batch-processor.job-finished',
        payload: { id: JOB_ID, preset: 'transcript', status: 'finished', input: {}, output: {} },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'batch-processor.job-finished',
      eventId: 'evt_batch_1',
      roomName: null,
      batchJobId: JOB_ID,
      preset: 'transcript',
      dailyRecordingId: null,
    });
  });

  it('parses batch-processor.error into its arm with roomName: null', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_2',
        type: 'batch-processor.error',
        payload: {
          id: JOB_ID,
          preset: 'transcript',
          status: 'error',
          input: {},
          error: 'transcript job failed: Error: Failed to download: 403 Forbidden',
        },
      },
      RECEIVED_AT
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'batch-processor.error',
      roomName: null,
      batchJobId: JOB_ID,
      errorMessage: 'transcript job failed: Error: Failed to download: 403 Forbidden',
    });
  });

  it('⚠ payload.id absent ⇒ unhandled', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_3',
        type: 'batch-processor.job-finished',
        payload: { preset: 'transcript' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled', roomName: null });
  });

  it('⚠ preset: "summarize" ⇒ unhandled — Balo submits transcript jobs only', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_4',
        type: 'batch-processor.job-finished',
        payload: { id: JOB_ID, preset: 'summarize' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({ kind: 'unhandled', roomName: null });
  });

  it('⚠ preset ABSENT still parses — the deliberate permissiveness', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_batch_5', type: 'batch-processor.job-finished', payload: { id: JOB_ID } },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'batch-processor.job-finished',
      batchJobId: JOB_ID,
      preset: null,
    });
  });

  it('input.recordingId present ⇒ carried; absent ⇒ dailyRecordingId: null', () => {
    const withId = parseDailyWebhookEvent(
      {
        id: 'evt_batch_6',
        type: 'batch-processor.job-finished',
        payload: { id: JOB_ID, input: { recordingId: 'daily-rec-1' } },
      },
      RECEIVED_AT
    );
    expect(
      withId.ok &&
        withId.event.kind === 'batch-processor.job-finished' &&
        withId.event.dailyRecordingId
    ).toBe('daily-rec-1');

    const withSnakeCase = parseDailyWebhookEvent(
      {
        id: 'evt_batch_7',
        type: 'batch-processor.job-finished',
        payload: { id: JOB_ID, input: { recording_id: 'daily-rec-2' } },
      },
      RECEIVED_AT
    );
    expect(
      withSnakeCase.ok &&
        withSnakeCase.event.kind === 'batch-processor.job-finished' &&
        withSnakeCase.event.dailyRecordingId
    ).toBe('daily-rec-2');

    const withoutId = parseDailyWebhookEvent(
      { id: 'evt_batch_8', type: 'batch-processor.job-finished', payload: { id: JOB_ID } },
      RECEIVED_AT
    );
    expect(
      withoutId.ok &&
        withoutId.event.kind === 'batch-processor.job-finished' &&
        withoutId.event.dailyRecordingId
    ).toBeNull();
  });

  it('error text is carried on the error arm', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_batch_9', type: 'batch-processor.error', payload: { id: JOB_ID, error: 'boom' } },
      RECEIVED_AT
    );

    expect(
      result.ok && result.event.kind === 'batch-processor.error' && result.event.errorMessage
    ).toBe('boom');
  });

  it('⚠⚠ FIX ROUND 1 — `errorMessage` is NOT a real Daily spelling for this event; an errorMessage-only payload leaves errorMessage: null', () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_11',
        type: 'batch-processor.error',
        payload: { id: JOB_ID, errorMessage: 'not a real Daily field for this event' },
      },
      RECEIVED_AT
    );

    expect(
      result.ok && result.event.kind === 'batch-processor.error' && result.event.errorMessage
    ).toBeNull();
  });

  it("⚠ a non-UUID job id IS ACCEPTED — contrast `instanceIdFrom`, this is the VENDOR's id", () => {
    const result = parseDailyWebhookEvent(
      {
        id: 'evt_batch_10',
        type: 'batch-processor.job-finished',
        payload: { id: 'not-a-uuid-at-all' },
      },
      RECEIVED_AT
    );

    expect(result.ok && result.event).toMatchObject({
      kind: 'batch-processor.job-finished',
      batchJobId: 'not-a-uuid-at-all',
    });
  });
});
