import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * BAL-492 — D1's PROOF, against the REAL gate. Mirrors `load-guest-recap.real-gate.test.ts`
 * exactly: does NOT mock `@/lib/meetings/authorize-meeting-file-access` or
 * `@/lib/meetings/resolve-guest-recap-access` — both run for real. Only their transitive
 * `@balo/db` reads are stubbed, and `expertsRepository` / `partyMembershipsRepository`
 * (MEMBER-arm-only) are left OFF the mock module entirely, on purpose, so a stray call to
 * either throws and fails loudly rather than passing by coincidence.
 *
 * ⚠⚠ THE WHOLE POINT: `meetingContextsRepository.listMeetingsForContexts` (the loader's own
 * reverse read) and `meetingContextsRepository.listByMeeting` (the GATE's per-meeting context
 * read) are BOTH mocked here, independently, on purpose — the reverse read can be made to
 * "return" a meeting the gate genuinely refuses, which is the exact shape O4 warns about and
 * D1 exists to close.
 */

vi.mock('server-only', () => ({}));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const IP_HASH = 'f'.repeat(64);
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';

const RELATIONSHIP_ID = 'd0000000-0000-4000-8000-000000000005';
const CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000003';
const OTHER_CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'f0000000-0000-4000-8000-000000000006';

const {
  mockFindByTokenHash,
  mockMeetingFindById,
  mockListByMeeting,
  mockListMeetingsForContexts,
  mockResolveContextOwner,
  mockRelationshipFindById,
  mockRelationshipListByRequest,
} = vi.hoisted(() => ({
  mockFindByTokenHash: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockListMeetingsForContexts: vi.fn(),
  mockResolveContextOwner: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockRelationshipListByRequest: vi.fn(),
}));

