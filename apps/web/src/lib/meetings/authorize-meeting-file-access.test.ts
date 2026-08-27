import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@balo/shared/testing';
import type { MeetingGuestSubject } from './resolve-meeting-guest';

vi.mock('server-only', () => ({}));

const {
  mockMeetingFindById,
  mockListContexts,
  mockResolveOwner,
  mockGetMemberRole,
  mockFindProfileById,
  mockRelationshipFindById,
  mockListByRequest,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListContexts: vi.fn(),
  mockResolveOwner: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockListByRequest: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: (...args: unknown[]) => mockMeetingFindById(...args) },
  meetingContextsRepository: { listByMeeting: (...args: unknown[]) => mockListContexts(...args) },
  resolveMeetingContextOwner: (...args: unknown[]) => mockResolveOwner(...args),
  partyMembershipsRepository: {
    getMemberRole: (...args: unknown[]) => mockGetMemberRole(...args),
  },
  expertsRepository: { findProfileById: (...args: unknown[]) => mockFindProfileById(...args) },
  requestExpertRelationshipsRepository: {
    findById: (...args: unknown[]) => mockRelationshipFindById(...args),
    listByRequest: (...args: unknown[]) => mockListByRequest(...args),
  },
}));

import { authorizeMeetingFileAccess } from './authorize-meeting-file-access';
import { log } from '@/lib/logging';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const AGENCY_ID = 'd0000000-0000-4000-8000-000000000004';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const REQUEST_ID = 'f0000000-0000-4000-8000-000000000006';
const RELATIONSHIP_ID = 'f0000000-0000-4000-8000-000000000007';
const OTHER_EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-00000000000c';
const OTHER_ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000000e';
const GUEST_MEETING_ID = 'a0000000-0000-4000-8000-000000000101';
const GUEST_ID = 'a0000000-0000-4000-8000-000000000201';

const CLIENT_USER_ID = 'user-client';
const EXPERT_USER_ID = 'user-expert';
const COLLEAGUE_USER_ID = 'user-colleague';
const STRANGER_USER_ID = 'user-stranger';

/** ⚠ ONE literal for every denial shape. Asserted by identity throughout. */
const NOT_FOUND = { ok: false, code: 'meeting_not_found' };

const MEETING = { id: MEETING_ID, status: 'scheduled' };
const CONTEXT_ROW = { contextType: 'case', contextId: ENGAGEMENT_ID };
const SUBJECT = { contextType: 'case', contextId: ENGAGEMENT_ID };

function member(userId: string): { kind: 'member'; userId: string } {
  return { kind: 'member', userId };
}

/** A `MeetingGuestSubject`-shaped actor for the guest arm. */
function guestActor(
  overrides: {
    guestId?: string;
    accessScope?: 'meeting' | 'engagement';
    guestMeetingId?: string;
    side?: 'client' | 'expert';
    admission?: 'pre_admitted' | 'pending' | 'admitted' | 'denied';
  } = {}
): { kind: 'guest'; guest: MeetingGuestSubject } {
  return {
    kind: 'guest',
    guest: {
      guest: {
        id: overrides.guestId ?? GUEST_ID,
        accessScope: overrides.accessScope ?? 'meeting',
      },
      meeting: { id: overrides.guestMeetingId ?? GUEST_MEETING_ID, status: 'scheduled' },
      side: overrides.side ?? 'client',
      // ⚠ F1 (fix-round-1) — defaults to a HELD SEAT so every pre-existing test (written before
      // the admission gate existed) keeps exercising the SCOPE rule, not the admission one. The
      // dedicated admission tests below opt IN to `pending`/`denied` explicitly.
      admission: overrides.admission ?? 'admitted',
    } as unknown as MeetingGuestSubject,
  };
}

/** An AGENCY-based expert profile by default; pass `agencyId: null` for an independent one. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXPERT_PROFILE_ID,
    userId: EXPERT_USER_ID,
    agencyId: AGENCY_ID,
    ...overrides,
  };
}

/** The `reason` field of the most recent denial `log.warn`. */
function lastDenialReason(): unknown {
  const warn = vi.mocked(log.warn);
  const call = warn.mock.calls.at(-1);
  const fields = call?.[1] as Record<string, unknown> | undefined;
  return fields?.reason;
}

