import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ENGAGEMENT_CAPABILITIES, type EngagementCapability } from '@balo/shared/authz';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockEngagementFindById,
  mockProjectRequestFindById,
  mockRelationshipFindById,
  mockFindProfileById,
  mockGetMemberRole,
  mockWarn,
} = vi.hoisted(() => ({
  mockEngagementFindById: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

/**
 * ⚠ THIS MOCK SURFACE IS AN ASSERTION IN ITSELF (AC #5).
 * It is the COMPLETE set of repositories the resolver may touch. There is deliberately no
 * participant / presence / attendee repository here: delegates, guests and expert-side
 * colleagues merely attending are excluded STRUCTURALLY, because ADR-1044's participation
 * model is never consulted. If a future change made the resolver read a participant table,
 * this mock would not provide it and every test below would fail loudly rather than
 * silently widening the holder set. `no participant repository is reachable` pins it.
 */
vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: mockEngagementFindById },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  requestExpertRelationshipsRepository: { findById: mockRelationshipFindById },
  expertsRepository: { findProfileById: mockFindProfileById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

import * as db from '@balo/db';
import {
  hasEngagementCapability,
  resolveHostContext,
  type EngagementHostSubject,
} from './authorize-engagement-host.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ENGAGEMENT_ID = 'engagement_1';
const REQUEST_ID = 'request_1';
const RELATIONSHIP_ID = 'relationship_1';
const SIBLING_RELATIONSHIP_ID = 'relationship_2';

const EXPERT_PROFILE_ID = 'expert_profile_1';
const SIBLING_EXPERT_PROFILE_ID = 'expert_profile_2';
const EXPERT_USER_ID = 'user_expert_1';
const SIBLING_EXPERT_USER_ID = 'user_expert_2';
const AGENCY_ID = 'agency_1';

const EXPERT = { id: EXPERT_PROFILE_ID, userId: EXPERT_USER_ID, agencyId: AGENCY_ID };
const INDEPENDENT_EXPERT = { id: EXPERT_PROFILE_ID, userId: EXPERT_USER_ID, agencyId: null };

const ALL_TOKENS: readonly EngagementCapability[] = Object.values(ENGAGEMENT_CAPABILITIES);

/** The four labels that anchor on `engagements.id` — one shared branch in the resolver. */
const ENGAGEMENT_GRAIN_TYPES = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
] as const;

const CASE_SUBJECT: EngagementHostSubject = { contextType: 'case', contextId: ENGAGEMENT_ID };
const DISCOVERY_SUBJECT: EngagementHostSubject = {
  contextType: 'project_discovery',
  contextId: REQUEST_ID,
};
const INTERACTION_SUBJECT: EngagementHostSubject = {
  contextType: 'request_interaction',
  contextId: RELATIONSHIP_ID,
};
const ADMIN_SUBJECT: EngagementHostSubject = { contextType: 'admin', contextId: null };

function relationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'proposal_submitted',
    declinedAt: null,
    ...overrides,
  };
}

/** Every repository the resolver can reach, so "no other repo was touched" is assertable. */
function repoCallCounts(): Record<string, number> {
  return {
    engagement: mockEngagementFindById.mock.calls.length,
    projectRequest: mockProjectRequestFindById.mock.calls.length,
    relationship: mockRelationshipFindById.mock.calls.length,
    expertProfile: mockFindProfileById.mock.calls.length,
    memberRole: mockGetMemberRole.mock.calls.length,
  };
}

/** The full ARGUMENT sequence, not just counts — what AC #12's "one resolver" really means. */
function repoCallSequence(): Record<string, unknown[][]> {
  return {
    engagement: mockEngagementFindById.mock.calls,
    projectRequest: mockProjectRequestFindById.mock.calls,
    relationship: mockRelationshipFindById.mock.calls,
    expertProfile: mockFindProfileById.mock.calls,
    memberRole: mockGetMemberRole.mock.calls,
  };
}

