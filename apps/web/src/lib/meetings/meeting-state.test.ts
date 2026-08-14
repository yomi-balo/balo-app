import { describe, expect, it } from 'vitest';
import {
  END_MEETING_FAILED_COPY,
  MEETING_STATE_RETRY_LABEL,
  MEETING_STATE_STALLED_COPY,
  parseMeetingState,
  type MeetingStateWire,
} from './meeting-state';

/**
 * BAL-134 (§7.1) — **THE WIRE PARSER.**
 *
 * ⚠⚠ THE PAYLOAD IS PARSED, NOT CAST. `meeting-lifecycle-client.ts` returns `parsed as T` — an
 * unchecked cast of an external JSON body — and two of these fields drive a MONEY-ADJACENT
 * display (the clocks, and the amber "counted" chip). A malformed body must degrade to "no
 * mirror" rather than to `NaN` on a chip a participant reads mid-call.
 */

const WIRE: MeetingStateWire = {
  status: 'waiting_for_participants',
  outcome: null,
  endedBy: null,
  viewerRole: 'expert',
  phase: 'near',
  clocks: {
    expertPresentMs: 720_000,
    billableMs: 0,
    expertFirstJoinedAt: '2026-08-14T10:00:00.000Z',
    billableStartedAt: null,
  },
  asOf: '2026-08-14T10:12:00.000Z',
};

describe('parseMeetingState — the happy path', () => {
  it('returns a snapshot with instants as Dates and durations as numbers', () => {
    const parsed = parseMeetingState(WIRE);

    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('waiting_for_participants');
    expect(parsed?.phase).toBe('near');
    expect(parsed?.viewerRole).toBe('expert');
    expect(parsed?.clocks.expertPresentMs).toBe(720_000);
    expect(parsed?.clocks.expertFirstJoinedAt).toEqual(new Date('2026-08-14T10:00:00.000Z'));
    expect(parsed?.clocks.billableStartedAt).toBeNull();
    expect(parsed?.asOf).toEqual(new Date('2026-08-14T10:12:00.000Z'));
  });

  it('⚠ carries no money figure, no token, no roomUrl and no participantId', () => {
    const serialised = JSON.stringify(parseMeetingState(WIRE));
    for (const forbidden of ['token', 'roomUrl', 'participantId', 'minor', 'amount']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('⚠ `outcome` stays a FREE STRING — narrowing it would blank a live mirror', () => {
    // `meeting_outcome` is BAL-412's enum to grow. An outcome this UI has never heard of must not
    // fail the whole parse; nothing here branches on the value.
    const parsed = parseMeetingState({ ...WIRE, outcome: 'some_future_label' });
    expect(parsed?.outcome).toBe('some_future_label');
  });
});

describe('parseMeetingState — rejects what it cannot trust', () => {
  const BAD: readonly [string, unknown][] = [
    ['null', null],
    ['a string', 'nope'],
    ['an empty object', {}],
    ['an unknown status', { ...WIRE, status: 'paused' }],
    ['an unknown phase', { ...WIRE, phase: 'halfway' }],
    ['an unknown viewer role', { ...WIRE, viewerRole: 'observer' }],
    ['a non-finite duration', { ...WIRE, clocks: { ...WIRE.clocks, billableMs: Number.NaN } }],
    ['a negative duration', { ...WIRE, clocks: { ...WIRE.clocks, expertPresentMs: -1 } }],
    ['a duration that is a string', { ...WIRE, clocks: { ...WIRE.clocks, billableMs: '0' } }],
    ['an unparseable asOf', { ...WIRE, asOf: 'not-a-date' }],
    ['a missing clocks block', { ...WIRE, clocks: undefined }],
  ];

  for (const [name, raw] of BAD) {
    it(`returns null for ${name}`, () => {
      expect(parseMeetingState(raw)).toBeNull();
    });
  }

  it('⚠ NEVER THROWS, on anything', () => {
    for (const raw of [undefined, Symbol('x'), 0, [], () => {}]) {
      expect(() => parseMeetingState(raw)).not.toThrow();
    }
  });
});

/**
 * ⚠⚠ **THE TWO NEW FIELDS ARE OPTIONAL ON THE WIRE, AND THAT IS A DEPLOY-ORDER DECISION.**
 *
 * Making either REQUIRED means a web deploy landing ahead of the api's fails the whole parse,
 * which degrades to `snapshot === null` — no phase, no chip, no mirror at all, for every
 * participant in every live call until the api catches up.
 */
describe('parseMeetingState — the optional server facts (BAL-134)', () => {
  it('reads the no-show floor and the presence block when the api sends them', () => {
    const parsed = parseMeetingState({
      ...WIRE,
      noShowFloorMinutes: 20,
      presence: { expertOpen: true },
    });

    expect(parsed?.noShowFloorMinutes).toBe(20);
    expect(parsed?.expertPresenceOpen).toBe(true);
  });

  it('⚠⚠ degrades to `null` — NOT to a default — when the api omits them', () => {
    const parsed = parseMeetingState(WIRE);

    // `null` means "the server did not say", which is a THIRD answer. A `15` here would be a
    // hard-coded threshold in the browser bundle, drifting from an overridden server.
    expect(parsed).not.toBeNull();
    expect(parsed?.noShowFloorMinutes).toBeNull();
    expect(parsed?.expertPresenceOpen).toBeNull();
  });

  it('⚠ `expertOpen: false` is preserved as `false`, not flattened into "not said"', () => {
    const parsed = parseMeetingState({ ...WIRE, presence: { expertOpen: false } });
    expect(parsed?.expertPresenceOpen).toBe(false);
  });

  it('⚠ a malformed optional field fails the parse rather than being quietly dropped', () => {
    expect(parseMeetingState({ ...WIRE, noShowFloorMinutes: 0 })).toBeNull();
    expect(parseMeetingState({ ...WIRE, noShowFloorMinutes: -5 })).toBeNull();
    expect(parseMeetingState({ ...WIRE, noShowFloorMinutes: 12.5 })).toBeNull();
    expect(parseMeetingState({ ...WIRE, presence: { expertOpen: 'yes' } })).toBeNull();
  });
});

describe('the fixed copy this module owns', () => {
  it('the end failure says what is TRUE — the call is still running — and names no cause', () => {
    expect(END_MEETING_FAILED_COPY).toBe("We couldn't end the call — everyone is still connected.");
    // The api collapses "no such meeting", "not your party" and "no authority" into ONE literal
    // precisely so a UI cannot start branching on prose.
    for (const leak of ['404', 'forbidden', 'permission', 'not found']) {
      expect(END_MEETING_FAILED_COPY.toLowerCase()).not.toContain(leak);
    }
  });

  it('⚠⚠ the stalled notice never claims the CALL ended — only the status line paused', () => {
    expect(MEETING_STATE_STALLED_COPY).toBe("Live status paused — you're still connected.");
    for (const alarm of ['disconnect', 'ended', 'lost', 'error', 'failed']) {
      expect(MEETING_STATE_STALLED_COPY.toLowerCase()).not.toContain(alarm);
    }
    expect(MEETING_STATE_RETRY_LABEL.length).toBeGreaterThan(0);
  });
});