// ⚠ `expertsRepository` / `partyMembershipsRepository` DELIBERATELY ABSENT — see module docblock.
vi.mock('@balo/db', () => ({
  meetingGuestsRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindByTokenHash(...a),
  },
  meetingsRepository: { findById: (...a: unknown[]) => mockMeetingFindById(...a) },
  meetingContextsRepository: {
    listByMeeting: (...a: unknown[]) => mockListByMeeting(...a),
    listMeetingsForContexts: (...a: unknown[]) => mockListMeetingsForContexts(...a),
  },
  resolveMeetingContextOwner: (...a: unknown[]) => mockResolveContextOwner(...a),
  requestExpertRelationshipsRepository: {
    findById: (...a: unknown[]) => mockRelationshipFindById(...a),
    listByRequest: (...a: unknown[]) => mockRelationshipListByRequest(...a),
  },
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

import { loadGuestRecapIndex } from './load-guest-recap-index';

function meetingRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    status: 'ended',
    scheduledStart: new Date('2026-08-01T10:00:00.000Z'),
    scheduledEnd: new Date('2026-08-01T11:00:00.000Z'),
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

/** A live guest row + its OWN meeting, as `findLiveByTokenHash` returns it. */
function guestRow(
  ownMeetingId: string,
  overrides: Partial<Record<string, unknown>> = {}
): { guest: Record<string, unknown>; meeting: Record<string, unknown> } {
  return {
    guest: {
      id: GUEST_ID,
      tokenHash: TOKEN_HASH,
      party: 'client',
      accessScope: 'engagement',
      meetingId: ownMeetingId,
      admission: 'admitted',
      ...overrides,
    },
    meeting: meetingRow(ownMeetingId, { status: 'scheduled' }),
  };
}

function runIndex(): ReturnType<typeof loadGuestRecapIndex> {
  return loadGuestRecapIndex({ rawToken: RAW_TOKEN, clientIpHash: IP_HASH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReturnValue(true);
  // Not declined, by default — individual tests override.
  mockResolveContextOwner.mockResolvedValue({
    companyId: 'company-1',
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockRelationshipFindById.mockResolvedValue({ status: 'active', declinedAt: null });
  mockRelationshipListByRequest.mockResolvedValue([]);
});

describe('loadGuestRecapIndex — against the REAL gate — O4a: the mixed-tier candidate', () => {
  /**
   * The guest's envelope is relationship:R (their own meeting's ONLY live context is
   * `{request_interaction, R}`). Candidate M carries BOTH `{request_interaction, R}` (tier 50)
   * AND `{case, E}` (tier 100), so `selectPrimaryMeetingContext` resolves M's primary to
   * `{case, E}` — a DIFFERENT envelope than the guest's. The reverse read on
   * `('request_interaction', R)` still returns M (tier-blind), which is exactly O4's hazard.
   */
  it('rows has length 0 — the per-row gate denies M even though the reverse read returned it', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000101';
    const CANDIDATE_ID = 'a0000000-0000-4000-8000-000000000102';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID));
    mockMeetingFindById.mockImplementation((id: string) =>
      Promise.resolve(id === OWN_MEETING_ID ? meetingRow(OWN_MEETING_ID) : meetingRow(CANDIDATE_ID))
    );
    mockListByMeeting.mockImplementation((meetingId: string) =>
      Promise.resolve(
        meetingId === OWN_MEETING_ID
          ? [{ contextType: 'request_interaction', contextId: RELATIONSHIP_ID }]
          : [
              { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
              { contextType: 'case', contextId: CASE_CONTEXT_ID },
            ]
      )
    );
    const reverseReadResult = [
      {
        meeting: meetingRow(CANDIDATE_ID),
        contextType: 'request_interaction',
        contextId: RELATIONSHIP_ID,
      },
    ];
    mockListMeetingsForContexts.mockResolvedValue(reverseReadResult);

    const result = await runIndex();

    expect(result).toEqual({ kind: 'index', rows: [], guestId: GUEST_ID });
    // ⚠ NON-VACUITY, both halves: the reverse read genuinely resolved a 1-element array
    // containing M, and the gate genuinely ran against M (not skipped).
    expect(reverseReadResult).toHaveLength(1);
    expect(reverseReadResult[0]?.meeting.id).toBe(CANDIDATE_ID);
    expect(mockMeetingFindById).toHaveBeenCalledWith(CANDIDATE_ID);
  });
});

describe('loadGuestRecapIndex — against the REAL gate — O4b: the ambiguous candidate', () => {
  /**
   * Candidate M carries TWO engagement-grain rows (`{case, E}` + `{case, E2}`), both tier 100
   * — `selectPrimaryMeetingContext` resolves `ambiguous`, and `authorizeMeetingFileAccess`
   * denies BEFORE even dispatching to the guest arm. The reverse read on `('case', E)` still
   * returns M.
   */
  it('rows has length 0 — the ambiguous primary denies M even though the reverse read returned it', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000201';
    const CANDIDATE_ID = 'a0000000-0000-4000-8000-000000000202';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID));
    mockMeetingFindById.mockImplementation((id: string) =>
      Promise.resolve(id === OWN_MEETING_ID ? meetingRow(OWN_MEETING_ID) : meetingRow(CANDIDATE_ID))
    );
    mockListByMeeting.mockImplementation((meetingId: string) =>
      Promise.resolve(
        meetingId === OWN_MEETING_ID
          ? [{ contextType: 'case', contextId: CASE_CONTEXT_ID }]
          : [
              { contextType: 'case', contextId: CASE_CONTEXT_ID },
              { contextType: 'case', contextId: OTHER_CASE_CONTEXT_ID },
            ]
      )
    );
    const reverseReadResult = [
      { meeting: meetingRow(CANDIDATE_ID), contextType: 'case', contextId: CASE_CONTEXT_ID },
    ];
    mockListMeetingsForContexts.mockResolvedValue(reverseReadResult);

    const result = await runIndex();

    expect(result).toEqual({ kind: 'index', rows: [], guestId: GUEST_ID });
    expect(reverseReadResult).toHaveLength(1);
    expect(reverseReadResult[0]?.meeting.id).toBe(CANDIDATE_ID);
    expect(mockMeetingFindById).toHaveBeenCalledWith(CANDIDATE_ID);
  });
});

