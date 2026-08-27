import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-437 — the meeting → conversation-anchor resolution (ruling R3).
 *
 * ⚠⚠ THE TABLE BELOW IS THE TICKET'S ACCEPTANCE CRITERION IN EXECUTABLE FORM — for **THE FIVE
 * LABELS THIS MODULE ACTUALLY DECIDES**, plus "the anchor resolves but no conversation row
 * exists". Rows that answer NO ANCHOR must yield `anchor: null` — never a thrown error, and
 * never a fabricated conversation.
 *
 * ⚠⚠ **AN EARLIER HEADER CLAIMED "all seven labels are covered", AND THAT WAS FALSE FOR TWO OF
 * THEM.** `admin` and `ambiguous` are not decided here at all: `selectPrimaryMeetingContext`
 * drops admin rows, so an admin-only meeting resolves to a primary context of `none` and
 * `authorizeMeetingFileAccess` DENIES before the pure rule is ever reached; two distinct holder
 * contexts are denied identically. The two "tests" for them were byte-identical to each other
 * AND to the denial test at the bottom of this file — three copies of one assertion, none of
 * which constructed a real admin or ambiguous context, dressed up as label coverage. They are
 * now ONE honest denial test that says what it is proving and what it is NOT.
 *
 * ⚠ WHERE THE REAL admin/ambiguous COVERAGE LIVES: `authorize-meeting-file-access.test.ts` and
 * `selectPrimaryMeetingContext`'s own tests, which drive real context rows. Duplicating it here
 * over a mocked gate would be a second, drifting copy that could not fail for the right reason.
 *
 * ⚠⚠ `authorizeMeetingFileAccess` IS MOCKED, DELIBERATELY. This module composes that gate and
 * adds NOTHING to the authorization decision; re-testing the gate here would be a second,
 * drifting copy of `authorize-meeting-file-access.test.ts`. What IS tested here is everything
 * this module adds: the pure subject mapping, the `findByContext` READ, the two arms' DIFFERENT
 * lifecycle policies, and — as of BAL-445 — the guest arm's scope resolution.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = 'm0000000-0000-4000-8000-000000000001';
const GUEST_MEETING_ID = 'm0000000-0000-4000-8000-000000000099';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const GUEST_ID = 'u0000000-0000-4000-8000-000000000201';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000003';
const RELATIONSHIP_ID = 'r0000000-0000-4000-8000-000000000004';
const REQUEST_ID = 'q0000000-0000-4000-8000-000000000005';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000006';

const {
  mockAuthorize,
  mockFindByContext,
  mockEnsureForContext,
  mockEnsureManyForContexts,
  mockFindEngagement,
  mockFindRelationship,
  mockListContexts,
  mockListContextsByMeeting,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockFindByContext: vi.fn(),
  mockEnsureForContext: vi.fn(),
  mockEnsureManyForContexts: vi.fn(),
  mockFindEngagement: vi.fn(),
  mockFindRelationship: vi.fn(),
  mockListContexts: vi.fn(),
  mockListContextsByMeeting: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  conversationsRepository: {
    findByContext: mockFindByContext,
    listContexts: mockListContexts,
    // ⚠ TRIPWIRES. Both must stay uncalled — see the BAL-424 assertion at the bottom.
    ensureForContext: mockEnsureForContext,
    ensureManyForContexts: mockEnsureManyForContexts,
  },
  engagementsRepository: { findById: mockFindEngagement },
  requestExpertRelationshipsRepository: { findById: mockFindRelationship },
  meetingContextsRepository: { listByMeeting: mockListContextsByMeeting },
}));

vi.mock('./authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: mockAuthorize,
}));

import { resolveMeetingChatAccess } from './meeting-chat-anchor';

/** A granted MEMBER gate result, parameterised by the primary context it resolved. */
function granted(contextType: string, contextId: string | null): Record<string, unknown> {
  return {
    ok: true,
    viewer: 'member',
    side: 'client',
    meeting: { id: MEETING_ID },
    subject: { contextType, contextId },
    companyId: 'c1',
    expertProfileId: 'p1',
  };
}

