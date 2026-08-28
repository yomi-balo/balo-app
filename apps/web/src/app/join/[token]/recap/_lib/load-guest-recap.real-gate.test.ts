import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * BAL-439 §9.3 — the grant-scope PROOFS. Mirrors
 * `list-guest-meeting-files.pending-admission.test.ts` exactly: does NOT mock
 * `@/lib/meetings/authorize-meeting-file-access` or `@/lib/meetings/resolve-guest-recap-access`
 * — the REAL gate and the REAL sibling module both run. Only their transitive `@balo/db` reads
 * are stubbed, and any repository the GUEST arm must never reach
 * (`expertsRepository`, `partyMembershipsRepository` — MEMBER-arm-only) is left off the mock
 * module entirely, on purpose, so a call to either throws and fails the test loudly rather than
 * passing silently.
 */

vi.mock('server-only', () => ({}));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';
/** The meeting the guest's OWN row points to — their "consultation 4". */
const GUEST_OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
/** A DIFFERENT meeting, held YEARS earlier — the guest's "consultation 1". */
const TARGET_MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
/** A meeting in a DIFFERENT envelope entirely — a stranger's case. */
const OTHER_ENVELOPE_MEETING_ID = 'a0000000-0000-4000-8000-000000000003';

const CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000003';
const OTHER_CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000004';
const RELATIONSHIP_ID = 'd0000000-0000-4000-8000-000000000005';
const EXPERT_PROFILE_ID = 'f0000000-0000-4000-8000-000000000006';

const {
  mockFindByTokenHash,
  mockMeetingFindById,
  mockListContexts,
  mockResolveContextOwner,
  mockRelationshipFindById,
  mockRelationshipListByRequest,
  mockTranscriptFindByMeetingId,
  mockArtifactFindByKind,
} = vi.hoisted(() => ({
  mockFindByTokenHash: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockListContexts: vi.fn(),
  mockResolveContextOwner: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockRelationshipListByRequest: vi.fn(),
  mockTranscriptFindByMeetingId: vi.fn(),
  mockArtifactFindByKind: vi.fn(),
}));

// ⚠ `expertsRepository` and `partyMembershipsRepository` are DELIBERATELY ABSENT — the guest
// arm never touches either (they belong to the MEMBER arm only). A stray reference would throw
// `Cannot read properties of undefined`, failing loudly rather than passing by coincidence.
vi.mock('@balo/db', () => ({
  meetingGuestsRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindByTokenHash(...a),
  },
  meetingsRepository: { findById: (...a: unknown[]) => mockMeetingFindById(...a) },
  meetingContextsRepository: { listByMeeting: (...a: unknown[]) => mockListContexts(...a) },
  resolveMeetingContextOwner: (...a: unknown[]) => mockResolveContextOwner(...a),
  requestExpertRelationshipsRepository: {
    findById: (...a: unknown[]) => mockRelationshipFindById(...a),
    listByRequest: (...a: unknown[]) => mockRelationshipListByRequest(...a),
  },
  transcriptsRepository: {
    findByMeetingId: (...a: unknown[]) => mockTranscriptFindByMeetingId(...a),
  },
  transcriptArtifactsRepository: {
    findByTranscriptAndKind: (...a: unknown[]) => mockArtifactFindByKind(...a),
  },
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

import { loadGuestRecap } from './load-guest-recap';

/** `meetings.*` fields the gate/loader reads. `outcome` is unused here and omitted. */
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
function guestRow(overrides: Partial<Record<string, unknown>> = {}): {
  guest: Record<string, unknown>;
  meeting: Record<string, unknown>;
} {
  return {
    guest: {
      id: GUEST_ID,
      tokenHash: TOKEN_HASH,
      party: 'client',
      accessScope: 'meeting',
      meetingId: GUEST_OWN_MEETING_ID,
      admission: 'admitted',
      ...overrides,
    },
    meeting: meetingRow(GUEST_OWN_MEETING_ID),
  };
}

function loadFor(meetingId: string): ReturnType<typeof loadGuestRecap> {
  return loadGuestRecap({ rawToken: RAW_TOKEN, meetingId, clientIpHash: 'f'.repeat(64) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReturnValue(true);
  mockTranscriptFindByMeetingId.mockResolvedValue(undefined);
});

describe('loadGuestRecap — against the REAL gate — meeting scope', () => {
  it('1. own meeting ⇒ a view', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow());
    mockMeetingFindById.mockResolvedValue(meetingRow(GUEST_OWN_MEETING_ID));
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CASE_CONTEXT_ID }]);

    const result = await loadFor(GUEST_OWN_MEETING_ID);

    expect(result).not.toBeNull();
    expect(result?.view.isOwnMeeting).toBe(true);
  });

  it('2. a FOREIGN target ⇒ null, and the transcript repository is never called (gate before read)', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ accessScope: 'meeting' }));
    mockMeetingFindById.mockResolvedValue(meetingRow(TARGET_MEETING_ID));
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: OTHER_CASE_CONTEXT_ID }]);

    const result = await loadFor(TARGET_MEETING_ID);

    expect(result).toBeNull();
    expect(mockTranscriptFindByMeetingId).not.toHaveBeenCalled();
  });
});