describe('authorizeMeetingFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMeetingFindById.mockResolvedValue(MEETING);
    mockListContexts.mockResolvedValue([CONTEXT_ROW]);
    mockResolveOwner.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockGetMemberRole.mockResolvedValue(undefined);
    mockFindProfileById.mockResolvedValue(undefined);
    // ⚠ EVIDENCE, NOT ABSENCE — the DEFAULT is "no relationship row", which must leave the
    // request-grain arms UNGATED. Every decline test opts IN to a row.
    mockRelationshipFindById.mockResolvedValue(undefined);
    mockListByRequest.mockResolvedValue([]);
  });

  describe('client arm — membership axis, company scope, PARTICIPATE', () => {
    it('resolves a live company member onto the client side', async () => {
      mockGetMemberRole.mockResolvedValue('member');
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual({
        ok: true,
        viewer: 'member',
        side: 'client',
        meeting: MEETING,
        subject: SUBJECT,
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, CLIENT_USER_ID);
    });

    it('resolves an owner via the capability, never a role comparison', async () => {
      mockGetMemberRole.mockResolvedValue('owner');
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'client' });
    });

    it('denies a live member whose role lacks PARTICIPATE, and never falls through to the expert arm', async () => {
      mockGetMemberRole.mockResolvedValue('not_a_real_role');
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('no_capability');
      // The two arms can never both fire — a company member is a client, full stop.
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });
  });

  describe('expert arm — the ADR-1046 §7 VISIBILITY rule', () => {
    it('resolves an INDEPENDENT expert with NO agency lookup at all', async () => {
      mockFindProfileById.mockResolvedValue(profile({ agencyId: null }));
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(EXPERT_USER_ID),
      });
      expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      // ⚠ Exactly ONE membership read (the company arm). The agency lookup must not happen.
      expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
      expect(mockGetMemberRole).not.toHaveBeenCalledWith(
        'agency',
        expect.anything(),
        expect.anything()
      );
    });

    it('resolves the DELIVERING expert of an agency profile without an agency lookup', async () => {
      mockFindProfileById.mockResolvedValue(profile());
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(EXPERT_USER_ID),
      });
      expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠⚠ THE TEST THAT PROVES THE AXIS CHOICE. An agency colleague whose role is `expert`
     * holds NO engagement-axis token — the act-axis holder set is the delivering expert plus
     * agency owner/admin. Sharing and reading a file is VISIBILITY, not an act, so this
     * person MUST be allowed. If this test ever fails, the gate has been "aligned" with
     * `apps/api`'s act-axis gate, which ADR-1046 §7 forbids.
     */
    it('ALLOWS an agency colleague whose agency role is `expert` (visibility, not act)', async () => {
      mockFindProfileById.mockResolvedValue(profile());
      mockGetMemberRole.mockImplementation((scope: unknown) =>
        Promise.resolve(scope === 'agency' ? 'expert' : undefined)
      );
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(COLLEAGUE_USER_ID),
      });
      expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, COLLEAGUE_USER_ID);
    });

    it('allows an agency owner and an agency admin too (membership EXISTING grants)', async () => {
      mockFindProfileById.mockResolvedValue(profile());
      for (const agencyRole of ['owner', 'admin']) {
        mockGetMemberRole.mockImplementation((scope: unknown) =>
          Promise.resolve(scope === 'agency' ? agencyRole : undefined)
        );
        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(COLLEAGUE_USER_ID),
        });
        expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      }
    });

    it('denies a non-member of the agency (cross-tenant)', async () => {
      mockFindProfileById.mockResolvedValue(profile());
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(STRANGER_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('cross_tenant');
    });

    it('denies when the expert profile no longer resolves', async () => {
      mockFindProfileById.mockResolvedValue(undefined);
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(EXPERT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('cross_tenant');
    });

    /**
     * A `match`-routed `project_discovery` names NOBODY. The client arm still resolves (the
     * request carries the company); the expert arm must short-circuit on the null profile id
     * rather than querying it.
     */
    it('short-circuits the expert arm for a match-routed discovery (expertProfileId === null)', async () => {
      mockResolveOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(STRANGER_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });

    it('still resolves the CLIENT arm for a match-routed discovery', async () => {
      mockResolveOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });
      mockGetMemberRole.mockResolvedValue('member');
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toMatchObject({
        ok: true,
        viewer: 'member',
        side: 'client',
        expertProfileId: null,
      });
    });
  });

  /**
   * ⚠⚠ THE DECLINE GATE — (c). On the TWO REQUEST-GRAIN context types only.
   *
   * `project_requests.expert_profile_id` SURVIVES A DECLINE FOREVER (the CHECK forbids
   * nulling it while `send_to='direct'`), so without this gate a declined expert AND THEIR
   * WHOLE AGENCY would keep read and upload on that meeting's files indefinitely — while
   * `apps/api`'s `resolveHostContext` denies exactly those people on exactly that meeting.
   *
   * Every case below goes through the ONE shipped predicate `relationshipDeniesHosting`;
   * these tests assert the WIRING (which grain reads which row, and that absence does not
   * deny), never a second definition of "declined".
   */
  describe('decline gate — the two REQUEST-GRAIN arms (c)', () => {
    /** A `request_expert_relationships` row as the shared predicate sees it. */
    function relationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: RELATIONSHIP_ID,
        projectRequestId: REQUEST_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        status: 'invited',
        declinedAt: null,
        ...overrides,
      };
    }

    /** Point the gate at a request-grain context and make the actor expert-side. */
    function useContext(contextType: 'project_discovery' | 'request_interaction'): void {
      const contextId = contextType === 'project_discovery' ? REQUEST_ID : RELATIONSHIP_ID;
      mockListContexts.mockResolvedValue([{ contextType, contextId }]);
      mockFindProfileById.mockResolvedValue(profile());
    }

    describe.each([
      { contextType: 'project_discovery' as const, contextId: REQUEST_ID },
      { contextType: 'request_interaction' as const, contextId: RELATIONSHIP_ID },
    ])('$contextType', ({ contextType, contextId }) => {
      /** Seed the one live relationship row this arm's grain will look up. */
      function seedRelationship(overrides: Record<string, unknown> = {}): void {
        mockRelationshipFindById.mockResolvedValue(relationship(overrides));
        mockListByRequest.mockResolvedValue([relationship(overrides)]);
      }

      it('DENIES the delivering expert once the relationship is declined', async () => {
        useContext(contextType);
        seedRelationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00Z') });

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('declined_relationship');
      });

      /**
       * ⚠ THE WHOLE AGENCY GOES WITH THEM. The width of the visibility rule decides WHICH
       * PEOPLE stand on the expert side; it does not keep that side alive after a decline.
       */
      it('DENIES the agency colleague too — the gate covers the whole arm', async () => {
        useContext(contextType);
        seedRelationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00Z') });
        mockGetMemberRole.mockImplementation((scope: unknown) =>
          Promise.resolve(scope === 'agency' ? 'expert' : undefined)
        );

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(COLLEAGUE_USER_ID),
        });

        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('declined_relationship');
      });

      /**
       * ⚠ BOTH REPRESENTATIONS, CHECKED INSIDE THE SHARED PREDICATE. A `declinedAt` stamp
       * with a stale label — a partial write, a manual backfill — still denies. This is here
       * to prove the gate consults the predicate rather than comparing `status` itself.
       */
      it('DENIES on a `declinedAt` stamp even when the status label disagrees', async () => {
        useContext(contextType);
        seedRelationship({ status: 'invited', declinedAt: new Date('2026-08-01T00:00:00Z') });

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('declined_relationship');
      });

      it('ALLOWS a live, NOT-declined relationship', async () => {
        useContext(contextType);
        seedRelationship({ status: 'proposal_submitted', declinedAt: null });

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      });

      /**
       * ⚠⚠ EVIDENCE, NOT ABSENCE — PRESERVED VERBATIM FROM THE SHARED PREDICATE'S CONTRACT.
       * NO relationship row leaves the arm UNGATED: on a `direct` request the exploratory
       * call legitimately PRECEDES any formal invite, so "no relationship yet" is the normal
       * early state and must never deny. Do not "tighten" this.
       */
      it('ALLOWS when NO relationship row exists at all (absence never denies)', async () => {
        useContext(contextType);
        mockRelationshipFindById.mockResolvedValue(undefined);
        mockListByRequest.mockResolvedValue([]);

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
      });

      it('reads the relationship at this arms OWN grain', async () => {
        useContext(contextType);
        seedRelationship();

        await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        const byId = contextType === 'request_interaction';
        expect(byId ? mockRelationshipFindById : mockListByRequest).toHaveBeenCalledWith(contextId);
        expect(byId ? mockListByRequest : mockRelationshipFindById).not.toHaveBeenCalled();
      });

      /** The CLIENT arm is on the membership axis and is untouched by a decline. */
      it('never gates the CLIENT arm, declined or not', async () => {
        useContext(contextType);
        seedRelationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00Z') });
        mockGetMemberRole.mockResolvedValue('member');

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(CLIENT_USER_ID),
        });

        expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'client' });
        expect(mockRelationshipFindById).not.toHaveBeenCalled();
        expect(mockListByRequest).not.toHaveBeenCalled();
      });
    });

    /**
     * ⚠ SIBLING EXCLUSION ON THE DISCOVERY ARM. The row is found by `expertProfileId` among
     * the request's LIVE relationships, so a COMPETING candidate's decline must never gate
     * the target. (`request_interaction` gets this structurally — its `contextId` IS the
     * subject relationship.)
     */
    it('discovery: a COMPETING candidates decline does not gate the target expert', async () => {
      useContext('project_discovery');
      mockListByRequest.mockResolvedValue([
        relationship({
          id: 'f0000000-0000-4000-8000-00000000000d',
          expertProfileId: OTHER_EXPERT_PROFILE_ID,
          status: 'declined',
          declinedAt: new Date('2026-08-01T00:00:00Z'),
        }),
        relationship({ status: 'accepted', declinedAt: null }),
      ]);

      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(EXPERT_USER_ID),
      });

      expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
    });

    /**
     * ⚠ ENGAGEMENT-GRAIN CONTEXTS ARE UNAFFECTED — no request relationship exists to decline,
     * so no read is even attempted. Asserted by call-count so a future "just check it
     * everywhere" edit fails here.
     */
    it.each(['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const)(
      'engagement grain (%s) consults NO relationship at all',
      async (engagementContextType) => {
        mockListContexts.mockResolvedValue([
          { contextType: engagementContextType, contextId: ENGAGEMENT_ID },
        ]);
        mockFindProfileById.mockResolvedValue(profile());

        const result = await authorizeMeetingFileAccess({
          meetingId: MEETING_ID,
          actor: member(EXPERT_USER_ID),
        });

        expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
        expect(mockRelationshipFindById).not.toHaveBeenCalled();
        expect(mockListByRequest).not.toHaveBeenCalled();
      }
    );
  });

  describe('a signed-in stranger is still cross_tenant, with no guest-specific branch', () => {
    /**
     * A signed-in `userId` who is neither a company member nor expert-side is still refused
     * with the same fail-closed `cross_tenant` literal a guest used to fall into before
     * BAL-445. That is unchanged: a stranger has no `MeetingGuestSubject` to present, so
     * `actor.kind` is `'member'` here and the member arms simply find no membership.
     */
    it('denies a signed-in stranger — `cross_tenant`', async () => {
      mockGetMemberRole.mockResolvedValue(undefined);
      mockFindProfileById.mockResolvedValue(profile());
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(STRANGER_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('cross_tenant');
    });
  });

  /**
   * ⚠⚠ BAL-445 — THE GUEST ARM, FILLED. `guestMayReadMeeting` (@balo/shared/meetings) is
   * called for real here (not mocked — it is pure), so these tests exercise the actual scope
   * rule, not a stand-in for it.
   */
  describe('guest arm — BAL-445', () => {
    beforeEach(() => {
      // The target meeting's own context, used both for `subject` and (when the guest's own
      // meeting differs) for the envelope comparison.
      mockListContexts.mockImplementation(async (id: string) => {
        if (id === MEETING_ID) return [CONTEXT_ROW]; // engagement: ENGAGEMENT_ID
        if (id === GUEST_MEETING_ID) return [CONTEXT_ROW]; // same engagement, by default
        return [];
      });
    });

    it('allows a guest reading their OWN meeting — the id-equality shortcut, no envelope read', async () => {
      const result = await authorizeMeetingFileAccess({
        meetingId: GUEST_MEETING_ID,
        actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toMatchObject({
        ok: true,
        viewer: 'guest',
        guestId: GUEST_ID,
        accessScope: 'meeting',
      });
      // ⚠ NO `side` ON THE GUEST ARM — the load-bearing decision (§2.1).
      expect(result).not.toHaveProperty('side');
      // Only the target meeting's own contexts are read — no second `listByMeeting` call for
      // the guest's own meeting, because the ids already matched.
      expect(mockListContexts).toHaveBeenCalledTimes(1);
    });

    it('denies a `meeting`-scoped guest reading a DIFFERENT meeting — guest_out_of_scope', async () => {
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('guest_out_of_scope');
    });

    it('allows an `engagement`-scoped guest reading a DIFFERENT meeting in the SAME envelope', async () => {
      // Both the guest's own meeting and the target share `ENGAGEMENT_ID` via the default mock.
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: guestActor({ accessScope: 'engagement', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toMatchObject({ ok: true, viewer: 'guest', guestId: GUEST_ID });
      expect(result).not.toHaveProperty('side');
    });

    /**
     * ⚠⚠ F2 (fix-round-1) — `meeting` and `guestMeeting` MUST be two distinct fields once the
     * target and the guest's own meeting differ. `meeting-chat-anchor.ts`'s guest arm derives
     * `resolveGuestConversationScope`'s `guestMeetingId` from `guestMeeting`, never `meeting` —
     * if this test ever collapses back to one field, that scope silently rebinds to caller-
     * supplied input with no independent tie to the recorded grant (CRITICAL-2).
     */
    it("threads the TARGET meeting and the GUEST'S OWN meeting as two distinct fields", async () => {
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: guestActor({ accessScope: 'engagement', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toMatchObject({
        ok: true,
        viewer: 'guest',
        meeting: { id: MEETING_ID },
        guestMeeting: { id: GUEST_MEETING_ID },
      });
    });

    it('denies an `engagement`-scoped guest reading a meeting in a DIFFERENT envelope', async () => {
      mockListContexts.mockImplementation(async (id: string) => {
        if (id === MEETING_ID) return [{ contextType: 'case', contextId: OTHER_ENGAGEMENT_ID }];
        if (id === GUEST_MEETING_ID) return [CONTEXT_ROW]; // ENGAGEMENT_ID
        return [];
      });
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: guestActor({ accessScope: 'engagement', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('guest_out_of_scope');
    });

    it('denies an `engagement`-scoped guest whose OWN meeting is a project_discovery (no envelope)', async () => {
      mockListContexts.mockImplementation(async (id: string) => {
        if (id === MEETING_ID) return [CONTEXT_ROW];
        if (id === GUEST_MEETING_ID) {
          return [{ contextType: 'project_discovery', contextId: REQUEST_ID }];
        }
        return [];
      });
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: guestActor({ accessScope: 'engagement', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('guest_out_of_scope');
    });

    it('never resolves an owning party for a guest on an ENGAGEMENT-grain context — resolveMeetingContextOwner is skipped', async () => {
      await authorizeMeetingFileAccess({
        meetingId: GUEST_MEETING_ID,
        actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
      });
      expect(mockResolveOwner).not.toHaveBeenCalled();
      expect(mockGetMemberRole).not.toHaveBeenCalled();
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });

    /**
     * ⚠⚠ F1 (fix-round-1) — THE CRITICAL. `pending` is a lobby KNOCK, not a grant:
     * `claimLobbyPlaceAction` is deliberately unauthenticated and hands ANY visitor holding a
     * forwarded `/join/m/{meetingId}` URL a live `meeting_guests` row with
     * `admission: 'pending'`. Without this gate, that visitor could read every file and the
     * whole in-call transcript without ever being admitted by a host.
     */
    describe('admission gate — F1 (fix-round-1)', () => {
      it('DENIES a `pending` (never-admitted) guest — guest_not_admitted', async () => {
        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({
            accessScope: 'meeting',
            guestMeetingId: GUEST_MEETING_ID,
            admission: 'pending',
          }),
        });
        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('guest_not_admitted');
      });

      it('DENIES a `denied` guest identically (defence in depth — unreachable via the resolver in practice)', async () => {
        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({
            accessScope: 'meeting',
            guestMeetingId: GUEST_MEETING_ID,
            admission: 'denied',
          }),
        });
        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('guest_not_admitted');
      });

      it('ALLOWS a `pre_admitted` guest — a held seat, never knocked', async () => {
        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({
            accessScope: 'meeting',
            guestMeetingId: GUEST_MEETING_ID,
            admission: 'pre_admitted',
          }),
        });
        expect(result).toMatchObject({ ok: true, viewer: 'guest' });
      });

      it('ALLOWS an `admitted` guest — the ordinary case', async () => {
        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({
            accessScope: 'meeting',
            guestMeetingId: GUEST_MEETING_ID,
            admission: 'admitted',
          }),
        });
        expect(result).toMatchObject({ ok: true, viewer: 'guest' });
      });

      it('checks admission BEFORE the scope rule — a pending guest is refused even for their OWN meeting', async () => {
        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({
            accessScope: 'engagement',
            guestMeetingId: GUEST_MEETING_ID,
            admission: 'pending',
          }),
        });
        expect(result).toEqual(NOT_FOUND);
        expect(lastDenialReason()).toBe('guest_not_admitted');
      });
    });

    /**
     * ⚠⚠ F3 (fix-round-1) — reuses the (c) decline gate's OWN predicate
     * (`requestGrainRelationshipDenies` → `relationshipDeniesHosting`) for a guest. Without
     * this, a guest invited to a `request_interaction` / `project_discovery` meeting whose
     * expert has since DECLINED the request kept reading files after the declining expert and
     * their whole agency were denied — the exact defect BAL-423 shipped a fix for, reintroduced
     * one actor removed.
     */
    describe('decline gate also gates a guest — F3 (fix-round-1)', () => {
      function relationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
          id: RELATIONSHIP_ID,
          projectRequestId: REQUEST_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          status: 'invited',
          declinedAt: null,
          ...overrides,
        };
      }

      describe.each([
        { contextType: 'project_discovery' as const, contextId: REQUEST_ID },
        { contextType: 'request_interaction' as const, contextId: RELATIONSHIP_ID },
      ])('$contextType', ({ contextType, contextId }) => {
        beforeEach(() => {
          // The id-equality shortcut (`meetingId === guestMeetingId`) so no envelope read is
          // needed — isolates the assertion to the decline gate alone.
          mockListContexts.mockResolvedValue([{ contextType, contextId }]);
          mockResolveOwner.mockResolvedValue({
            companyId: COMPANY_ID,
            expertProfileId: EXPERT_PROFILE_ID,
          });
        });

        it('DENIES a guest once the relationship is declined', async () => {
          mockRelationshipFindById.mockResolvedValue(
            relationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00Z') })
          );
          mockListByRequest.mockResolvedValue([
            relationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00Z') }),
          ]);

          const result = await authorizeMeetingFileAccess({
            meetingId: GUEST_MEETING_ID,
            actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
          });

          expect(result).toEqual(NOT_FOUND);
          expect(lastDenialReason()).toBe('declined_relationship');
        });

        it('ALLOWS a guest when the relationship is live, not declined', async () => {
          mockRelationshipFindById.mockResolvedValue(relationship());
          mockListByRequest.mockResolvedValue([relationship()]);

          const result = await authorizeMeetingFileAccess({
            meetingId: GUEST_MEETING_ID,
            actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
          });

          expect(result).toMatchObject({ ok: true, viewer: 'guest' });
        });

        it('ALLOWS when no relationship row exists at all (absence never denies)', async () => {
          mockRelationshipFindById.mockResolvedValue(undefined);
          mockListByRequest.mockResolvedValue([]);

          const result = await authorizeMeetingFileAccess({
            meetingId: GUEST_MEETING_ID,
            actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
          });

          expect(result).toMatchObject({ ok: true, viewer: 'guest' });
        });
      });

      it('a `match`-routed project_discovery (no named expert) is ungated — evidence, not absence', async () => {
        mockListContexts.mockResolvedValue([
          { contextType: 'project_discovery', contextId: REQUEST_ID },
        ]);
        mockResolveOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });

        const result = await authorizeMeetingFileAccess({
          meetingId: GUEST_MEETING_ID,
          actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
        });

        expect(result).toMatchObject({ ok: true, viewer: 'guest' });
        expect(mockRelationshipFindById).not.toHaveBeenCalled();
        expect(mockListByRequest).not.toHaveBeenCalled();
      });

      /**
       * ⚠⚠ S2 (fix-round-2) regression — fix-round-1 left `owner === undefined` UNGATED for a
       * guest, the mirror image of the bypass F3 closed: a REMOVED (not merely declined)
       * relationship soft-deletes the row `resolveMeetingContextOwner`'s finders read
       * (`deleted_at IS NULL`), so it resolves `undefined` — exactly the shape the shipped
       * "remove invited expert" action produces. From that moment the member arm denies
       * everyone (`subject_unresolvable`, asserted separately below), while fix-round-1's guest
       * arm fell through to `guestMayReadMeeting` and kept reading. This pins the guest arm now
       * denies on the SAME missing-owner condition, with its own reason collapsing to the one
       * `meeting_not_found` literal, on BOTH request-grain context types.
       */
      describe.each([
        { contextType: 'project_discovery' as const, contextId: REQUEST_ID },
        { contextType: 'request_interaction' as const, contextId: RELATIONSHIP_ID },
      ])('$contextType — owner unresolvable', ({ contextType, contextId }) => {
        it('DENIES a guest when the owner cannot be resolved at all (e.g. the relationship was removed)', async () => {
          mockListContexts.mockResolvedValue([{ contextType, contextId }]);
          mockResolveOwner.mockResolvedValue(undefined);

          const result = await authorizeMeetingFileAccess({
            meetingId: GUEST_MEETING_ID,
            actor: guestActor({ accessScope: 'meeting', guestMeetingId: GUEST_MEETING_ID }),
          });

          expect(result).toEqual(NOT_FOUND);
          expect(lastDenialReason()).toBe('guest_owner_unresolvable');
          expect(mockRelationshipFindById).not.toHaveBeenCalled();
          expect(mockListByRequest).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('resolution failures — all one literal', () => {
    it('denies a missing or soft-deleted meeting before reading any context', async () => {
      mockMeetingFindById.mockResolvedValue(undefined);
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('no_meeting');
      expect(mockListContexts).not.toHaveBeenCalled();
    });

    it('denies an admin-only / context-less meeting', async () => {
      mockListContexts.mockResolvedValue([{ contextType: 'admin', contextId: null }]);
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('no_context');
    });

    it('denies an ambiguous meeting (two engagement-grain contexts) with the SAME literal', async () => {
      mockListContexts.mockResolvedValue([
        { contextType: 'case', contextId: ENGAGEMENT_ID },
        { contextType: 'case', contextId: 'f0000000-0000-4000-8000-000000000009' },
      ]);
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('ambiguous_context');
    });

    it('denies when the owning party cannot be resolved', async () => {
      mockResolveOwner.mockResolvedValue(undefined);
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toEqual(NOT_FOUND);
      expect(lastDenialReason()).toBe('subject_unresolvable');
      // Authorization never even started.
      expect(mockGetMemberRole).not.toHaveBeenCalled();
    });

    /**
     * ⚠ THE ORDERING RULE. Authorization runs before ANY coherence or state check, so a
     * non-member cannot distinguish a real meeting from a fake one by the response. Every
     * shape below returns the byte-identical literal; only the LOG differs.
     */
    it('returns the identical literal for every denial shape while the log reason differs', async () => {
      const reasons: unknown[] = [];
      const results: unknown[] = [];

      mockMeetingFindById.mockResolvedValue(undefined);
      results.push(
        await authorizeMeetingFileAccess({ meetingId: MEETING_ID, actor: member(STRANGER_USER_ID) })
      );
      reasons.push(lastDenialReason());

      mockMeetingFindById.mockResolvedValue(MEETING);
      mockListContexts.mockResolvedValue([]);
      results.push(
        await authorizeMeetingFileAccess({ meetingId: MEETING_ID, actor: member(STRANGER_USER_ID) })
      );
      reasons.push(lastDenialReason());

      mockListContexts.mockResolvedValue([CONTEXT_ROW]);
      mockResolveOwner.mockResolvedValue(undefined);
      results.push(
        await authorizeMeetingFileAccess({ meetingId: MEETING_ID, actor: member(STRANGER_USER_ID) })
      );
      reasons.push(lastDenialReason());

      mockResolveOwner.mockResolvedValue({
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      mockFindProfileById.mockResolvedValue(profile());
      results.push(
        await authorizeMeetingFileAccess({ meetingId: MEETING_ID, actor: member(STRANGER_USER_ID) })
      );
      reasons.push(lastDenialReason());

      // Four distinct shapes on the log…
      expect(new Set(reasons)).toEqual(
        new Set(['no_meeting', 'no_context', 'subject_unresolvable', 'cross_tenant'])
      );
      // …one indistinguishable answer on the wire.
      for (const result of results) {
        expect(result).toEqual(NOT_FOUND);
      }
    });
  });

  describe('lifecycle is deliberately NOT discharged here', () => {
    // D3: files outlive the call. "Can I still upload after it ended" is BAL-132/BAL-134's
    // product rule, and the gate threads the meeting back so a caller can decide.
    it('authorizes on an ENDED meeting and threads the meeting row back', async () => {
      const ended = { id: MEETING_ID, status: 'ended' };
      mockMeetingFindById.mockResolvedValue(ended);
      mockGetMemberRole.mockResolvedValue('member');
      const result = await authorizeMeetingFileAccess({
        meetingId: MEETING_ID,
        actor: member(CLIENT_USER_ID),
      });
      expect(result).toMatchObject({ ok: true, meeting: ended });
    });
  });
});

/**
 * ⚠⚠ THE STATIC SOURCE GUARDS — the mechanical proof of the axis choice.
 *
 * (1) This gate must never reach for the ENGAGEMENT-CAPABILITY axis. Its two tokens
 *     authorize the ACT, never the READ, and their holder set excludes agency role `expert` —
 *     the colleague on the call holding the file. It also excludes every client-side actor
 *     structurally, so it could never be the whole gate for a two-sided file surface.
 *
 *     ⚠ THE `apps/web` SEAM IS NOW OPEN — BAL-421 opened it (`lib/authz/engagement.ts`), not
 *     BAL-410/BAL-411 as originally deferred. THAT MAKES THIS GUARD MORE LOAD-BEARING, NOT
 *     LESS: the wrong import is now a keystroke away rather than impossible. Do not relax it.
 *
 * (2) The GUEST arm CALLS `guestMayReadMeeting` (BAL-445) — the shipped scope rule, never
 *     re-derived. The binding contract requires the CALL, and forbids ever comparing
 *     `accessScope` against a literal in this file (that comparison belongs to the pure rule
 *     alone).
 *
 * ⚠ `stripComments` COMES FROM `@balo/shared/testing`, NOT A LOCAL REGEX. The naive
 * `/\/\*[\s\S]*?\*\//g` shape is super-linear (SonarCloud S5852 — `[\s\S]` does not exclude
 * the terminator, so an unterminated block comment backtracks O(n²)). The shared helper is an
 * indexOf scan with zero ReDoS surface.
 */
describe('axis discipline', () => {
  const raw = readFileSync(join(import.meta.dirname, 'authorize-meeting-file-access.ts'), 'utf8');
  const code = stripComments(raw);

  it('reads its own source, and the stripper really ran (guards against a vacuous pass)', () => {
    // If the read ever broke, every assertion below would pass for free — and so would they
    // if `stripComments` silently became a no-op, because this module's docblocks NAME the
    // identifiers scanned below (`hasEngagementCapability`, `agencyRole`), precisely to
    // explain why they are absent from the code. Pinned on comment SYNTAX rather than on any
    // particular sentence, so ordinary prose edits cannot make this guard rot.
    expect(code).toContain('export async function authorizeMeetingFileAccess');
    expect(raw).toContain('/**');
    expect(code).not.toContain('/**');
    expect(code).not.toContain('//');
  });

  it('never reaches for the engagement-capability axis', () => {
    expect(code).not.toContain('hasEngagementCapability');
    expect(code).not.toContain('HOST_MEETINGS');
    expect(code).not.toContain('MANAGE_ENGAGEMENT');
  });

  /**
   * ⚠⚠ INVERTED FOR BAL-445 (G2). The guest hole is now FILLED: the predicate is called, not
   * avoided. `guestMayReadMeeting` is the shipped scope rule, consumed here exactly once.
   */
  it('calls the guest read predicate — the guest arm is filled, not a hole', () => {
    expect(code).toContain('guestMayReadMeeting');
  });

  /**
   * G-NEW-1 — the §2.5 binding contract, pinned mechanically. The scope rule is CALLED, never
   * mirrored: nothing in this file may compare `accessScope` against a literal, because that
   * comparison is `guestMayReadMeeting`'s alone to make.
   */
  it('never compares `accessScope` against a literal — the scope rule is called, never mirrored', () => {
    expect(code).not.toMatch(/accessScope\s*===/);
  });

  /**
   * ⚠ ONE DEFINITION OF "DECLINED", PINNED MECHANICALLY. The decline gate must CONSUME
   * `relationshipDeniesHosting` from `@balo/shared/authz` — the single definition on this
   * platform, which checks BOTH the enum label and `declined_at` so it fails closed if they
   * ever disagree. A hand-rolled `status === 'declined'` here would be a second definition
   * that could silently diverge from `apps/api`'s answer about the SAME meeting.
   */
  it('consumes the SHARED decline predicate and never re-derives one', () => {
    expect(code).toContain('relationshipDeniesHosting');
    expect(code).not.toContain("'declined'");
    expect(code).not.toContain('declinedAt');
  });

  /**
   * ⚠ ONE DEFINITION OF EXPERT-SIDE VISIBILITY, PINNED THE SAME WAY (BAL-419 / ADR-1046 §7).
   * `actorIsOnExpertSide` must CONSUME `actorHasExpertSideVisibility` from `@balo/shared/authz`
   * — the single definition — rather than re-deriving `agencyRole !== undefined` locally, which
   * could silently diverge from the answer `authorizeSessionExpertVisibility` and
   * `authorizeEngagementConversation` give about the SAME agency colleague. A drift alarm, not
   * the guarantee: the guarantee is the visibility-vs-act table in
   * `packages/shared/src/authz/expert-side-visibility.test.ts`.
   *
   * ⚠ THE CALL, NOT MERELY THE SYMBOL. `toContain('actorHasExpertSideVisibility')` alone stays
   * green if the CALL is deleted and the IMPORT left behind. Matching on the open paren, and
   * counting it, means one call site exactly: zero would be a re-inlined local rule, two an
   * ungoverned second consumer.
   */
  it('delegates the agency arm to the shared predicate — exactly one CALL site', () => {
    expect([...code.matchAll(/actorHasExpertSideVisibility\(/g)]).toHaveLength(1);
    // The `agencyRole !== undefined` line lives in `@balo/shared/authz` and ONLY there.
    expect(code).not.toContain('agencyRole');
  });
});