/**
 * A granted GUEST gate result.
 *
 * ⚠⚠ F2 (fix-round-1) — `meeting` is the TARGET (`{ id: MEETING_ID }`, what the real gate
 * actually returns for a call with `meetingId: MEETING_ID`), and `guestMeeting` is the guest's
 * OWN meeting (`{ id: GUEST_MEETING_ID }`), threaded as a DISTINCT field. An earlier version of
 * this fixture set `meeting: { id: GUEST_MEETING_ID }` for a gate called with
 * `meetingId: MEETING_ID` — a result the real gate cannot produce (`authorize-meeting-file-
 * access.ts` always returns the TARGET meeting on `meeting`) — which let these tests pass
 * without proving `meeting-chat-anchor.ts` reads the right field.
 */
function grantedGuest(
  contextType: string,
  contextId: string | null,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: true,
    viewer: 'guest',
    guestId: GUEST_ID,
    accessScope: 'meeting',
    meeting: { id: MEETING_ID },
    guestMeeting: { id: GUEST_MEETING_ID },
    subject: { contextType, contextId },
    ...overrides,
  };
}

/**
 * A REAL-shaped `MeetingGuestSubject` for `actor.guest` — never `{} as never`. This module never
 * reads `actor.guest` itself (it only forwards `actor` to the MOCKED `authorizeMeetingFileAccess`
 * and consumes the returned `access` object), but an impossible fixture there hid that fact
 * rather than proving it.
 */
function realGuestSubject(): Record<string, unknown> {
  return {
    guest: { id: GUEST_ID, accessScope: 'meeting' },
    meeting: { id: GUEST_MEETING_ID, status: 'scheduled' },
    side: 'client',
    admission: 'admitted',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByContext.mockResolvedValue({ id: CONVERSATION_ID });
  mockFindEngagement.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
  mockFindRelationship.mockResolvedValue({ id: RELATIONSHIP_ID, status: 'accepted' });
  mockListContexts.mockResolvedValue([]);
  mockListContextsByMeeting.mockResolvedValue([]);
});

describe('resolveMeetingChatAccess — ⚠⚠ the anchor table, the five labels this module decides', () => {
  const ENGAGEMENT_GRAIN = [
    'case',
    'project_kickoff',
    'package_session',
    'retainer_checkin',
  ] as const;

  it.each(ENGAGEMENT_GRAIN)('%s ⇒ an ENGAGEMENT anchor, chat REGISTERED', async (contextType) => {
    mockAuthorize.mockResolvedValue(granted(contextType, ENGAGEMENT_ID));

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result).toMatchObject({
      ok: true,
      viewer: 'member',
      side: 'client',
      meetingId: MEETING_ID,
    });
    expect(result.ok === true ? result.anchor : null).toMatchObject({
      conversationId: CONVERSATION_ID,
      subject: { contextType: 'engagement', contextId: ENGAGEMENT_ID },
      writable: true,
    });
    expect(mockFindByContext).toHaveBeenCalledWith({
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('request_interaction ⇒ a RELATIONSHIP anchor, chat REGISTERED', async () => {
    mockAuthorize.mockResolvedValue(granted('request_interaction', RELATIONSHIP_ID));

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result.ok === true ? result.anchor : null).toMatchObject({
      conversationId: CONVERSATION_ID,
      subject: { contextType: 'relationship', contextId: RELATIONSHIP_ID },
      writable: true,
    });
  });

  it('⚠⚠ project_discovery ⇒ NO ANCHOR — one request fans out to MANY experts’ threads', async () => {
    mockAuthorize.mockResolvedValue(granted('project_discovery', REQUEST_ID));

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result).toEqual({
      ok: true,
      viewer: 'member',
      side: 'client',
      anchor: null,
      meetingId: MEETING_ID,
    });
    // ⚠ AND NO LOOKUP AT ALL — the pure rule answers before any I/O.
    expect(mockFindByContext).not.toHaveBeenCalled();
  });

  it('⚠⚠ anchor resolves but NO conversation row ⇒ NO ANCHOR, never a minted one', async () => {
    mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));
    mockFindByContext.mockResolvedValue(undefined);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result).toEqual({
      ok: true,
      viewer: 'member',
      side: 'client',
      anchor: null,
      meetingId: MEETING_ID,
    });
  });
});

/**
 * ⚠⚠ **TWO ARMS, TWO POLICIES.** A non-open thread status means different things on the two
 * grains, and each arm's answer must match the SHIPPED surface that renders the same thread:
 *
 *   · ENGAGEMENT — a closed case stays READABLE, only the composer disables
 *     (`fetch-case-thread.ts` has no writability check; `post-case-message.ts` refuses on one).
 *   · RELATIONSHIP — a declined relationship's thread is refused ENTIRELY by the project-request
 *     surface and by `createConversationRealtimeTokenAction`. So: NO ANCHOR.
 */
