import { describe, it, expect, vi } from 'vitest';
import type { Meeting } from '@balo/db';
import {
  mapCaseConsultations,
  type CaseConsultationActionContext,
  type CaseConsultationCounts,
} from './map-case-consultations';
import { log } from '@/lib/logging';

/**
 * BAL-421 — unit tests for THE PROJECTION BOUNDARY.
 *
 * ⚠⚠ EVERY FIXTURE CARRIES A REAL-LOOKING `joinUrl` AND `dailyRoomName`, AND THAT IS THE
 * POINT. `listMeetingsForContext` returns FULL `Meeting` rows including live call-join
 * credentials, and TypeScript's excess-property checking does NOT apply to spreads — so the
 * day someone "simplifies" the field-by-field build into `{ ...meeting, state }`, every type
 * stays green and the browser starts receiving room locators. The leak assertions below
 * serialize the WHOLE output and look for the secret, so they cannot be satisfied by a type.
 *
 * ⚠ `@balo/shared/engagements` and `derive-consultation-ordinal` ARE REAL — the state
 * derivation and the ordinal rule are what these tests are actually pinning. `@balo/db` is
 * imported for TYPES ONLY here (as it is in the module under test), so it is erased and needs
 * no mock.
 */

vi.mock('server-only', () => ({}));

const JOIN_URL = 'https://balo.daily.co/case-room-7f3a?t=SUPERSECRETJOINTOKEN';
const ROOM_NAME = 'case-room-7f3a';

const EMPTY_COUNTS: CaseConsultationCounts = {
  actionItemCountByMeetingId: new Map(),
  fileCountByMeetingId: new Map(),
  meetingIdsWithTranscript: new Set(),
  meetingIdsWithLiveProposal: new Set(),
  guestCountByMeetingId: new Map(),
  clientSideEverPresentByMeetingId: new Map(),
};

/** A `now` well before every fixture's default `scheduledStart` — irrelevant to the tests that
 *  don't assert on the new row-action fields, and the explicit clock for the ones that do. */
const NOW = new Date('2026-01-01T00:00:00Z');

/** No capability at all — the neutral default for tests that only pin state/duration/ordering. */
const NO_ACTION: CaseConsultationActionContext = {
  lens: 'client',
  mayAct: false,
  mayInvite: false,
};

/**
 * A FULL `Meeting` row — credentials included, exactly as the repository hands one over.
 * Cast at the boundary because the real row has many more columns than any assertion needs;
 * the leak tests below are what actually police the extra ones.
 */