describe('loadGuestRecap — against the REAL gate — engagement scope', () => {
  /**
   * ⚠⚠ THE AC-BEARING CASE. `guest_meeting_id` (GUEST_OWN_MEETING_ID) is their consultation 4;
   * the TARGET (TARGET_MEETING_ID) is consultation 1, held YEARS EARLIER. Both meetings' primary
   * contexts resolve to the SAME `case` contextId, so `guestMayReadMeeting` grants — and it does
   * so with NO date comparison anywhere on the path: `TARGET_MEETING_ID`'s `scheduledStart` /
   * `startedAt` are set years before anything on the guest row, so a future `>= invitedAt` clause
   * anywhere on this path would fail this test.
   */
  it('3. RETROSPECTIVE read: a target held years before the guest was invited still resolves', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ accessScope: 'engagement' }));
    mockMeetingFindById.mockResolvedValue(
      meetingRow(TARGET_MEETING_ID, {
        scheduledStart: new Date('2020-01-01T10:00:00.000Z'),
        scheduledEnd: new Date('2020-01-01T11:00:00.000Z'),
      })
    );
    // Both meetings resolve to the SAME case, regardless of which meetingId is asked about.
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CASE_CONTEXT_ID }]);

    const result = await loadFor(TARGET_MEETING_ID);

    expect(result).not.toBeNull();
    expect(result?.view.isOwnMeeting).toBe(false);
    // The two envelope reads: once for the target, once for the guest's own meeting.
    expect(mockListContexts).toHaveBeenCalledWith(TARGET_MEETING_ID);
    expect(mockListContexts).toHaveBeenCalledWith(GUEST_OWN_MEETING_ID);
  });

  it('4. a DIFFERENT envelope ⇒ null (targetSharesGuestEnvelope is false)', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ accessScope: 'engagement' }));
    mockMeetingFindById.mockResolvedValue(meetingRow(OTHER_ENVELOPE_MEETING_ID));
    mockListContexts.mockImplementation((meetingId: string) =>
      Promise.resolve(
        meetingId === OTHER_ENVELOPE_MEETING_ID
          ? [{ contextType: 'case', contextId: OTHER_CASE_CONTEXT_ID }]
          : [{ contextType: 'case', contextId: CASE_CONTEXT_ID }]
      )
    );

    const result = await loadFor(OTHER_ENVELOPE_MEETING_ID);

    expect(result).toBeNull();
  });

  it('5. a `project_discovery` primary context on the TARGET ⇒ null (maps to no envelope)', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ accessScope: 'engagement' }));
    mockMeetingFindById.mockResolvedValue(meetingRow(TARGET_MEETING_ID));
    mockListContexts.mockImplementation((meetingId: string) =>
      Promise.resolve(
        meetingId === TARGET_MEETING_ID
          ? [{ contextType: 'project_discovery', contextId: 'req-1' }]
          : [{ contextType: 'case', contextId: CASE_CONTEXT_ID }]
      )
    );
    // A `project_discovery` context ALSO runs the request-grain decline check inside the guest
    // arm — a MATCH-ROUTED discovery names no expert (`expertProfileId: null`), so "evidence,
    // not absence" applies and nothing is declined; the denial this test proves comes from the
    // ENVELOPE mapping below, not from an unresolved owner.
    mockResolveContextOwner.mockResolvedValue({ companyId: 'company-x', expertProfileId: null });

    const result = await loadFor(TARGET_MEETING_ID);

    expect(result).toBeNull();
  });
});

describe('loadGuestRecap — against the REAL gate — admission and decline', () => {
  it('6. a PENDING (not-yet-admitted) guest ⇒ null, and no artefact read fires', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ admission: 'pending' }));
    mockMeetingFindById.mockResolvedValue(meetingRow(GUEST_OWN_MEETING_ID));
    mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: CASE_CONTEXT_ID }]);

    const result = await loadFor(GUEST_OWN_MEETING_ID);

    expect(result).toBeNull();
    expect(mockTranscriptFindByMeetingId).not.toHaveBeenCalled();
  });

  it('7. a DECLINED request-grain relationship ⇒ null (inherits relationshipDeniesHosting)', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow());
    mockMeetingFindById.mockResolvedValue(meetingRow(GUEST_OWN_MEETING_ID));
    mockListContexts.mockResolvedValue([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    mockResolveContextOwner.mockResolvedValue({
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockRelationshipFindById.mockResolvedValue({
      status: 'declined',
      declinedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const result = await loadFor(GUEST_OWN_MEETING_ID);

    expect(result).toBeNull();
    expect(mockTranscriptFindByMeetingId).not.toHaveBeenCalled();
  });
});

describe('loadGuestRecap — against the REAL gate — no primary context', () => {
  it('8. an admin-only / ambiguous primary context ⇒ null', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow());
    mockMeetingFindById.mockResolvedValue(meetingRow(GUEST_OWN_MEETING_ID));
    // `admin` scores 0 and is DROPPED by `selectPrimaryMeetingContext` — no holder at all.
    mockListContexts.mockResolvedValue([{ contextType: 'admin', contextId: 'admin-context-1' }]);

    const result = await loadFor(GUEST_OWN_MEETING_ID);

    expect(result).toBeNull();
  });
});