describe('loadGuestRecapIndex — against the REAL gate — the positive control', () => {
  it('a genuine sibling in the SAME envelope IS returned', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000301';
    const SIBLING_ID = 'a0000000-0000-4000-8000-000000000302';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID));
    mockMeetingFindById.mockImplementation((id: string) =>
      Promise.resolve(id === OWN_MEETING_ID ? meetingRow(OWN_MEETING_ID) : meetingRow(SIBLING_ID))
    );
    mockListByMeeting.mockImplementation(() =>
      Promise.resolve([{ contextType: 'case', contextId: CASE_CONTEXT_ID }])
    );
    mockListMeetingsForContexts.mockResolvedValue([
      { meeting: meetingRow(SIBLING_ID), contextType: 'case', contextId: CASE_CONTEXT_ID },
    ]);

    const result = await runIndex();

    expect(result?.kind).toBe('index');
    const rows = result?.kind === 'index' ? result.rows : [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meetingId).toBe(SIBLING_ID);
  });

  /**
   * 4. THE REAL AC 2 — no recency clause gates WHICH meetings the guest may read. A sibling
   * held YEARS before the guest's own meeting still resolves into the index.
   */
  it('a sibling held YEARS before the guest`s own meeting still resolves (retrospective read)', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000401';
    const OLD_SIBLING_ID = 'a0000000-0000-4000-8000-000000000402';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID));
    const oldSibling = meetingRow(OLD_SIBLING_ID, {
      scheduledStart: new Date('2020-01-01T10:00:00.000Z'),
      scheduledEnd: new Date('2020-01-01T11:00:00.000Z'),
    });
    mockMeetingFindById.mockImplementation((id: string) =>
      Promise.resolve(id === OWN_MEETING_ID ? meetingRow(OWN_MEETING_ID) : oldSibling)
    );
    mockListByMeeting.mockImplementation(() =>
      Promise.resolve([{ contextType: 'case', contextId: CASE_CONTEXT_ID }])
    );
    mockListMeetingsForContexts.mockResolvedValue([
      { meeting: oldSibling, contextType: 'case', contextId: CASE_CONTEXT_ID },
    ]);

    const result = await runIndex();
    const rows = result?.kind === 'index' ? result.rows : [];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.meetingId).toBe(OLD_SIBLING_ID);
    expect(rows[0]?.occurredAtIso).toBe('2020-01-01T10:00:00.000Z');
  });
});

describe('loadGuestRecapIndex — against the REAL gate — admission and decline', () => {
  it('a PENDING (not-yet-admitted) guest ⇒ the whole index collapses to null, not a partial list', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000501';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID, { admission: 'pending' }));
    mockMeetingFindById.mockResolvedValue(meetingRow(OWN_MEETING_ID));
    mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: CASE_CONTEXT_ID }]);

    const result = await runIndex();

    expect(result).toBeNull();
    expect(mockListMeetingsForContexts).not.toHaveBeenCalled();
  });

  /**
   * 6. A declined request-grain relationship denies the ANCHOR itself, not merely a sibling —
   * `meetingContextTypesForEnvelope`'s relationship arm only ever reverse-reads the ANCHOR'S
   * OWN relationship id (see its docblock), so a declined relationship on that id is
   * indistinguishable, mechanically, from any other anchor-level denial: the WHOLE index
   * collapses to null, exactly like the pending-admission case above (same outcome, a
   * different underlying gate reason). There is no reachable shape where the anchor succeeds
   * while a relationship-arm SIBLING is independently declined, because every sibling reached
   * through that arm shares the anchor's own relationship id by construction of the reverse
   * read's query.
   */
  it('a DECLINED request-grain relationship (the anchor`s own) ⇒ the whole index collapses to null', async () => {
    const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000601';

    mockFindByTokenHash.mockResolvedValue(guestRow(OWN_MEETING_ID));
    mockMeetingFindById.mockResolvedValue(meetingRow(OWN_MEETING_ID));
    mockListByMeeting.mockResolvedValue([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    mockRelationshipFindById.mockResolvedValue({
      status: 'declined',
      declinedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const result = await runIndex();

    expect(result).toBeNull();
    expect(mockListMeetingsForContexts).not.toHaveBeenCalled();
  });
});
