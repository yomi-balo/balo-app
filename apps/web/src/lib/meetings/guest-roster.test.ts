import { describe, expect, it } from 'vitest';
import type { GuestForViewer } from '@balo/shared/meetings';
import { buildGuestRoster } from './guest-roster';
import { ADMITTED_NOT_ARRIVED_GRACE_MS } from './guests-poll';

/**
 * BAL-436 — the People panel's view model.
 *
 * ⚠⚠ FOUR PROPERTIES MATTER MORE THAN THE SECTIONS THEMSELVES:
 *   1. `denied` rows are DROPPED — `listLiveByMeeting` can still carry them.
 *   2. `waiting` is EMPTY unless the SERVER said `canHost`.
 *   3. `isUnverified` is true for EVERY `link` row, regardless of `party` or `admission`.
 *   4. `canResendLink` is false whenever the grace period cannot be evaluated.
 */

const NOW = Date.parse('2026-09-01T10:30:00.000Z');

function guest(overrides: Partial<GuestForViewer> & { id: string }): GuestForViewer {
  return {
    name: 'Dana',
    displayName: 'Dana',
    party: 'client',
    participationRole: 'guest',
    admission: 'pre_admitted',
    inviteChannel: 'email',
    ...overrides,
  };
}

function build(
  guests: readonly GuestForViewer[],
  options: { present?: readonly string[]; canHost?: boolean; nowMs?: number } = {}
) {
  return buildGuestRoster({
    guests,
    presentGuestIds: new Set(options.present ?? []),
    canHost: options.canHost ?? true,
    nowMs: options.nowMs ?? NOW,
  });
}

describe('buildGuestRoster — the four states', () => {
  it('puts an INVITED guest who has not joined in `invited`', () => {
    const roster = build([guest({ id: 'g1', admission: 'pre_admitted' })]);

    expect(roster.invited.map((row) => row.guest.id)).toEqual(['g1']);
    expect(roster.invited[0]?.state).toBe('invited');
    expect(roster.inCall).toEqual([]);
  });

  it('⚠ moves that SAME guest to `inCall` once Daily reports them present', () => {
    const roster = build([guest({ id: 'g1', admission: 'pre_admitted' })], { present: ['g1'] });

    expect(roster.inCall.map((row) => row.guest.id)).toEqual(['g1']);
    expect(roster.invited).toEqual([]);
  });

  it('puts an ADMITTED guest who is not present in `notArrived`', () => {
    const roster = build([guest({ id: 'g1', admission: 'admitted' })]);

    expect(roster.notArrived.map((row) => row.guest.id)).toEqual(['g1']);
    expect(roster.notArrived[0]?.state).toBe('not_arrived');
  });

  it('an ADMITTED guest who IS present is `inCall`, not `notArrived`', () => {
    const roster = build([guest({ id: 'g1', admission: 'admitted' })], { present: ['g1'] });

    expect(roster.inCall.map((row) => row.guest.id)).toEqual(['g1']);
    expect(roster.notArrived).toEqual([]);
  });

  it('puts a PENDING knock in `waiting` for a host', () => {
    const roster = build([guest({ id: 'g1', admission: 'pending', inviteChannel: 'link' })]);

    expect(roster.waiting.map((row) => row.guest.id)).toEqual(['g1']);
    expect(roster.waiting[0]?.state).toBe('waiting');
  });
});

describe('buildGuestRoster — ⚠⚠ `denied` rows are DROPPED', () => {
  it('drops a denied row from every section', () => {
    // `listLiveByMeeting` filters `deleted_at` / `revoked_at` ONLY, so a denied row can still
    // be on the payload. Rendering it would show a host somebody they already turned away.
    const roster = build([guest({ id: 'g1', admission: 'denied', inviteChannel: 'link' })]);

    expect(roster.inCall).toEqual([]);
    expect(roster.invited).toEqual([]);
    expect(roster.notArrived).toEqual([]);
    expect(roster.waiting).toEqual([]);
  });

  it('drops a denied row even when Daily somehow reports them present', () => {
    const roster = build([guest({ id: 'g1', admission: 'denied', inviteChannel: 'link' })], {
      present: ['g1'],
    });

    expect(roster.inCall).toEqual([]);
  });
});

describe('buildGuestRoster — ⚠⚠ `waiting` is gated on the SERVER verdict', () => {
  it('is EMPTY when `canHost` is false, even with knocks on the payload', () => {
    const roster = build(
      [
        guest({ id: 'g1', admission: 'pending', inviteChannel: 'link' }),
        guest({ id: 'g2', admission: 'pending', inviteChannel: 'link' }),
      ],
      { canHost: false }
    );

    expect(roster.waiting).toEqual([]);
  });

  it('⚠ a non-host does not see those knocks ANYWHERE ELSE either — they are not re-homed', () => {
    const roster = build([guest({ id: 'g1', admission: 'pending', inviteChannel: 'link' })], {
      canHost: false,
    });

    expect(roster.inCall).toEqual([]);
    expect(roster.invited).toEqual([]);
    expect(roster.notArrived).toEqual([]);
  });

  it('populates it when `canHost` is true', () => {
    const roster = build([guest({ id: 'g1', admission: 'pending', inviteChannel: 'link' })], {
      canHost: true,
    });

    expect(roster.waiting).toHaveLength(1);
  });
});