function meeting(over: Partial<Meeting> & { id: string }): Meeting {
  return {
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    scheduledEnd: new Date('2026-07-01T10:30:00Z'),
    startedAt: null,
    endedAt: null,
    status: 'scheduled',
    outcome: null,
    joinUrl: JOIN_URL,
    dailyRoomName: ROOM_NAME,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as Meeting;
}

/** An `ended` + `completed` meeting with real stamps — the ordinary "held" shape. */
function held(id: string, over: Partial<Meeting> = {}): Meeting {
  return meeting({
    id,
    status: 'ended',
    outcome: 'completed',
    startedAt: new Date('2026-07-01T10:00:00Z'),
    endedAt: new Date('2026-07-01T10:42:00Z'),
    ...over,
  });
}

describe('mapCaseConsultations — the SECRET-LEAK boundary', () => {
  it('emits NO joinUrl and NO dailyRoomName on ANY row, in any state', async () => {
    const rows = mapCaseConsultations(
      [
        held('m1'),
        meeting({ id: 'm2' }),
        meeting({ id: 'm3', status: 'in_progress', startedAt: new Date('2026-07-02T10:00:00Z') }),
        meeting({ id: 'm4', status: 'cancelled' }),
      ],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(JOIN_URL);
    expect(serialized).not.toContain(ROOM_NAME);
    expect(serialized).not.toContain('SUPERSECRETJOINTOKEN');
    for (const row of rows) {
      expect(row).not.toHaveProperty('joinUrl');
      expect(row).not.toHaveProperty('dailyRoomName');
    }
  });

  /**
   * The allow-list, spelled out. A new `meetings` column that silently joined the client
   * payload would fail HERE — which is the whole reason the mapper builds field by field.
   */
  it('emits EXACTLY the declared field set — nothing joins the payload by accident', () => {
    const [row] = mapCaseConsultations([held('m1')], EMPTY_COUNTS, NOW, NO_ACTION);
    expect(row === undefined ? [] : Object.keys(row).sort()).toEqual([
      'actionItemCount',
      'canCancel',
      'canInvite',
      'canProposeReschedule',
      'canReschedule',
      'durationMinutes',
      'fileCount',
      'guestCount',
      'hasRecording',
      'hasTranscript',
      'live',
      'meetingId',
      'ordinal',
      'recapHref',
      'scheduledMinutes',
      'scheduledStartIso',
      'startedAtIso',
      'state',
    ]);
  });

  it('consumes `status` and `outcome` and NEVER serializes them — the client gets the LABEL', () => {
    const [row] = mapCaseConsultations([held('m1')], EMPTY_COUNTS, NOW, NO_ACTION);
    expect(row?.state).toBe('held');
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('outcome');
  });
});

describe('mapCaseConsultations — state derivation', () => {
  it.each([
    ['scheduled', { status: 'scheduled', outcome: null }, 'scheduled'],
    [
      'waiting_for_participants',
      { status: 'waiting_for_participants', outcome: null },
      'scheduled',
    ],
    ['in_progress', { status: 'in_progress', outcome: null }, 'in_progress'],
    ['ended+completed', { status: 'ended', outcome: 'completed' }, 'held'],
    ['ended+no_show_client', { status: 'ended', outcome: 'no_show_client' }, 'no_show_client'],
    ['ended+missed_call', { status: 'ended', outcome: 'missed_call' }, 'missed_call'],
    ['cancelled', { status: 'cancelled', outcome: null }, 'cancelled'],
    ['ended+NULL outcome', { status: 'ended', outcome: null }, 'outcome_pending'],
  ])('maps %s → %s', (_label, row, expected) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(mapped?.state).toBe(expected);
  });

  /**
   * ⚠ THE TWO NON-HELD OUTCOMES ARE NOT INTERCHANGEABLE. `no_show_client` is "the client did
   * not turn up"; `missed_call` is "the call did not happen". They carry different copy and,
   * on the billing side, different money consequences — collapsing them into one "didn't
   * happen" label would tell one party the other stood them up when nobody did.
   */
  it('keeps no_show_client and missed_call DISTINCT', () => {
    const rows = mapCaseConsultations(
      [
        meeting({
          id: 'm1',
          status: 'ended',
          outcome: 'no_show_client',
          startedAt: new Date('2026-07-01T10:00:00Z'),
        }),
        meeting({
          id: 'm2',
          status: 'ended',
          outcome: 'missed_call',
          startedAt: new Date('2026-07-02T10:00:00Z'),
        }),
      ],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(rows.map((r) => r.state)).toEqual(['no_show_client', 'missed_call']);
    expect(rows[0]?.state).not.toBe(rows[1]?.state);
  });

  /**
   * ⚠ `nobody_joined` IS DERIVED FROM THE LOADER'S PRESENCE MAP, AND ONLY FROM A KNOWN `false`.
   * An id ABSENT from the map is "unknown" — a read that did not happen or failed — and must
   * keep `missed_call`, or a client who waited would be told nobody turned up.
   */
  describe('nobody_joined — a missed call nobody client-side joined either', () => {
    const MISSED = { status: 'ended', outcome: 'missed_call' } as const;

    it('maps ended+missed_call with a KNOWN-false client presence → nobody_joined', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...MISSED })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', false]]) },
        NOW,
        NO_ACTION
      );
      expect(row?.state).toBe('nobody_joined');
    });

    it('keeps missed_call when somebody client-side WAS present', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...MISSED })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', true]]) },
        NOW,
        NO_ACTION
      );
      expect(row?.state).toBe('missed_call');
    });

    it('keeps missed_call when the meeting is ABSENT from the map — unknown, never "absent"', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...MISSED })],
        // A `false` for a DIFFERENT meeting, so a lookup that ignored the id would fail here.
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m-other', false]]) },
        NOW,
        NO_ACTION
      );
      expect(row?.state).toBe('missed_call');
    });

    it('reads presence PER MEETING — one row of each from a single call', () => {
      const rows = mapCaseConsultations(
        [
          meeting({ id: 'm1', ...MISSED, scheduledStart: new Date('2026-07-01T10:00:00Z') }),
          meeting({ id: 'm2', ...MISSED, scheduledStart: new Date('2026-07-02T10:00:00Z') }),
          meeting({ id: 'm3', ...MISSED, scheduledStart: new Date('2026-07-03T10:00:00Z') }),
        ],
        {
          ...EMPTY_COUNTS,
          clientSideEverPresentByMeetingId: new Map([
            ['m1', false],
            ['m2', true],
          ]),
        },
        NOW,
        NO_ACTION
      );
      expect(rows.map((row) => [row.meetingId, row.state])).toEqual([
        ['m1', 'nobody_joined'],
        ['m2', 'missed_call'],
        ['m3', 'missed_call'],
      ]);
    });

    it.each([
      ['ended+completed', { status: 'ended', outcome: 'completed' }, 'held'],
      ['ended+no_show_client', { status: 'ended', outcome: 'no_show_client' }, 'no_show_client'],
      ['ended+NULL outcome', { status: 'ended', outcome: null }, 'outcome_pending'],
      ['cancelled', { status: 'cancelled', outcome: null }, 'cancelled'],
    ])('ignores a false presence on %s → %s', (_label, row, expected) => {
      const [mapped] = mapCaseConsultations(
        [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', false]]) },
        NOW,
        NO_ACTION
      );
      expect(mapped?.state).toBe(expected);
    });

    it('serializes the LABEL only — no presence fact joins the row', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...MISSED })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', false]]) },
        NOW,
        NO_ACTION
      );
      expect(row?.state).toBe('nobody_joined');
      expect(row).not.toHaveProperty('clientSideEverPresent');
      expect(JSON.stringify(row)).not.toMatch(/presen/i);
    });

    it('keeps the recap link on a nobody_joined row — the not-held panel explains it', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...MISSED })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', false]]) },
        NOW,
        NO_ACTION
      );
      expect(row?.state).toBe('nobody_joined');
      expect(row?.recapHref).toBe('/meetings/m1?from=case_surface');
    });
  });

  it('warns when a meeting ENDED with no outcome recorded — it must not be invisible', () => {
    vi.mocked(log.warn).mockClear();
    mapCaseConsultations(
      [meeting({ id: 'm1', status: 'ended', outcome: null })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Case consultation ended with no outcome recorded',
      expect.objectContaining({ meetingId: 'm1', status: 'ended' })
    );
  });
});

