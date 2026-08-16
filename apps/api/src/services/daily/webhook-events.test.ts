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

describe('parseDailyWebhookEvent (BAL-134 §5.1)', () => {
  it('handles exactly three event types', () => {
    expect([...HANDLED_DAILY_EVENT_TYPES]).toEqual([
      'participant.joined',
      'participant.left',
      'meeting.ended',
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
    if (!result.ok || result.event.kind === 'unhandled' || result.event.kind === 'meeting.ended') {
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

    expect(result.ok && result.event.kind !== 'unhandled' && result.event.occurredAt).toEqual(
      new Date(joinedAt)
    );
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

    expect(result.ok && result.event.kind !== 'unhandled' && result.event.occurredAt).toEqual(
      new Date(leftAt)
    );
  });

  it('falls back to the RECEIPT time when the vendor names no instant at all', () => {
    const result = parseDailyWebhookEvent(
      { id: 'evt_1', type: 'participant.joined', payload: { room: ROOM } },
      RECEIVED_AT
    );

    expect(result.ok && result.event.kind !== 'unhandled' && result.event.occurredAt).toEqual(
      RECEIVED_AT
    );
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
    if (!result.ok || result.event.kind === 'unhandled') return;
    expect(Number.isNaN(result.event.occurredAt.getTime())).toBe(true);
  });

  it('carries a NULL participant id for a vendor participant we cannot map', () => {
    const result = parseDailyWebhookEvent(envelope({ payload: { room: ROOM } }), RECEIVED_AT);

    expect(result.ok).toBe(true);
    if (!result.ok || result.event.kind === 'unhandled' || result.event.kind === 'meeting.ended') {
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
    const result = parseDailyWebhookEvent(envelope({ type: 'recording.started' }), RECEIVED_AT);

    expect(result.ok && result.event).toMatchObject({
      kind: 'unhandled',
      type: 'recording.started',
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