const host = { id: EXPERT_USER_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockEngagementFindById.mockResolvedValue({
    id: ENGAGEMENT_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockProjectRequestFindById.mockResolvedValue({
    id: REQUEST_ID,
    sendTo: 'direct',
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockRelationshipFindById.mockResolvedValue(relationship());
  mockFindProfileById.mockResolvedValue(EXPERT);
  mockGetMemberRole.mockResolvedValue(undefined);
});

// ── The holder set (AC #3, #4, #5, #6) ───────────────────────────────────────

describe('hasEngagementCapability — the holder set', () => {
  it('grants the DELIVERING EXPERT on a case context (AC #3)', async () => {
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, CASE_SUBJECT)
    ).resolves.toBe(true);
    expect(mockEngagementFindById).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(mockFindProfileById).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  it.each(ENGAGEMENT_GRAIN_TYPES)(
    'resolves %s via engagements.expertProfileId and reads NO other subject repository (AC #3)',
    async (contextType) => {
      const subject: EngagementHostSubject = { contextType, contextId: ENGAGEMENT_ID };
      await expect(
        hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, subject)
      ).resolves.toBe(true);
      expect(repoCallCounts()).toEqual({
        engagement: 1,
        projectRequest: 0,
        relationship: 0,
        expertProfile: 1,
        memberRole: 1,
      });
    }
  );

  it('grants an agency OWNER of the delivering expert’s agency (AC #3)', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    await expect(
      hasEngagementCapability(
        { id: 'user_agency_owner' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(true);
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, 'user_agency_owner');
  });

  it('grants an agency ADMIN of the delivering expert’s agency (AC #3)', async () => {
    mockGetMemberRole.mockResolvedValue('admin');
    await expect(
      hasEngagementCapability(
        { id: 'user_agency_admin' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(true);
  });

  it('DENIES an agency member whose role is `expert` — a colleague, not a host (AC #4)', async () => {
    mockGetMemberRole.mockResolvedValue('expert');
    await expect(
      hasEngagementCapability(
        { id: 'user_colleague' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(false);
  });

  it('DENIES a company owner of the CLIENT company — the structural exclusion (AC #5)', async () => {
    // The role lookup is scoped to the DELIVERING expert's agency, where a client-side
    // actor has no live row, so `getMemberRole` returns undefined. Their company `owner`
    // role — which does hold MANAGE_MEMBERS — is never consulted.
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(
      hasEngagementCapability(
        { id: 'user_client_owner' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, 'user_client_owner');
  });

  it('DENIES a delegate / guest attendee, and no participant repository is reachable (AC #5)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(
      hasEngagementCapability(
        { id: 'user_guest' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(false);
    // The literal form of "the resolver reads no participant table": the entire @balo/db
    // surface available to it is these five by-id reads. Nothing about attendance exists.
    expect(Object.keys(db).sort()).toEqual([
      'engagementsRepository',
      'expertsRepository',
      'partyMembershipsRepository',
      'projectRequestsRepository',
      'requestExpertRelationshipsRepository',
    ]);
  });

  it('grants an INDEPENDENT expert (null agencyId) WITHOUT any agency lookup (AC #6)', async () => {
    mockFindProfileById.mockResolvedValue(INDEPENDENT_EXPERT);
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, CASE_SUBJECT)
    ).resolves.toBe(true);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('DENIES a non-expert actor on an INDEPENDENT expert’s context, still without a lookup (AC #6)', async () => {
    mockFindProfileById.mockResolvedValue(INDEPENDENT_EXPERT);
    await expect(
      hasEngagementCapability(
        { id: 'user_stranger' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(false);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });
});

// ── Arm 5: project_discovery, split by route (AC #7, #8) ─────────────────────

describe('hasEngagementCapability — project_discovery', () => {
  it('resolves a DIRECT request from projectRequests.expertProfileId (AC #7)', async () => {
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, DISCOVERY_SUBJECT)
    ).resolves.toBe(true);
    expect(mockProjectRequestFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockEngagementFindById).not.toHaveBeenCalled();
  });

  it('DENIES a direct request whose expertProfileId is null — belt-and-braces (AC #7)', async () => {
    mockProjectRequestFindById.mockResolvedValue({
      id: REQUEST_ID,
      sendTo: 'direct',
      expertProfileId: null,
    });
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, DISCOVERY_SUBJECT)
    ).resolves.toBe(false);
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });

  it('DENIES the delivering expert themselves on a MATCH request — no holder (AC #8)', async () => {
    mockProjectRequestFindById.mockResolvedValue({
      id: REQUEST_ID,
      sendTo: 'match',
      expertProfileId: null,
    });
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, DISCOVERY_SUBJECT)
    ).resolves.toBe(false);
  });

  it.each([
    ['an agency owner', 'user_agency_owner', 'owner'],
    ['an agency admin', 'user_agency_admin', 'admin'],
    ['a Balo platform admin', 'user_balo_admin', 'admin'],
    ['a client company owner', 'user_client_owner', 'owner'],
    ['the delivering expert', EXPERT_USER_ID, undefined],
  ])(
    'a MATCH request is false for %s — false for ALL actors (AC #8)',
    async (_label, userId, role) => {
      mockProjectRequestFindById.mockResolvedValue({
        id: REQUEST_ID,
        sendTo: 'match',
        expertProfileId: null,
      });
      mockGetMemberRole.mockResolvedValue(role);
      for (const token of ALL_TOKENS) {
        await expect(
          hasEngagementCapability({ id: userId }, token, DISCOVERY_SUBJECT)
        ).resolves.toBe(false);
      }
    }
  );

  it('a MATCH request performs NO expert lookup — a deliberate short-circuit, not an accidental undefined (AC #8)', async () => {
    mockProjectRequestFindById.mockResolvedValue({
      id: REQUEST_ID,
      sendTo: 'match',
      expertProfileId: SIBLING_EXPERT_PROFILE_ID, // even if a row somehow names one
    });
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, DISCOVERY_SUBJECT)
    ).resolves.toBe(false);
    expect(mockFindProfileById).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('a future third routing value also fails closed (guarded on !== direct)', async () => {
    mockProjectRequestFindById.mockResolvedValue({
      id: REQUEST_ID,
      sendTo: 'shortlist',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, DISCOVERY_SUBJECT)
    ).resolves.toBe(false);
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });
});

// ── Arm 6: request_interaction (AC #9, #10) ──────────────────────────────────

describe('hasEngagementCapability — request_interaction', () => {
  it('resolves from THAT relationship’s expert (AC #9)', async () => {
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, INTERACTION_SUBJECT)
    ).resolves.toBe(true);
    expect(mockRelationshipFindById).toHaveBeenCalledWith(RELATIONSHIP_ID);
  });

  it('a SIBLING candidate’s relationship resolves false for the other candidate (AC #9)', async () => {
    // Two candidates, two rows, two ids. Resolving sibling row B yields expert B only —
    // exclusion is structural: expert A's row is simply never read.
    mockRelationshipFindById.mockResolvedValue(
      relationship({ id: SIBLING_RELATIONSHIP_ID, expertProfileId: SIBLING_EXPERT_PROFILE_ID })
    );
    mockFindProfileById.mockResolvedValue({
      id: SIBLING_EXPERT_PROFILE_ID,
      userId: SIBLING_EXPERT_USER_ID,
      agencyId: null,
    });
    const siblingSubject: EngagementHostSubject = {
      contextType: 'request_interaction',
      contextId: SIBLING_RELATIONSHIP_ID,
    };

    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, siblingSubject)
    ).resolves.toBe(false);
    await expect(
      hasEngagementCapability(
        { id: SIBLING_EXPERT_USER_ID },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        siblingSubject
      )
    ).resolves.toBe(true);
  });

  it('a DECLINED relationship (status = declined) resolves false (AC #10)', async () => {
    mockRelationshipFindById.mockResolvedValue(
      relationship({ status: 'declined', declinedAt: new Date('2026-08-01T00:00:00.000Z') })
    );
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, INTERACTION_SUBJECT)
    ).resolves.toBe(false);
  });

  it('a DECLINED relationship detected by declinedAt alone resolves false — the two representations are checked independently (AC #10)', async () => {
    // The shared transition writes both, so they agree in practice. If they ever disagree
    // the resolver must fail closed on EITHER, not trust the enum label.
    mockRelationshipFindById.mockResolvedValue(
      relationship({
        status: 'proposal_submitted',
        declinedAt: new Date('2026-08-01T00:00:00.000Z'),
      })
    );
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, INTERACTION_SUBJECT)
    ).resolves.toBe(false);
  });

  it('a DECLINED relationship performs no expert lookup (AC #10)', async () => {
    mockRelationshipFindById.mockResolvedValue(relationship({ status: 'declined' }));
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, INTERACTION_SUBJECT)
    ).resolves.toBe(false);
    expect(mockFindProfileById).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });
});

