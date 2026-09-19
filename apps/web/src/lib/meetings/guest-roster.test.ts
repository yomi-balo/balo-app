import { describe, expect, it } from 'vitest';
import type { GuestForViewer, MeetingGuestSide } from '@balo/shared/meetings';
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
  options: {
    present?: readonly string[];
    canHost?: boolean;
    nowMs?: number;
    viewerSide?: MeetingGuestSide;
  } = {}
) {
  return buildGuestRoster({
    guests,
    presentGuestIds: new Set(options.present ?? []),
    canHost: options.canHost ?? true,
    viewerSide: options.viewerSide ?? 'client',
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

// ── BAL-476 — `canRemove` ─────────────────────────────────────────────────────────────────

describe('buildGuestRoster — canRemove (BAL-476)', () => {
  /** One guest in each of the four sections, split across both parties. */
  const EVERY_SECTION: readonly GuestForViewer[] = [
    guest({ id: 'in-call-client', admission: 'admitted', party: 'client' }),
    guest({ id: 'in-call-expert', admission: 'admitted', party: 'expert' }),
    guest({ id: 'invited-client', admission: 'pre_admitted', party: 'client' }),
    guest({ id: 'invited-expert', admission: 'pre_admitted', party: 'expert' }),
    guest({ id: 'not-arrived-client', admission: 'admitted', party: 'client' }),
    guest({ id: 'not-arrived-expert', admission: 'admitted', party: 'expert' }),
    guest({ id: 'waiting-client', admission: 'pending', party: 'client' }),
    guest({ id: 'waiting-expert', admission: 'pending', party: 'expert' }),
  ];

  function allRows(viewerSide: MeetingGuestSide) {
    const roster = build(EVERY_SECTION, {
      present: ['in-call-client', 'in-call-expert'],
      canHost: true,
      viewerSide,
    });
    return [...roster.inCall, ...roster.invited, ...roster.notArrived, ...roster.waiting];
  }

  it.each(['client', 'expert'] as const)(
    '⚠ viewerSide %s: canRemove is true IFF guest.party === viewerSide, across ALL FOUR sections',
    (viewerSide) => {
      const rows = allRows(viewerSide);

      // ⚠ A LENGTH ASSERTION SO THE PREDICATE BELOW CANNOT PASS VACUOUSLY.
      expect(rows).toHaveLength(EVERY_SECTION.length);
      expect(rows.filter((row) => row.canRemove)).toHaveLength(EVERY_SECTION.length / 2);
      for (const row of rows) {
        expect(row.canRemove).toBe(row.guest.party === viewerSide);
      }
    }
  );

  it('⚠ a `waiting` row still CARRIES canRemove — the section simply never renders the control', () => {
    const roster = build([guest({ id: 'w1', admission: 'pending', party: 'client' })], {
      canHost: true,
      viewerSide: 'client',
    });

    expect(roster.waiting).toHaveLength(1);
    expect(roster.waiting[0]?.canRemove).toBe(true);
  });

  it('⚠ canRemove is INDEPENDENT of canHost — the two gates are different rules', () => {
    const roster = build([guest({ id: 'g1', admission: 'pre_admitted', party: 'client' })], {
      canHost: false,
      viewerSide: 'client',
    });

    expect(roster.invited).toHaveLength(1);
    expect(roster.invited[0]?.canRemove).toBe(true);
  });
});

// ── BAL-476 (second review round) — canRemove is CHANNEL-FIRST ───────────────────────────

/**
 * ⚠⚠ THE PANEL MIRRORS THE ROUTE'S RULE, NOT A SIMPLER ONE. A `link` row's `party` is the
 * NOT-NULL PLACEHOLDER `claimLobbyPlace` writes; `@balo/shared/meetings` forbids deriving
 * same-party entitlement from it, so the question for those rows is `canHost` — exactly as it is
 * for admit/deny. These are COURTESY gates: the enforcement is server-side and is asserted in
 * `apps/api/src/services/meetings/guest-participation.test.ts`.
 */
describe('buildGuestRoster — canRemove is channel-first (BAL-476)', () => {
  const LINK_GUEST = guest({ id: 'link-1', inviteChannel: 'link', party: 'client' });
  const EMAIL_GUEST = guest({ id: 'email-1', inviteChannel: 'email', party: 'client' });

  it('⚠⚠ a LINK row follows canHost, NOT the placeholder party', () => {
    const asHost = build([LINK_GUEST], { canHost: true, viewerSide: 'expert' });
    expect(asHost.invited).toHaveLength(1);
    // ⚠ The placeholder says `client` and the viewer is `expert` — same-party would say NO.
    expect(asHost.invited[0]?.canRemove).toBe(true);

    const asNonHost = build([LINK_GUEST], { canHost: false, viewerSide: 'client' });
    expect(asNonHost.invited).toHaveLength(1);
    // ⚠ The placeholder MATCHES the viewer here — same-party would say YES.
    expect(asNonHost.invited[0]?.canRemove).toBe(false);
  });

  it('⚠ an EMAIL row follows SAME-PARTY, and canHost does not move it', () => {
    const matching = build([EMAIL_GUEST], { canHost: false, viewerSide: 'client' });
    expect(matching.invited).toHaveLength(1);
    expect(matching.invited[0]?.canRemove).toBe(true);

    const crossParty = build([EMAIL_GUEST], { canHost: true, viewerSide: 'expert' });
    expect(crossParty.invited).toHaveLength(1);
    expect(crossParty.invited[0]?.canRemove).toBe(false);
  });

  it('⚠ the two rules DISAGREE on the same payload — which is the whole point', () => {
    const roster = build([LINK_GUEST, EMAIL_GUEST], { canHost: true, viewerSide: 'expert' });

    expect(roster.invited).toHaveLength(2);
    const byId = new Map(roster.invited.map((row) => [row.guest.id, row.canRemove]));
    expect(byId.get('link-1')).toBe(true);
    expect(byId.get('email-1')).toBe(false);
  });
});