/**
 * ⚠ ONLY AN `ended` MEETING HAS A RECAP LINK. `loadRecap` returns `null` — and the recap page
 * 404s — for the three non-terminal statuses, so linking one would send the viewer from their
 * own case to a dead end. `cancelled` renders a recap (the not-held panel), but that panel is
 * `body: 'This consultation was cancelled.'` and nothing else — no money block, no artifacts —
 * so its link would lead somewhere emptier than the row itself. NEVER a disabled link.
 */
describe('mapCaseConsultations — recapHref', () => {
  it.each([
    ['held', { status: 'ended', outcome: 'completed' }],
    ['no_show_client', { status: 'ended', outcome: 'no_show_client' }],
    ['missed_call', { status: 'ended', outcome: 'missed_call' }],
    ['outcome_pending', { status: 'ended', outcome: null }],
  ])('EMITS a recap link for %s', (_label, row) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(mapped?.recapHref).toBe('/meetings/m1?from=case_surface');
  });

  it.each([
    ['scheduled', { status: 'scheduled', outcome: null }],
    ['waiting_for_participants', { status: 'waiting_for_participants', outcome: null }],
    ['in_progress', { status: 'in_progress', outcome: null }],
    ['cancelled', { status: 'cancelled', outcome: null }],
  ])('emits NO recap link for %s — an absent action beats a dead one', (_label, row) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(mapped?.recapHref).toBeNull();
  });

  it('carries the `from=case_surface` provenance param', () => {
    const [mapped] = mapCaseConsultations([held('m1')], EMPTY_COUNTS, NOW, NO_ACTION);
    expect(mapped?.recapHref).toContain('?from=case_surface');
  });
});