// ── Arm 7: admin contexts belong to the platform axis ────────────────────────

describe('hasEngagementCapability — admin contexts', () => {
  it('is false with ZERO repository calls — the platform axis owns these', async () => {
    for (const token of ALL_TOKENS) {
      await expect(hasEngagementCapability(host, token, ADMIN_SUBJECT)).resolves.toBe(false);
    }
    expect(repoCallCounts()).toEqual({
      engagement: 0,
      projectRequest: 0,
      relationship: 0,
      expertProfile: 0,
      memberRole: 0,
    });
  });
});

// ── Fail-closed contract ─────────────────────────────────────────────────────

describe('hasEngagementCapability — fails closed, never throws', () => {
  const MISSING_ROW_CASES: readonly [string, EngagementHostSubject, () => void][] = [
    [
      'case',
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      () => mockEngagementFindById.mockResolvedValue(undefined),
    ],
    [
      'project_kickoff',
      { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
      () => mockEngagementFindById.mockResolvedValue(undefined),
    ],
    [
      'package_session',
      { contextType: 'package_session', contextId: ENGAGEMENT_ID },
      () => mockEngagementFindById.mockResolvedValue(undefined),
    ],
    [
      'retainer_checkin',
      { contextType: 'retainer_checkin', contextId: ENGAGEMENT_ID },
      () => mockEngagementFindById.mockResolvedValue(undefined),
    ],
    [
      'project_discovery',
      DISCOVERY_SUBJECT,
      () => mockProjectRequestFindById.mockResolvedValue(undefined),
    ],
    [
      'request_interaction',
      INTERACTION_SUBJECT,
      () => mockRelationshipFindById.mockResolvedValue(undefined),
    ],
    [
      'the expert profile behind a case',
      CASE_SUBJECT,
      () => mockFindProfileById.mockResolvedValue(undefined),
    ],
  ];

  it.each(MISSING_ROW_CASES)(
    'a missing / soft-deleted %s row denies BOTH tokens without throwing',
    async (_label, subject, arrange) => {
      arrange();
      for (const token of ALL_TOKENS) {
        await expect(hasEngagementCapability(host, token, subject)).resolves.toBe(false);
      }
      await expect(resolveHostContext(subject, host.id)).resolves.toBeNull();
    }
  );

  it('logs a WARN integrity signal when a context_id points at nothing live', async () => {
    mockEngagementFindById.mockResolvedValue(undefined);
    await hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, CASE_SUBJECT);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextType: 'case',
        contextId: ENGAGEMENT_ID,
        actorId: EXPERT_USER_ID,
        missing: 'engagement',
      }),
      expect.stringContaining('missing or soft-deleted')
    );
  });

  it('does NOT log an ordinary deny — a non-holder is a normal answer, not an anomaly', async () => {
    mockGetMemberRole.mockResolvedValue('expert');
    await hasEngagementCapability(
      { id: 'user_colleague' },
      ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
      CASE_SUBJECT
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('fails closed (and warns) on a context type the switch does not know', async () => {
    // The compile-time `never` in the default arm cannot be reached from typed code, so an
    // 8th DB label arriving ahead of its arm is simulated here. It must DENY, not throw.
    const unknownSubject = {
      contextType: 'workshop',
      contextId: 'x',
    } as unknown as EngagementHostSubject;
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, unknownSubject)
    ).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: EXPERT_USER_ID }),
      expect.stringContaining('Unhandled meeting_context_type')
    );
    expect(repoCallCounts()).toEqual({
      engagement: 0,
      projectRequest: 0,
      relationship: 0,
      expertProfile: 0,
      memberRole: 0,
    });
  });
});