describe('resolveMeetingChatAccess — the ENGAGEMENT arm: closed is READ-ONLY, never absent', () => {
  it('an ACTIVE engagement is writable', async () => {
    mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));
    mockFindEngagement.mockResolvedValue({ status: 'active' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result.ok === true ? result.anchor?.writable : null).toBe(true);
  });

  it.each(['completed', 'cancelled'])(
    '⚠⚠ a %s engagement is READABLE but NOT WRITABLE — the anchor is still returned',
    async (status) => {
      mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));
      mockFindEngagement.mockResolvedValue({ status });

      const result = await resolveMeetingChatAccess({
        meetingId: MEETING_ID,
        actor: { kind: 'member', userId: USER_ID },
      });

      const anchor = result.ok === true ? result.anchor : null;
      // The whole point: read access survives, write access does not.
      expect(anchor).not.toBeNull();
      expect(anchor?.conversationId).toBe(CONVERSATION_ID);
      expect(anchor?.writable).toBe(false);
    }
  );

  it('⚠ a MISSING parent row fails closed — "cannot be shown to be open" is read-only', async () => {
    mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));
    mockFindEngagement.mockResolvedValue(undefined);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result.ok === true ? result.anchor?.writable : null).toBe(false);
  });
});

describe('resolveMeetingChatAccess — ⚠⚠ the RELATIONSHIP arm: a closed thread is ABSENT, not read-only', () => {
  it('an ACCEPTED relationship yields a writable anchor', async () => {
    mockAuthorize.mockResolvedValue(granted('request_interaction', RELATIONSHIP_ID));
    mockFindRelationship.mockResolvedValue({ status: 'accepted' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result.ok === true ? result.anchor : null).toMatchObject({
      conversationId: CONVERSATION_ID,
      writable: true,
    });
  });

  it.each(['declined', 'withdrawn'])(
    '⚠⚠ a %s relationship yields **NO ANCHOR** — not a read-only one',
    async (status) => {
      /**
       * ⚠⚠ THE DISCLOSURE THIS PINS. The previous version gated only the WRITE on
       * `isThreadOpenStatus`, leaving the READ and the `conversation:{id}` SUBSCRIBE grant
       * ungated — so a client-side member could open the in-call panel and read a DECLINED
       * relationship's thread that `createConversationRealtimeTokenAction` and the shipped
       * project-request surface both refuse. Same thread, same actor, two answers, and the
       * laxer one reachable from a live call.
       */
      mockAuthorize.mockResolvedValue(granted('request_interaction', RELATIONSHIP_ID));
      mockFindRelationship.mockResolvedValue({ status });

      const result = await resolveMeetingChatAccess({
        meetingId: MEETING_ID,
        actor: { kind: 'member', userId: USER_ID },
      });

      expect(result).toEqual({
        ok: true,
        viewer: 'member',
        side: 'client',
        anchor: null,
        meetingId: MEETING_ID,
      });
    }
  );

  it('⚠ a MISSING relationship row is NOT open — fail closed, same as the engagement arm', async () => {
    mockAuthorize.mockResolvedValue(granted('request_interaction', RELATIONSHIP_ID));
    mockFindRelationship.mockResolvedValue(undefined);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result.ok === true ? result.anchor : null).toBeNull();
  });
});

describe('resolveMeetingChatAccess — ⚠ `withWritability: false`', () => {
  it('skips the ENGAGEMENT lifecycle read and reports `writable: null`', async () => {
    mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
      withWritability: false,
    });

    expect(result.ok === true ? result.anchor : null).toMatchObject({
      conversationId: CONVERSATION_ID,
      // ⚠ `null` ⇒ NOT RESOLVED. It is not "unknown, assume open" — both consumers test `=== true`.
      writable: null,
    });
    expect(mockFindEngagement).not.toHaveBeenCalled();
  });

  it('⚠⚠ STILL RUNS THE RELATIONSHIP STATUS READ — there it decides the ANCHOR, not the write', async () => {
    // Skipping it would hand a `conversation:{id}` subscribe capability to a member of a
    // DECLINED relationship, which is the exact hole this module closes.
    mockAuthorize.mockResolvedValue(granted('request_interaction', RELATIONSHIP_ID));
    mockFindRelationship.mockResolvedValue({ status: 'declined' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
      withWritability: false,
    });

    expect(mockFindRelationship).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      viewer: 'member',
      side: 'client',
      anchor: null,
      meetingId: MEETING_ID,
    });
  });
});

