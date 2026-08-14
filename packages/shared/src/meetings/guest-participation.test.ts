import { describe, it, expect } from 'vitest';
import {
  computeMeetingClocks,
  guestMayReadMeeting,
  presencePartyForGuest,
  projectGuestForViewer,
  selectPrimaryMeetingContext,
  GUEST_TOKEN_TTL_AFTER_END_MS,
  MAX_LOBBY_QUEUE,
  MAX_MEETING_PARTICIPANTS,
  MEETING_CONTEXT_PRECEDENCE,
  RESERVED_BASE_PARTICIPANTS,
  type GuestForProjection,
  type MeetingContextRowLike,
  type PresenceInterval,
} from './index';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CASE_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const RELATIONSHIP_ID = '44444444-4444-4444-8444-444444444444';

describe('MEETING_CONTEXT_PRECEDENCE', () => {
  it('covers exactly the seven meeting_context_type labels', () => {
    // ⚠ EXACT KEY SET, not a superset check: the map's keys ARE the label list this
    // package restates, and `apps/api` asserts that list against `@balo/db`'s pgEnum.
    // `localeCompare` rather than a bare `.sort()` — a bare sort is a SonarCloud
    // reliability bug (implementation-defined comparator).
    expect(Object.keys(MEETING_CONTEXT_PRECEDENCE).sort((a, b) => a.localeCompare(b))).toEqual([
      'admin',
      'case',
      'package_session',
      'project_discovery',
      'project_kickoff',
      'request_interaction',
      'retainer_checkin',
    ]);
  });

  it('ranks engagement grain above request grain, and admin below both', () => {
    expect(MEETING_CONTEXT_PRECEDENCE.case).toBeGreaterThan(
      MEETING_CONTEXT_PRECEDENCE.project_discovery
    );
    expect(MEETING_CONTEXT_PRECEDENCE.request_interaction).toBeGreaterThan(
      MEETING_CONTEXT_PRECEDENCE.admin
    );
    expect(MEETING_CONTEXT_PRECEDENCE.admin).toBe(0);
  });
});