// ── AC #12: ONE resolver, both tokens ────────────────────────────────────────

describe('both tokens route through the SAME resolver (AC #12)', () => {
  const MATRIX: readonly [string, EngagementHostSubject, { id: string }, string | undefined][] = [
    ['case / delivering expert', CASE_SUBJECT, host, undefined],
    ['case / agency owner', CASE_SUBJECT, { id: 'user_agency_owner' }, 'owner'],
    ['case / agency expert', CASE_SUBJECT, { id: 'user_colleague' }, 'expert'],
    ['case / stranger', CASE_SUBJECT, { id: 'user_stranger' }, undefined],
    ['discovery (direct) / delivering expert', DISCOVERY_SUBJECT, host, undefined],
    ['request_interaction / delivering expert', INTERACTION_SUBJECT, host, undefined],
    ['admin / delivering expert', ADMIN_SUBJECT, host, undefined],
  ];

  it.each(MATRIX)(
    '%s — identical repository sequence and identical answer for both tokens',
    async (_label, subject, actor, role) => {
      mockGetMemberRole.mockResolvedValue(role);

      const hostResult = await hasEngagementCapability(
        actor,
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        subject
      );
      const hostSequence = repoCallSequence();

      vi.clearAllMocks();
      mockEngagementFindById.mockResolvedValue({
        id: ENGAGEMENT_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      mockProjectRequestFindById.mockResolvedValue({
        id: REQUEST_ID,
        sendTo: 'direct',
        expertProfileId: EXPERT_PROFILE_ID,
      });
      mockRelationshipFindById.mockResolvedValue(relationship());
      mockFindProfileById.mockResolvedValue(EXPERT);
      mockGetMemberRole.mockResolvedValue(role);

      const manageResult = await hasEngagementCapability(
        actor,
        ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
        subject
      );

      expect(manageResult).toBe(hostResult);
      expect(repoCallSequence()).toEqual(hostSequence);
    }
  );
});

// ── resolveHostContext is exported for BAL-132 (flag F3) ─────────────────────

describe('resolveHostContext', () => {
  it('returns the assembled context so a caller never re-derives the holder rule', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    await expect(resolveHostContext(CASE_SUBJECT, 'user_agency_owner')).resolves.toEqual({
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: 'owner' },
    });
  });

  it('reports a non-member as actorRole null rather than omitting the agency', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(resolveHostContext(CASE_SUBJECT, 'user_stranger')).resolves.toEqual({
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: null },
    });
  });

  it('reports an independent expert as agency null — the context never lies about the world', async () => {
    mockFindProfileById.mockResolvedValue(INDEPENDENT_EXPERT);
    await expect(resolveHostContext(CASE_SUBJECT, EXPERT_USER_ID)).resolves.toEqual({
      expertUserId: EXPERT_USER_ID,
      agency: null,
    });
  });

  it('still reports the agency for an AGENCY-based expert asking about themselves', async () => {
    // The tempting extra short-circuit (skip the lookup when the actor IS the expert)
    // would return `agency: null` here — a context that lies. It is deliberately absent.
    await expect(resolveHostContext(CASE_SUBJECT, EXPERT_USER_ID)).resolves.toEqual({
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: null },
    });
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, EXPERT_USER_ID);
  });

  it('returns null for an admin context with no I/O', async () => {
    await expect(resolveHostContext(ADMIN_SUBJECT, EXPERT_USER_ID)).resolves.toBeNull();
    expect(repoCallCounts()).toEqual({
      engagement: 0,
      projectRequest: 0,
      relationship: 0,
      expertProfile: 0,
      memberRole: 0,
    });
  });
});