describe('mapCaseConsultations — duration, counts and ordering', () => {
  it('computes WALL-CLOCK minutes between the two stamps', () => {
    const [mapped] = mapCaseConsultations([held('m1')], EMPTY_COUNTS, NOW, NO_ACTION);
    expect(mapped?.durationMinutes).toBe(42);
  });

  it('reports NULL duration — never a bare zero — when a stamp is missing', () => {
    const [scheduled] = mapCaseConsultations([meeting({ id: 'm1' })], EMPTY_COUNTS, NOW, NO_ACTION);
    expect(scheduled?.durationMinutes).toBeNull();

    const [started] = mapCaseConsultations(
      [meeting({ id: 'm2', status: 'in_progress', startedAt: new Date('2026-07-01T10:00:00Z') })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(started?.durationMinutes).toBeNull();
  });

  it('reads the three counts from the batched maps, defaulting to 0 / false', () => {
    const rows = mapCaseConsultations(
      [held('m1'), held('m2')],
      {
        actionItemCountByMeetingId: new Map([['m1', 3]]),
        fileCountByMeetingId: new Map([['m1', 2]]),
        meetingIdsWithTranscript: new Set(['m1']),
        meetingIdsWithLiveProposal: new Set(),
        guestCountByMeetingId: new Map(),
        clientSideEverPresentByMeetingId: new Map(),
      },
      NOW,
      NO_ACTION
    );
    const [first, second] = rows;
    expect(first).toMatchObject({ actionItemCount: 3, fileCount: 2, hasTranscript: true });
    expect(second).toMatchObject({ actionItemCount: 0, fileCount: 0, hasTranscript: false });
  });

  /**
   * BAL-411 — `pending_reschedule` is nested INSIDE the `scheduled` branch of
   * `deriveCaseConsultationState`, so a meeting carrying a LIVE proposal renders that state
   * instead of plain `scheduled`. This is the projection boundary's own wiring test; the
   * derivation's full priority table lives in `@balo/shared/engagements`'s own suite.
   */
  it('BAL-411 — a meeting in meetingIdsWithLiveProposal renders pending_reschedule, not scheduled', () => {
    const [withProposal, withoutProposal] = mapCaseConsultations(
      [meeting({ id: 'm1' }), meeting({ id: 'm2' })],
      { ...EMPTY_COUNTS, meetingIdsWithLiveProposal: new Set(['m1']) },
      NOW,
      NO_ACTION
    );
    expect(withProposal?.state).toBe('pending_reschedule');
    expect(withoutProposal?.state).toBe('scheduled');
  });

  it('hard-falses hasRecording — no capture exists anywhere on the platform', () => {
    const rows = mapCaseConsultations(
      [held('m1'), meeting({ id: 'm2' })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    // `.every()` is vacuously true on `[]`; the length assertion guards against that.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.hasRecording === false)).toBe(true);
  });

  it('sorts NEWEST LAST, by occurrence time, so the case reads as a story', () => {
    const rows = mapCaseConsultations(
      [
        held('m-late', {
          startedAt: new Date('2026-07-09T10:00:00Z'),
          endedAt: new Date('2026-07-09T10:30:00Z'),
        }),
        held('m-early', {
          startedAt: new Date('2026-07-01T10:00:00Z'),
          endedAt: new Date('2026-07-01T10:30:00Z'),
        }),
        held('m-mid', {
          startedAt: new Date('2026-07-05T10:00:00Z'),
          endedAt: new Date('2026-07-05T10:30:00Z'),
        }),
      ],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(rows.map((row) => row.meetingId)).toEqual(['m-early', 'm-mid', 'm-late']);
  });

  it('falls back to scheduledStart for a row that never started, and breaks ties by id', () => {
    const at = new Date('2026-07-03T09:00:00Z');
    const rows = mapCaseConsultations(
      [meeting({ id: 'm-b', scheduledStart: at }), meeting({ id: 'm-a', scheduledStart: at })],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    expect(rows.map((row) => row.meetingId)).toEqual(['m-a', 'm-b']);
  });

  it('numbers HELD consultations 1..n and gives a CANCELLED row NO ordinal', () => {
    const rows = mapCaseConsultations(
      [
        held('m1', {
          startedAt: new Date('2026-07-01T10:00:00Z'),
          endedAt: new Date('2026-07-01T10:30:00Z'),
        }),
        meeting({
          id: 'm2',
          status: 'cancelled',
          scheduledStart: new Date('2026-07-02T10:00:00Z'),
        }),
        held('m3', {
          startedAt: new Date('2026-07-03T10:00:00Z'),
          endedAt: new Date('2026-07-03T10:30:00Z'),
        }),
      ],
      EMPTY_COUNTS,
      NOW,
      NO_ACTION
    );
    const byId = new Map(rows.map((row) => [row.meetingId, row.ordinal]));
    expect(byId.get('m1')).toBe(1);
    expect(byId.get('m2')).toBeNull();
    expect(byId.get('m3')).toBe(2);
  });

  it('returns an empty list for an empty input, without throwing', () => {
    expect(mapCaseConsultations([], EMPTY_COUNTS, NOW, NO_ACTION)).toEqual([]);
  });
});

/** Every flag here reads the raw `meeting.status`, never the derived `state` label; see the
 *  mutation-proof test at the bottom for what regressing to `state` would break. */
describe('mapCaseConsultations — row action flags (canCancel / canReschedule / canProposeReschedule)', () => {
  const FUTURE_START = new Date('2026-08-01T10:00:00Z');
  const FUTURE_END = new Date('2026-08-01T11:00:00Z');
  const CLIENT_MAY_ACT: CaseConsultationActionContext = {
    lens: 'client',
    mayAct: true,
    mayInvite: true,
  };
  const EXPERT_MAY_ACT: CaseConsultationActionContext = {
    lens: 'expert',
    mayAct: true,
    mayInvite: true,
  };

  function upcoming(over: Partial<Meeting> = {}): Meeting {
    return meeting({
      id: 'm1',
      status: 'scheduled',
      scheduledStart: FUTURE_START,
      scheduledEnd: FUTURE_END,
      ...over,
    });
  }

  it.each([
    ['scheduled', 'scheduled' as const, true],
    ['waiting_for_participants', 'waiting_for_participants' as const, false],
    ['in_progress', 'in_progress' as const, false],
    ['ended', 'ended' as const, false],
    ['cancelled', 'cancelled' as const, false],
  ])(
    'canCancel — status=%s → %s (client, capable, no live proposal)',
    (_label, status, expectedCancel) => {
      const [row] = mapCaseConsultations(
        [upcoming({ status, outcome: status === 'ended' ? 'completed' : null })],
        EMPTY_COUNTS,
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.canCancel).toBe(expectedCancel);
    }
  );

  it('a waiting_for_participants meeting folds to the scheduled LABEL yet every flag is false', () => {
    const [row] = mapCaseConsultations(
      [upcoming({ status: 'waiting_for_participants' })],
      EMPTY_COUNTS,
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.state).toBe('scheduled');
    expect(row?.canCancel).toBe(false);
    expect(row?.canReschedule).toBe(false);
    expect(row?.canProposeReschedule).toBe(false);
  });

  it('canReschedule is true for a capable CLIENT on a movable meeting, and canProposeReschedule stays false', () => {
    const [row] = mapCaseConsultations([upcoming()], EMPTY_COUNTS, NOW, CLIENT_MAY_ACT);
    expect(row?.canReschedule).toBe(true);
    expect(row?.canProposeReschedule).toBe(false);
  });

  it('canProposeReschedule is true for a capable EXPERT on a movable meeting, and canReschedule stays false', () => {
    const [row] = mapCaseConsultations([upcoming()], EMPTY_COUNTS, NOW, EXPERT_MAY_ACT);
    expect(row?.canProposeReschedule).toBe(true);
    expect(row?.canReschedule).toBe(false);
  });

  it('every flag is false when the case-level capability is false, regardless of status', () => {
    const [row] = mapCaseConsultations([upcoming()], EMPTY_COUNTS, NOW, {
      lens: 'client',
      mayAct: false,
      mayInvite: false,
    });
    expect(row?.canCancel).toBe(false);
    expect(row?.canReschedule).toBe(false);
    expect(row?.canInvite).toBe(false);
  });

  it('Ruling 2 — a live proposal drops canReschedule but leaves canCancel true', () => {
    const [row] = mapCaseConsultations(
      [upcoming()],
      { ...EMPTY_COUNTS, meetingIdsWithLiveProposal: new Set(['m1']) },
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.state).toBe('pending_reschedule');
    expect(row?.canCancel).toBe(true);
    expect(row?.canReschedule).toBe(false);
  });

  it('the join window drops canReschedule/canProposeReschedule but leaves canCancel true', () => {
    const startsInFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);
    const [row] = mapCaseConsultations(
      [upcoming({ scheduledStart: startsInFiveMinutes })],
      EMPTY_COUNTS,
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.live).toBe(true);
    expect(row?.canCancel).toBe(true);
    expect(row?.canReschedule).toBe(false);
  });

  it('canReschedule is false once the meeting has actually started, even though canCancel stays true', () => {
    const past = new Date(NOW.getTime() - 60_000);
    const [row] = mapCaseConsultations(
      [upcoming({ scheduledStart: past })],
      EMPTY_COUNTS,
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.canCancel).toBe(true);
    expect(row?.canReschedule).toBe(false);
  });

  /** MUTATION PROOF: `insideCaseJoinWindow` has no closing bound, so an UNGATED read would say
   *  `live: true` for this row forever once its `scheduledStart` is behind `now` — even though
   *  the meeting is long over. */
  it('live is false on a past HELD row, even with scheduledStart inside what would be the join window', () => {
    const justEnded = new Date(NOW.getTime() - 5 * 60_000);
    const [row] = mapCaseConsultations(
      [
        held('m1', {
          scheduledStart: justEnded,
          scheduledEnd: new Date(justEnded.getTime() + 30 * 60_000),
        }),
      ],
      EMPTY_COUNTS,
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.state).toBe('held');
    expect(row?.live).toBe(false);
  });

  it('computes scheduledMinutes from scheduled_end − scheduled_start, independent of durationMinutes', () => {
    const [row] = mapCaseConsultations([upcoming()], EMPTY_COUNTS, NOW, CLIENT_MAY_ACT);
    expect(row?.scheduledMinutes).toBe(60);
    expect(row?.durationMinutes).toBeNull();
  });

  /**
   * BAL-573 — item 17. `canInvite` truth table: 7 of the 9 `CaseConsultationStateLabel` values
   * via `STATE_FIXTURES` (a `(status, outcome)` pair each) × `mayInvite` both ways, plus
   * `pending_reschedule` and `nobody_joined` in their own cases just below — neither can be
   * reached through `(status, outcome)` alone, only through `meetingIdsWithLiveProposal` /
   * `clientSideEverPresentByMeetingId` (see `deriveCaseConsultationState`). True iff
   * `mayInvite && caseConsultationIsUpcoming(state)`.
   */
  describe('canInvite — true iff mayInvite && caseConsultationIsUpcoming(state)', () => {
    const STATE_FIXTURES: readonly [string, Partial<Meeting>][] = [
      ['scheduled', { status: 'scheduled', outcome: null }],
      ['waiting_for_participants', { status: 'waiting_for_participants', outcome: null }],
      ['in_progress', { status: 'in_progress', outcome: null }],
      ['ended+completed', { status: 'ended', outcome: 'completed' }],
      ['ended+no_show_client', { status: 'ended', outcome: 'no_show_client' }],
      ['ended+missed_call', { status: 'ended', outcome: 'missed_call' }],
      ['cancelled', { status: 'cancelled', outcome: null }],
      ['ended+NULL outcome', { status: 'ended', outcome: null }],
    ];
    const UPCOMING_LABELS: ReadonlySet<string> = new Set([
      'scheduled',
      'waiting_for_participants',
      'in_progress',
    ]);

    it.each(STATE_FIXTURES)('mayInvite=true, state=%s', (label, over) => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', ...over })],
        EMPTY_COUNTS,
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.canInvite).toBe(UPCOMING_LABELS.has(label));
    });

    it.each(STATE_FIXTURES)('mayInvite=false, state=%s ⇒ always false', (_label, over) => {
      const [row] = mapCaseConsultations([meeting({ id: 'm1', ...over })], EMPTY_COUNTS, NOW, {
        lens: 'client',
        mayAct: true,
        mayInvite: false,
      });
      expect(row?.canInvite).toBe(false);
    });

    it('the 8th state — pending_reschedule, reached only via meetingIdsWithLiveProposal — is invitable', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', status: 'scheduled', outcome: null })],
        { ...EMPTY_COUNTS, meetingIdsWithLiveProposal: new Set(['m1']) },
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.state).toBe('pending_reschedule');
      expect(row?.canInvite).toBe(true);
    });

    it('the 9th state — nobody_joined, reached only via clientSideEverPresentByMeetingId — is NOT invitable', () => {
      const [row] = mapCaseConsultations(
        [meeting({ id: 'm1', status: 'ended', outcome: 'missed_call' })],
        { ...EMPTY_COUNTS, clientSideEverPresentByMeetingId: new Map([['m1', false]]) },
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.state).toBe('nobody_joined');
      expect(row?.canInvite).toBe(false);
      expect(row?.live).toBe(false);
    });
  });

  /** BAL-573 — item 18. `guestCount` reads the batched map for upcoming rows and is FORCED to 0
   *  on a terminal row even when the map carries a number for it (the projection-boundary leak
   *  guard). */
  describe('guestCount', () => {
    it('reads the batched map for an upcoming row', () => {
      const [row] = mapCaseConsultations(
        [upcoming()],
        { ...EMPTY_COUNTS, guestCountByMeetingId: new Map([['m1', 3]]) },
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.guestCount).toBe(3);
    });

    it('defaults to 0 for an upcoming row absent from the map', () => {
      const [row] = mapCaseConsultations([upcoming()], EMPTY_COUNTS, NOW, CLIENT_MAY_ACT);
      expect(row?.guestCount).toBe(0);
    });

    it('is FORCED to 0 on a terminal (held) row, even when the map carries a number for it', () => {
      const [row] = mapCaseConsultations(
        [held('m1')],
        { ...EMPTY_COUNTS, guestCountByMeetingId: new Map([['m1', 5]]) },
        NOW,
        CLIENT_MAY_ACT
      );
      expect(row?.state).toBe('held');
      expect(row?.guestCount).toBe(0);
    });
  });

  /** MUTATION PROOF: reverting the flags to `row.state === 'scheduled'` would pass this
   *  `waiting_for_participants` meeting as cancellable/reschedulable, since its label folds to
   *  `'scheduled'`. */
  it('MUTATION PROOF — a state-based derivation would wrongly enable every flag here', () => {
    const [row] = mapCaseConsultations(
      [upcoming({ status: 'waiting_for_participants' })],
      EMPTY_COUNTS,
      NOW,
      CLIENT_MAY_ACT
    );
    expect(row?.state).toBe('scheduled');
    expect(row?.canCancel).toBe(false);
    expect(row?.canReschedule).toBe(false);
    expect(row?.canProposeReschedule).toBe(false);
  });
});