describe('resolveMeetingChatAccess — ⚠⚠ denial and the BAL-424 transitive-write guard', () => {
  /**
   * ⚠⚠ THE **ONE** DENIAL TEST, replacing three byte-identical copies.
   *
   * The previous file asserted this same thing under three names — "admin", "AMBIGUOUS", and
   * "collapses every denial" — none of which constructed a real admin or ambiguous context. All
   * three just stubbed the gate to refuse, so the two label-shaped ones proved nothing about
   * their labels and the header's "all seven labels covered" claim was false for both.
   *
   * ⚠ WHAT THIS DOES PROVE: whatever the gate refuses (a cross-tenant meeting, a nonexistent
   * one, an `admin`-only meeting whose primary context is `none`, an `ambiguous` one) reaches
   * the caller as ONE indistinguishable literal, and NOTHING is read afterwards.
   *
   * ⚠ WHAT IT DOES **NOT** PROVE: that `admin` and `ambiguous` really are refused. That belongs
   * to `selectPrimaryMeetingContext` and `authorize-meeting-file-access.test.ts`, which drive
   * real context rows; asserting it here over a mocked gate would be circular.
   */
  it('collapses every denial into ONE literal — cross-tenant, nonexistent, admin and ambiguous alike', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    // ⚠ NOTHING is read after a denial — no anchor lookup, no lifecycle read.
    expect(mockFindByContext).not.toHaveBeenCalled();
    expect(mockFindEngagement).not.toHaveBeenCalled();
    expect(mockFindRelationship).not.toHaveBeenCalled();
  });

  it('⚠⚠ calls `findByContext` (a SELECT) and NEVER an `ensure*` — the BAL-424 regression guard', async () => {
    mockAuthorize.mockResolvedValue(granted('case', ENGAGEMENT_ID));

    await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(mockFindByContext).toHaveBeenCalledTimes(1);
    expect(mockEnsureForContext).not.toHaveBeenCalled();
    expect(mockEnsureManyForContexts).not.toHaveBeenCalled();
  });

  it('forwards the gate’s resolved SIDE unchanged — never re-derived here', async () => {
    mockAuthorize.mockResolvedValue({ ...granted('case', ENGAGEMENT_ID), side: 'expert' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });

    expect(result).toMatchObject({ ok: true, viewer: 'member', side: 'expert' });
    expect(mockAuthorize).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });
  });
});

/**
 * ⚠⚠ BAL-445 — THE GUEST ARM. `resolveGuestConversationScope` (@balo/shared/conversations) is
 * called for real (pure, not mocked); these tests exercise the actual scope rule.
 */