describe('buildGuestRoster — ⚠⚠ `isUnverified` keys on the CHANNEL and nothing else', () => {
  it.each([
    ['pending', 'pending' as const],
    ['admitted', 'admitted' as const],
  ])('is TRUE for a `link` row that is %s — admitting is not verifying', (_label, admission) => {
    const roster = build([guest({ id: 'g1', admission, inviteChannel: 'link' })], {
      present: [],
    });

    const row = [...roster.waiting, ...roster.notArrived][0];
    expect(row?.isUnverified).toBe(true);
  });

  it('⚠ is TRUE for a `link` row whose `party` is `expert` — the party is a PLACEHOLDER', () => {
    const roster = build([
      guest({ id: 'g1', admission: 'admitted', inviteChannel: 'link', party: 'expert' }),
    ]);

    expect(roster.notArrived[0]?.isUnverified).toBe(true);
  });

  it('is FALSE for an `email` row', () => {
    const roster = build([guest({ id: 'g1', admission: 'pre_admitted', inviteChannel: 'email' })]);

    expect(roster.invited[0]?.isUnverified).toBe(false);
  });

  it('stays TRUE for a `link` row that is in the call', () => {
    const roster = build([guest({ id: 'g1', admission: 'admitted', inviteChannel: 'link' })], {
      present: ['g1'],
    });

    expect(roster.inCall[0]?.isUnverified).toBe(true);
  });
});

describe('buildGuestRoster — `canResendLink` and its grace period', () => {
  const decidedAt = '2026-09-01T10:29:30.000Z'; // 30 seconds before NOW

  it('is FALSE before the grace period has elapsed', () => {
    const roster = build([
      guest({
        id: 'g1',
        admission: 'admitted',
        inviteChannel: 'link',
        admissionDecidedAt: decidedAt,
      }),
    ]);

    expect(roster.notArrived[0]?.canResendLink).toBe(false);
  });

  it('is TRUE once the grace period has elapsed', () => {
    const roster = build(
      [
        guest({
          id: 'g1',
          admission: 'admitted',
          inviteChannel: 'link',
          admissionDecidedAt: decidedAt,
        }),
      ],
      { nowMs: Date.parse(decidedAt) + ADMITTED_NOT_ARRIVED_GRACE_MS }
    );

    expect(roster.notArrived[0]?.canResendLink).toBe(true);
  });

  it('⚠⚠ is FALSE when `admissionDecidedAt` is ABSENT — never show an unevaluatable affordance', () => {
    const roster = build([guest({ id: 'g1', admission: 'admitted', inviteChannel: 'link' })], {
      nowMs: NOW + 10 * ADMITTED_NOT_ARRIVED_GRACE_MS,
    });

    expect(roster.notArrived[0]?.canResendLink).toBe(false);
  });

  it('⚠ is FALSE for an unparseable instant — a malformed value is not an elapsed period', () => {
    const roster = build([
      guest({
        id: 'g1',
        admission: 'admitted',
        inviteChannel: 'link',
        admissionDecidedAt: 'not-a-date',
      }),
    ]);

    expect(roster.notArrived[0]?.canResendLink).toBe(false);
  });

  it('is FALSE on every OTHER state, however old the decision', () => {
    const roster = build(
      [
        guest({ id: 'g1', admission: 'pre_admitted' }),
        guest({
          id: 'g2',
          admission: 'pending',
          inviteChannel: 'link',
          admissionDecidedAt: decidedAt,
        }),
        guest({
          id: 'g3',
          admission: 'admitted',
          inviteChannel: 'link',
          admissionDecidedAt: decidedAt,
        }),
      ],
      { present: ['g3'], nowMs: NOW + 10 * ADMITTED_NOT_ARRIVED_GRACE_MS }
    );

    expect(roster.invited[0]?.canResendLink).toBe(false);
    expect(roster.waiting[0]?.canResendLink).toBe(false);
    expect(roster.inCall[0]?.canResendLink).toBe(false);
  });
});

describe('buildGuestRoster — the whole payload at once', () => {
  it('sorts a mixed roster into its four sections without losing a row', () => {
    const roster = build(
      [
        guest({ id: 'in', admission: 'admitted', admissionDecidedAt: '2026-09-01T10:00:00.000Z' }),
        guest({ id: 'inv', admission: 'pre_admitted' }),
        guest({
          id: 'stuck',
          admission: 'admitted',
          inviteChannel: 'link',
          admissionDecidedAt: '2026-09-01T10:00:00.000Z',
        }),
        guest({ id: 'knock', admission: 'pending', inviteChannel: 'link' }),
        guest({ id: 'gone', admission: 'denied', inviteChannel: 'link' }),
      ],
      { present: ['in'] }
    );

    expect(roster.inCall.map((r) => r.guest.id)).toEqual(['in']);
    expect(roster.invited.map((r) => r.guest.id)).toEqual(['inv']);
    expect(roster.notArrived.map((r) => r.guest.id)).toEqual(['stuck']);
    expect(roster.waiting.map((r) => r.guest.id)).toEqual(['knock']);
  });

  it('handles an empty payload', () => {
    const roster = build([]);

    expect(roster).toEqual({ inCall: [], invited: [], notArrived: [], waiting: [] });
  });
});