describe('selectPrimaryMeetingContext', () => {
  it('returns the single context when there is exactly one', () => {
    const result = selectPrimaryMeetingContext([{ contextType: 'case', contextId: CASE_ID }]);
    expect(result).toEqual({ ok: true, context: { contextType: 'case', contextId: CASE_ID } });
  });

  it('⚠ prefers ENGAGEMENT grain over REQUEST grain — a kickoff meeting that still carries its discovery context resolves to the ENGAGEMENT', () => {
    // THE `any-of` REJECTION, made concrete: under `any-of` the losing discovery
    // candidate would keep host rights over the kickoff meeting.
    const contexts: MeetingContextRowLike[] = [
      { contextType: 'project_discovery', contextId: REQUEST_ID },
      { contextType: 'project_kickoff', contextId: CASE_ID },
    ];
    expect(selectPrimaryMeetingContext(contexts)).toEqual({
      ok: true,
      context: { contextType: 'project_kickoff', contextId: CASE_ID },
    });
  });

  it('is order-independent', () => {
    const forwards = selectPrimaryMeetingContext([
      { contextType: 'case', contextId: CASE_ID },
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    const backwards = selectPrimaryMeetingContext([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
      { contextType: 'case', contextId: CASE_ID },
    ]);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual({ ok: true, context: { contextType: 'case', contextId: CASE_ID } });
  });

  it('⚠ FAILS CLOSED on two DISTINCT engagement-grain contexts — never picks one arbitrarily', () => {
    expect(
      selectPrimaryMeetingContext([
        { contextType: 'case', contextId: CASE_ID },
        { contextType: 'package_session', contextId: OTHER_CASE_ID },
      ])
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('fails closed on two distinct REQUEST-grain contexts too (ambiguity is judged on the top tier, whichever tier that is)', () => {
    expect(
      selectPrimaryMeetingContext([
        { contextType: 'project_discovery', contextId: REQUEST_ID },
        { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
      ])
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('does NOT call an exact duplicate ambiguous — de-duplication is by identity, not row count', () => {
    expect(
      selectPrimaryMeetingContext([
        { contextType: 'case', contextId: CASE_ID },
        { contextType: 'case', contextId: CASE_ID },
      ])
    ).toEqual({ ok: true, context: { contextType: 'case', contextId: CASE_ID } });
  });

  it('resolves to `none` for an admin-only meeting — admin is dropped, never promoted', () => {
    expect(selectPrimaryMeetingContext([{ contextType: 'admin', contextId: null }])).toEqual({
      ok: false,
      reason: 'none',
    });
  });

  it('lets a real context win over an admin context on the same meeting', () => {
    expect(
      selectPrimaryMeetingContext([
        { contextType: 'admin', contextId: null },
        { contextType: 'case', contextId: CASE_ID },
      ])
    ).toEqual({ ok: true, context: { contextType: 'case', contextId: CASE_ID } });
  });

  it('resolves to `none` for an empty context list', () => {
    expect(selectPrimaryMeetingContext([])).toEqual({ ok: false, reason: 'none' });
  });

  it('DROPS a non-admin row with a null context_id rather than promoting a corrupt subject', () => {
    // The DB CHECK makes this unrepresentable; if it ever appears, it must not become a
    // subject `resolveHostContext` would then query.
    expect(selectPrimaryMeetingContext([{ contextType: 'case', contextId: null }])).toEqual({
      ok: false,
      reason: 'none',
    });
  });

  it('never returns a subject that pairs a null id with a non-admin type', () => {
    const result = selectPrimaryMeetingContext([
      { contextType: 'case', contextId: null },
      { contextType: 'retainer_checkin', contextId: CASE_ID },
    ]);
    expect(result).toEqual({
      ok: true,
      context: { contextType: 'retainer_checkin', contextId: CASE_ID },
    });
  });
});

// ── ⚠⚠ THE MONEY RULE ─────────────────────────────────────────────────────────────────

describe('presencePartyForGuest — THE MONEY RULE', () => {
  it('maps an EXPERT-side EMAIL-channel guest to `observer`, never `expert`', () => {
    expect(presencePartyForGuest({ party: 'expert', inviteChannel: 'email' })).toBe('observer');
  });

  it('maps a CLIENT-side EMAIL-channel guest to `client` — the client party is genuinely represented', () => {
    expect(presencePartyForGuest({ party: 'client', inviteChannel: 'email' })).toBe('client');
  });

  // ── BAL-132: the `link` channel is ALWAYS an observer ──────────────────────────────
  describe('a `link`-channel guest is an observer REGARDLESS of the stored party', () => {
    /**
     * ⚠ THE STORED `party` IS A PLACEHOLDER ON THESE ROWS, NOT A RESOLVED SIDE. A bare
     * meeting URL carries no sharer identity, so `claimLobbyPlace` writes `client` only
     * because `meeting_guests.party` is NOT NULL and CHECK-narrowed to two labels. Trusting
     * it would let an expert-side colleague who was forwarded the link hold the billable
     * clock open after the real client leaves.
     */
    it.each(['client', 'expert'] as const)(
      'stored party `%s` + channel `link` ⇒ observer',
      (party) => {
        expect(presencePartyForGuest({ party, inviteChannel: 'link' })).toBe('observer');
      }
    );

    it('DIFFERS from the email channel for the SAME stored party — the channel is load-bearing', () => {
      // If this ever comes out equal, the channel argument has stopped being read and the
      // over-billing path is open again. `client` is the only party for which the two
      // channels disagree, which is exactly why it is the one worth asserting.
      expect(presencePartyForGuest({ party: 'client', inviteChannel: 'email' })).not.toBe(
        presencePartyForGuest({ party: 'client', inviteChannel: 'link' })
      );
    });
  });

  /**
   * The two scenarios from the plan's D7, PINNED AS NUMBERS. A 60-minute call in which an
   * agency colleague (an expert-side GUEST) sits in for the whole hour while the
   * DELIVERING expert is present only 10→20.
   */
  describe('the D7 clock scenarios, pinned as numbers', () => {
    const T0 = new Date('2026-09-01T10:00:00.000Z');
    const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
    const MINUTE = 60_000;

    /** The delivering expert (10→20) and the booking client (0→60). Unchanged in both runs. */
    const BASE_INTERVALS: PresenceInterval[] = [
      { party: 'expert', joinedAt: at(10), leftAt: at(20) },
      { party: 'client', joinedAt: at(0), leftAt: at(60) },
    ];

    it('CORRECT — the expert-side guest as `observer`: expertPresentMs = 10 min, billableMs = 10 min', () => {
      const guestParty = presencePartyForGuest({ party: 'expert', inviteChannel: 'email' });
      const clocks = computeMeetingClocks(
        [...BASE_INTERVALS, { party: guestParty, joinedAt: at(0), leftAt: at(60) }],
        at(60)
      );

      expect(guestParty).toBe('observer');
      expect(clocks.expertPresentMs).toBe(10 * MINUTE);
      expect(clocks.billableMs).toBe(10 * MINUTE);
      expect(clocks.billableStartedAt?.toISOString()).toBe(at(10).toISOString());
    });

    it('⚠ THE BUG THIS RULE PREVENTS — the same guest written as `expert`: expertPresentMs = 60 min and the billable span is ANCHORED ON THE GUEST', () => {
      // NOT how production must ever write it. Pinned so the cost of getting it wrong is a
      // number in the repo rather than a paragraph: 50 extra billable minutes on one call.
      const clocks = computeMeetingClocks(
        [...BASE_INTERVALS, { party: 'expert', joinedAt: at(0), leftAt: at(60) }],
        at(60)
      );

      expect(clocks.expertPresentMs).toBe(60 * MINUTE);
      expect(clocks.billableMs).toBe(60 * MINUTE);
      expect(clocks.billableStartedAt?.toISOString()).toBe(at(0).toISOString());
      // The client would be billed for 50 minutes of a guest's time.
      expect(clocks.billableMs - 10 * MINUTE).toBe(50 * MINUTE);
    });

    it('a CLIENT-side guest keeps the billable clock running after the booker drops', () => {
      // The other direction of the same rule: mapping a client-side guest to `client` is
      // deliberate, because the client party really is still in the room.
      const clocks = computeMeetingClocks(
        [
          { party: 'expert', joinedAt: at(0), leftAt: at(60) },
          { party: 'client', joinedAt: at(0), leftAt: at(5) },
          {
            party: presencePartyForGuest({ party: 'client', inviteChannel: 'email' }),
            joinedAt: at(0),
            leftAt: at(60),
          },
        ],
        at(60)
      );
      expect(clocks.billableMs).toBe(60 * MINUTE);
    });
  });
});

// ── D6: the recorded grant's read predicate ───────────────────────────────────────────

describe('guestMayReadMeeting', () => {
  const MEETING_A = 'meeting-a';
  const MEETING_B = 'meeting-b';

  it('a `meeting`-scoped guest reads their own meeting', () => {
    expect(
      guestMayReadMeeting({
        guestAccessScope: 'meeting',
        guestMeetingId: MEETING_A,
        targetMeetingId: MEETING_A,
        targetSharesGuestEngagement: true,
      })
    ).toBe(true);
  });

  it('a `meeting`-scoped guest is REFUSED a sibling meeting even inside the same engagement', () => {
    expect(
      guestMayReadMeeting({
        guestAccessScope: 'meeting',
        guestMeetingId: MEETING_A,
        targetMeetingId: MEETING_B,
        targetSharesGuestEngagement: true,
      })
    ).toBe(false);
  });

  it('an `engagement`-scoped guest reads a sibling meeting in the same envelope', () => {
    expect(
      guestMayReadMeeting({
        guestAccessScope: 'engagement',
        guestMeetingId: MEETING_A,
        targetMeetingId: MEETING_B,
        targetSharesGuestEngagement: true,
      })
    ).toBe(true);
  });

  it('an `engagement`-scoped guest is REFUSED a meeting outside the envelope', () => {
    expect(
      guestMayReadMeeting({
        guestAccessScope: 'engagement',
        guestMeetingId: MEETING_A,
        targetMeetingId: MEETING_B,
        targetSharesGuestEngagement: false,
      })
    ).toBe(false);
  });

  it('⚠ IS RETROSPECTIVE — a consultation held BEFORE the invite is readable, and no date input exists to change that', () => {
    // There is no temporal field to pass. That IS the decision: the input type makes an
    // "only meetings after invitedAt" rule unexpressible without a deliberate API change,
    // and the disclosure sentence in the invite UI is what makes the grant consented.
    expect(
      guestMayReadMeeting({
        guestAccessScope: 'engagement',
        guestMeetingId: MEETING_A,
        targetMeetingId: 'a-meeting-held-months-before-the-invite',
        targetSharesGuestEngagement: true,
      })
    ).toBe(true);
  });

  it('is a pure function of its four inputs — repeated calls at different wall-clock instants agree', () => {
    const input = {
      guestAccessScope: 'engagement',
      guestMeetingId: MEETING_A,
      targetMeetingId: MEETING_B,
      targetSharesGuestEngagement: true,
    } as const;
    expect(guestMayReadMeeting(input)).toBe(guestMayReadMeeting(input));
  });
});

// ── §8: counterparty concealment ──────────────────────────────────────────────────────

describe('projectGuestForViewer — names cross the party boundary, addresses NEVER', () => {
  const CLIENT_GUEST: GuestForProjection = {
    id: 'guest-1',
    email: 'sam@northwind.example',
    emailDomain: 'northwind.example',
    name: 'Sam Rivera',
    party: 'client',
    participationRole: 'guest',
    accessScope: 'engagement',
    admission: 'pre_admitted',
    inviteChannel: 'email',
    admissionDecidedAt: null,
  };

  const EXPERT_GUEST: GuestForProjection = {
    id: 'guest-2',
    email: 'jo@cloudpeak.example',
    emailDomain: 'cloudpeak.example',
    name: null,
    party: 'expert',
    participationRole: 'guest',
    accessScope: 'meeting',
    admission: 'pre_admitted',
    inviteChannel: 'email',
    admissionDecidedAt: null,
  };

  it('SAME party — the viewer sees the address, the domain and the scope', () => {
    const projected = projectGuestForViewer(CLIENT_GUEST, 'client');
    expect(projected).toEqual({
      id: 'guest-1',
      email: 'sam@northwind.example',
      emailDomain: 'northwind.example',
      name: 'Sam Rivera',
      displayName: 'Sam Rivera',
      party: 'client',
      participationRole: 'guest',
      admission: 'pre_admitted',
      accessScope: 'engagement',
      inviteChannel: 'email',
    });
  });

  it('⚠ CROSS party — `email`, `emailDomain` and `accessScope` KEYS ARE ABSENT, not null', () => {
    const projected = projectGuestForViewer(CLIENT_GUEST, 'expert');

    // Key ABSENCE, not `=== null`: `JSON.stringify` drops an absent key entirely, so no
    // future client can render an empty placeholder where an address would be.
    expect('email' in projected).toBe(false);
    expect('emailDomain' in projected).toBe(false);
    expect('accessScope' in projected).toBe(false);
    expect(Object.keys(projected).sort((a, b) => a.localeCompare(b))).toEqual([
      'admission',
      'displayName',
      'id',
      // BAL-436 — PROVENANCE, present for every viewer. It is a fact about how the row was
      // created, never a fact about the address.
      'inviteChannel',
      'name',
      'participationRole',
      'party',
    ]);
  });

  it('cross-party serialisation carries no address-shaped key at all', () => {
    const serialised = JSON.stringify(projectGuestForViewer(CLIENT_GUEST, 'expert'));
    // ⚠ THE **KEY** FORM (`"email":`), NOT THE BARE WORD. BAL-436 added `inviteChannel`,
    // whose VALUE is the literal `"email"` on this row — a bare `not.toContain('email')`
    // would now fail on a field that carries no address at all. The `:` is what makes this
    // assert "there is no email PROPERTY", which is the thing the projection rule forbids.
    expect(serialised).not.toContain('"email":');
    expect(serialised).not.toContain('"emailDomain":');
    expect(serialised).not.toContain('northwind.example');
    expect(serialised).toContain('Sam Rivera');
  });

  it('the NAME does cross the boundary — concealment is of the address, not of the person', () => {
    expect(projectGuestForViewer(CLIENT_GUEST, 'expert').name).toBe('Sam Rivera');
  });

  it('⚠ a nameless guest falls back to the literal `Guest` across the boundary — NEVER the email local part', () => {
    const projected = projectGuestForViewer(EXPERT_GUEST, 'client');
    expect(projected.displayName).toBe('Guest');
    expect(projected.displayName).not.toContain('jo');
    expect('email' in projected).toBe(false);
  });

  it('a nameless guest falls back to the address for a SAME-party viewer, who can already see it', () => {
    expect(projectGuestForViewer(EXPERT_GUEST, 'expert').displayName).toBe('jo@cloudpeak.example');
  });

  it('omits `emailDomain` for a same-party guest whose column is null (absence always means "not applicable", never "withheld")', () => {
    const projected = projectGuestForViewer({ ...CLIENT_GUEST, emailDomain: null }, 'client');
    expect('emailDomain' in projected).toBe(false);
    expect(projected.email).toBe('sam@northwind.example');
  });

  it('carries party, participationRole and admission in BOTH directions', () => {
    for (const projected of [
      projectGuestForViewer(CLIENT_GUEST, 'client'),
      projectGuestForViewer(CLIENT_GUEST, 'expert'),
    ]) {
      expect(projected.party).toBe('client');
      expect(projected.participationRole).toBe('guest');
      expect(projected.admission).toBe('pre_admitted');
    }
  });

  it('projects a delegate without leaking the address cross-party', () => {
    const delegate: GuestForProjection = { ...CLIENT_GUEST, participationRole: 'delegate' };
    const projected = projectGuestForViewer(delegate, 'expert');
    expect(projected.participationRole).toBe('delegate');
    expect('email' in projected).toBe(false);
  });

  it('carries `inviteChannel` on EVERY projection, both directions', () => {
    expect(projectGuestForViewer(CLIENT_GUEST, 'client').inviteChannel).toBe('email');
    expect(projectGuestForViewer(CLIENT_GUEST, 'expert').inviteChannel).toBe('email');
  });

  it('omits `admissionDecidedAt` — not null — when the column is null', () => {
    expect('admissionDecidedAt' in projectGuestForViewer(CLIENT_GUEST, 'client')).toBe(false);
    expect('admissionDecidedAt' in projectGuestForViewer(CLIENT_GUEST, 'expert')).toBe(false);
  });

  it('serialises `admissionDecidedAt` as an ISO instant when the column is set', () => {
    const decided: GuestForProjection = {
      ...CLIENT_GUEST,
      admission: 'admitted',
      admissionDecidedAt: new Date('2026-09-01T10:05:00.000Z'),
    };
    expect(projectGuestForViewer(decided, 'client').admissionDecidedAt).toBe(
      '2026-09-01T10:05:00.000Z'
    );
  });
});

/**
 * BAL-436 — ⚠⚠ THE `link` CHANNEL SHORT-CIRCUITS THE PARTY RULE.
 *
 * `claimLobbyPlace` writes the NOT-NULL PLACEHOLDER `party = 'client'`, so before this arm a
 * client-side host saw a stranger's SELF-DECLARED ADDRESS rendered as their `displayName`,
 * while an expert-side host of the same meeting saw `'Guest'`. Two hosts, one stranger, two
 * identities — and the client-side one was an attacker-chosen string presented as a name.
 */
describe('projectGuestForViewer — the `link` channel has an EMPTY entitled set', () => {
  const KNOCKER: GuestForProjection = {
    id: 'guest-3',
    email: 'stranger@somewhere.example',
    emailDomain: 'somewhere.example',
    name: 'Taylor Wu',
    // ⚠ THE PLACEHOLDER. `claimLobbyPlace` writes this because the column is NOT NULL, not
    // because a side was resolved.
    party: 'client',
    participationRole: 'guest',
    accessScope: 'meeting',
    admission: 'pending',
    inviteChannel: 'link',
    admissionDecidedAt: null,
  };

  it.each([
    ['client', 'client' as const],
    ['expert', 'expert' as const],
  ])(
    '⚠ a %s-side viewer gets NO email, NO domain and NO accessScope — asserted as key ABSENCE',
    (_label, viewerParty) => {
      const projected = projectGuestForViewer(KNOCKER, viewerParty);
      expect('email' in projected).toBe(false);
      expect('emailDomain' in projected).toBe(false);
      expect('accessScope' in projected).toBe(false);
    }
  );

  it('⚠⚠ BOTH hosts of one meeting see the IDENTICAL projection for one stranger', () => {
    expect(projectGuestForViewer(KNOCKER, 'client')).toEqual(
      projectGuestForViewer(KNOCKER, 'expert')
    );
  });

  it('⚠⚠ `displayName` NEVER falls back to the self-declared address', () => {
    const nameless: GuestForProjection = { ...KNOCKER, name: null };
    for (const viewerParty of ['client', 'expert'] as const) {
      const projected = projectGuestForViewer(nameless, viewerParty);
      expect(projected.displayName).toBe('Guest');
      expect(projected.displayName).not.toContain('@');
      expect(projected.displayName).not.toContain('stranger');
    }
  });

  it('the self-declared NAME still crosses — it is what the host decides on', () => {
    expect(projectGuestForViewer(KNOCKER, 'expert').displayName).toBe('Taylor Wu');
    expect(projectGuestForViewer(KNOCKER, 'expert').name).toBe('Taylor Wu');
  });

  it('the serialised payload contains no address substring at all, for either viewer', () => {
    for (const viewerParty of ['client', 'expert'] as const) {
      const serialised = JSON.stringify(projectGuestForViewer(KNOCKER, viewerParty));
      expect(serialised).not.toContain('stranger@somewhere.example');
      expect(serialised).not.toContain('somewhere.example');
    }
  });

  it('marks the row as `link` so a consumer can badge it UNVERIFIED without deriving it', () => {
    expect(projectGuestForViewer(KNOCKER, 'client').inviteChannel).toBe('link');
  });

  it('⚠ an ADMITTED link row still has the empty entitled set — admitting is not verifying', () => {
    const admitted: GuestForProjection = {
      ...KNOCKER,
      admission: 'admitted',
      admissionDecidedAt: new Date('2026-09-01T10:05:00.000Z'),
    };
    const projected = projectGuestForViewer(admitted, 'client');
    expect('email' in projected).toBe(false);
    expect(projected.inviteChannel).toBe('link');
    expect(projected.admissionDecidedAt).toBe('2026-09-01T10:05:00.000Z');
  });
});

describe('participation constants', () => {
  it('caps a meeting at 10 participants with 2 seats reserved for the two principals', () => {
    expect(MAX_MEETING_PARTICIPANTS).toBe(10);
    expect(RESERVED_BASE_PARTICIPANTS).toBe(2);
  });

  it('leaves 8 invitable guest seats', () => {
    expect(MAX_MEETING_PARTICIPANTS - RESERVED_BASE_PARTICIPANTS).toBe(8);
  });

  it('gives a guest link 7 days past the meeting end', () => {
    expect(GUEST_TOKEN_TTL_AFTER_END_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(GUEST_TOKEN_TTL_AFTER_END_MS).toBe(604_800_000);
  });

  /**
   * ⚠⚠ BAL-132 — THE QUEUE IS A SEPARATE RESOURCE FROM THE ROOM, AND THAT IS THE FIX.
   *
   * The lobby's first cut counted a `pending` knock against the PARTICIPANT cap, on the same
   * counter `inviteGuests` uses — so filling the queue from a forwarded URL also took away the
   * HOST's ability to invite anyone by email, permanently, with no way to clear it (denying did
   * not help; the denied row kept its seat). Bounding them independently means a knock flood can
   * exhaust the QUEUE and nothing else.
   */
  it('⚠ bounds the anonymous knock queue SEPARATELY from the participant cap', () => {
    expect(MAX_LOBBY_QUEUE).toBe(25);
    // ⚠ HIGHER THAN THE ROOM CAP ON PURPOSE: a host may legitimately deny several people
    // (wrong meeting, forwarded to the wrong team) and still admit a full room afterwards, so a
    // queue bound at 10 would be reachable in normal use.
    expect(MAX_LOBBY_QUEUE).toBeGreaterThan(MAX_MEETING_PARTICIPANTS);
  });
});