describe('resolveMeetingChatAccess — guest arm (BAL-445)', () => {
  it('a `meeting`-scoped guest gets `{ kind: "meeting" }` and `writable: null`', async () => {
    mockAuthorize.mockResolvedValue(
      grantedGuest('case', ENGAGEMENT_ID, { accessScope: 'meeting' })
    );
    mockListContexts.mockResolvedValue([{ contextType: 'engagement', contextId: ENGAGEMENT_ID }]);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toMatchObject({
      ok: true,
      viewer: 'guest',
      scope: { kind: 'meeting', meetingId: GUEST_MEETING_ID },
      anchor: { conversationId: CONVERSATION_ID, writable: null },
    });
  });

  it('an `engagement`-scoped guest whose own meeting IS the anchored engagement gets `{ kind: "full" }`', async () => {
    mockAuthorize.mockResolvedValue(
      grantedGuest('case', ENGAGEMENT_ID, { accessScope: 'engagement' })
    );
    mockListContextsByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
    ]);
    mockListContexts.mockResolvedValue([{ contextType: 'engagement', contextId: ENGAGEMENT_ID }]);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toMatchObject({ ok: true, viewer: 'guest', scope: { kind: 'full' } });
  });

  it('an `engagement`-scoped guest whose own meeting resolves to a DIFFERENT envelope stays meeting-scoped', async () => {
    mockAuthorize.mockResolvedValue(
      grantedGuest('case', ENGAGEMENT_ID, { accessScope: 'engagement' })
    );
    mockListContextsByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: 'other-engagement' },
    ]);
    mockListContexts.mockResolvedValue([{ contextType: 'engagement', contextId: ENGAGEMENT_ID }]);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toMatchObject({
      ok: true,
      viewer: 'guest',
      scope: { kind: 'meeting', meetingId: GUEST_MEETING_ID },
    });
  });

  it('denies outright when scope resolves to null — the guest’s OWN meeting is ambiguous/none', async () => {
    mockAuthorize.mockResolvedValue(
      grantedGuest('case', ENGAGEMENT_ID, { accessScope: 'engagement' })
    );
    // Two engagement-grain contexts on the guest's own meeting ⇒ ambiguous.
    mockListContextsByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: 'e-1' },
      { contextType: 'case', contextId: 'e-2' },
    ]);
    mockListContexts.mockResolvedValue([{ contextType: 'engagement', contextId: ENGAGEMENT_ID }]);

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('project_discovery ⇒ NO ANCHOR for a guest too, and no `listContexts` I/O at all', async () => {
    mockAuthorize.mockResolvedValue(grantedGuest('project_discovery', REQUEST_ID));

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toMatchObject({ ok: true, viewer: 'guest', anchor: null });
    expect(mockListContexts).not.toHaveBeenCalled();
  });

  it('a DECLINED relationship yields NO ANCHOR for a guest too — visibility, shared with members', async () => {
    mockAuthorize.mockResolvedValue(grantedGuest('request_interaction', RELATIONSHIP_ID));
    mockFindRelationship.mockResolvedValue({ status: 'declined' });

    const result = await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(result).toMatchObject({ ok: true, viewer: 'guest', anchor: null });
    expect(mockListContexts).not.toHaveBeenCalled();
  });

  it('never resolves engagement writability for a guest — no composer to report it to', async () => {
    mockAuthorize.mockResolvedValue(grantedGuest('case', ENGAGEMENT_ID));
    mockListContexts.mockResolvedValue([{ contextType: 'engagement', contextId: ENGAGEMENT_ID }]);

    await resolveMeetingChatAccess({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: realGuestSubject() as never },
    });

    expect(mockFindEngagement).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ CRITICAL-4 / F6 (fix-round-1) — G-NEW-1's MIRROR. `authorize-meeting-file-access.test.ts`
 * carries this exact guard for its own file; this module is DELIBERATELY ABSENT from
 * `meeting-call-no-lens-gate.test.ts`'s `CALL_LIB_FILES` scan (a documented server-only
 * carve-out — it legitimately imports `@/lib/logging` transitively and `@balo/db` directly), so
 * without THIS block `meeting-chat-anchor.ts` had NO mechanical source guard of any kind — and
 * its guest arm is exactly where a future edit would silently mirror the scope rule instead of
 * calling it. Mirrors `authorize-meeting-file-access.test.ts`'s `stripComments` + non-vacuity
 * preamble verbatim rather than inventing a second shape.
 */
describe('axis discipline', () => {
  const raw = readFileSync(join(import.meta.dirname, 'meeting-chat-anchor.ts'), 'utf8');
  const code = stripComments(raw);

  it('reads its own source, and the stripper really ran (guards against a vacuous pass)', () => {
    // If the read ever broke, every assertion below would pass for free — and so would they if
    // `stripComments` silently became a no-op, because this module's docblocks NAME the
    // identifiers scanned below (`hasEngagementCapability`), precisely to explain why they are
    // absent from the code.
    expect(code).toContain('export async function resolveMeetingChatAccess');
    expect(raw).toContain('/**');
    expect(code).not.toContain('/**');
    expect(code).not.toContain('//');
  });

  it('never reaches for the engagement-capability axis', () => {
    expect(code).not.toContain('hasEngagementCapability');
    expect(code).not.toContain('HOST_MEETINGS');
    expect(code).not.toContain('MANAGE_ENGAGEMENT');
  });

  it('calls the guest conversation-scope predicate — the guest arm is filled, not a hole', () => {
    expect(code).toContain('resolveGuestConversationScope');
  });

  /**
   * The scope rule is CALLED, never mirrored: nothing in this file may compare `accessScope`
   * against a literal, because that comparison is `resolveGuestConversationScope`'s alone to
   * make (its sibling `guestMayReadMeeting`'s binding contract, restated for the conversation
   * grain).
   */
  it('never compares `accessScope` against a literal — the scope rule is called, never mirrored', () => {
    expect(code).not.toMatch(/accessScope\s*===/);
  });
});
