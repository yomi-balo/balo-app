import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENGAGEMENT_CAPABILITIES,
  hostContextGrants,
  type EngagementCapability,
} from '@balo/shared/authz';
import { stripComments } from '@balo/shared/testing';

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
 * ⚠ THIS MOCK SURFACE IS THE COMPLETE SET of repositories the resolver may touch. There is
 * deliberately no participant / presence / attendee repository here: delegates, guests and
 * expert-side colleagues merely attending are excluded STRUCTURALLY, because ADR-1044's
 * participation model is never consulted. If a future change made the resolver read a
 * participant table, this mock would not provide it and every test below would fail loudly
 * rather than silently widening the holder set.
 *
 * ⚠ THAT IS A SAFETY NET, NOT THE ASSERTION. This factory is the TEST's own object, so
 * asserting on its keys would assert the test against itself — and would still pass if the
 * resolver reached a participant table through a different import path. The real assertion
 * is the SOURCE SCAN in `the resolver reads no participation model` below.
 */
vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: mockEngagementFindById },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  requestExpertRelationshipsRepository: { findById: mockRelationshipFindById },
  expertsRepository: { findProfileById: mockFindProfileById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

import {
  hasEngagementCapability,
  resolveHostContext,
  type EngagementHostSubject,
} from './authorize-engagement-host.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * ⚠ THE CONTEXT IDS MUST BE REAL UUIDS. `resolveHostContext` validates `contextId` at the
 * seam entry and denies anything that is not a canonical uuid, because a bare string
 * reaching `eq(table.id, contextId)` makes Postgres raise `22P02` — a THROW from a
 * predicate whose contract is that a caller never has to catch. Readable placeholders like
 * `'engagement_1'` would therefore make every test below assert the deny path by accident.
 *
 * Actor, expert-profile and agency ids are NOT validated by the resolver (they are only
 * ever passed to mocked repositories), so they stay readable on purpose.
 */
const ENGAGEMENT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const RELATIONSHIP_ID = '33333333-3333-4333-8333-333333333333';
const SIBLING_RELATIONSHIP_ID = '44444444-4444-4444-8444-444444444444';

const EXPERT_PROFILE_ID = 'expert_profile_1';
const SIBLING_EXPERT_PROFILE_ID = 'expert_profile_2';
const EXPERT_USER_ID = 'user_expert_1';
const SIBLING_EXPERT_USER_ID = 'user_expert_2';
const AGENCY_ID = 'agency_1';

const EXPERT = { id: EXPERT_PROFILE_ID, userId: EXPERT_USER_ID, agencyId: AGENCY_ID };
const INDEPENDENT_EXPERT = { id: EXPERT_PROFILE_ID, userId: EXPERT_USER_ID, agencyId: null };
const SIBLING_EXPERT = {
  id: SIBLING_EXPERT_PROFILE_ID,
  userId: SIBLING_EXPERT_USER_ID,
  agencyId: null,
};

const ALL_TOKENS: readonly EngagementCapability[] = Object.values(ENGAGEMENT_CAPABILITIES);

/** The four labels that anchor on `engagements.id` — one shared branch in the resolver. */
const ENGAGEMENT_GRAIN_TYPES = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
] as const;

/** Every label that CARRIES a `context_id`, i.e. everything the uuid guard applies to. */
const NON_ADMIN_CONTEXT_TYPES = [
  ...ENGAGEMENT_GRAIN_TYPES,
  'project_discovery',
  'request_interaction',
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

/**
 * Arm all five repositories with the HAPPY-PATH row for every arm, and the actor's agency
 * role (`undefined` = not a member). Extracted because the both-tokens matrix has to
 * re-arm mid-test after `vi.clearAllMocks()`, and a second verbatim copy of five
 * `mockResolvedValue` calls is how the two silently drift apart.
 */
function armDefaultRepos(role?: string): void {
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

const NO_REPOSITORY_CALLS: Record<string, number> = {
  engagement: 0,
  projectRequest: 0,
  relationship: 0,
  expertProfile: 0,
  memberRole: 0,
};

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
  armDefaultRepos();
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

  it('DENIES a delegate / guest attendee (AC #5)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(
      hasEngagementCapability(
        { id: 'user_guest' },
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        CASE_SUBJECT
      )
    ).resolves.toBe(false);
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

// ── AC #5, asserted against the PRODUCTION SOURCE rather than the mock ───────

describe('the resolver reads no participation model (AC #5)', () => {
  /**
   * The literal form of "delegates and guests are excluded STRUCTURALLY": the resolver's
   * own source never names a presence / participant / attendee surface, by ANY import
   * path. Asserting on the `vi.mock` factory's keys instead — as this suite used to —
   * asserts the test against itself: it is true by construction, and it would keep passing
   * if the resolver reached ADR-1044's participation model through a different specifier.
   *
   * Comments are stripped FIRST. No docblock in that file names one of these identifiers
   * TODAY — but the moment somebody documents the exclusion in prose ("reads no participant
   * table"), an unstripped scan would fail on the very sentence that describes the property
   * holding. Stripping keeps the invariant about CODE.
   */
  const raw = readFileSync(
    fileURLToPath(new URL('./authorize-engagement-host.ts', import.meta.url)),
    'utf8'
  );
  const source = stripComments(raw);

  it('reads its own source, and the stripper really ran (non-vacuity guard)', () => {
    expect(source).toContain('export async function resolveHostContext');
    // If `stripComments` ever silently became a no-op, every absence scan below would
    // still pass while proving nothing. Pinned on comment SYNTAX rather than on any
    // particular sentence, so ordinary prose edits cannot make this guard rot.
    expect(raw).toContain('/**');
    expect(source).not.toContain('/**');
    expect(source).not.toContain('//');
  });

  it.each(['presence', 'participant', 'attendee', 'Presence', 'Participant', 'Attendee'])(
    'never names `%s` outside a comment',
    (identifier) => {
      expect(source).not.toContain(identifier);
    }
  );

  it('reaches exactly the five by-id reads the holder rule needs, and no sixth', () => {
    // The counterpart to the absence scan: the repositories that ARE named. A new import
    // here must be a conscious edit to this list.
    const repositories = [...source.matchAll(/\b(\w+Repository)\b/g)].map(([, name]) => name);
    expect([...new Set(repositories)].sort()).toEqual([
      'engagementsRepository',
      'expertsRepository',
      'partyMembershipsRepository',
      'projectRequestsRepository',
      'requestExpertRelationshipsRepository',
    ]);
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
      expertProfileId: SIBLING_EXPERT_PROFILE_ID, // even if a row somehow named one
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
    // TWO CANDIDATES, TWO ROWS, TWO IDS — and the repository answers BY ID, so a resolver
    // that hardcoded `findById(RELATIONSHIP_ID)` fails this test instead of passing it.
    // (A blanket `mockResolvedValue` of row B for every id could not tell the two apart.)
    mockRelationshipFindById.mockImplementation((id: string) =>
      Promise.resolve(
        id === SIBLING_RELATIONSHIP_ID
          ? relationship({
              id: SIBLING_RELATIONSHIP_ID,
              expertProfileId: SIBLING_EXPERT_PROFILE_ID,
            })
          : relationship()
      )
    );
    mockFindProfileById.mockImplementation((id: string) =>
      Promise.resolve(id === SIBLING_EXPERT_PROFILE_ID ? SIBLING_EXPERT : INDEPENDENT_EXPERT)
    );
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
    // The subject's OWN id is what was read — the sibling's row was never touched.
    expect(mockRelationshipFindById).toHaveBeenCalledWith(SIBLING_RELATIONSHIP_ID);
    expect(mockRelationshipFindById).not.toHaveBeenCalledWith(RELATIONSHIP_ID);

    // And the mirror: candidate A's own subject still resolves to candidate A.
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, INTERACTION_SUBJECT)
    ).resolves.toBe(true);
    expect(mockRelationshipFindById).toHaveBeenCalledWith(RELATIONSHIP_ID);
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
    expect(repoCallCounts()).toEqual(NO_REPOSITORY_CALLS);
  });
});

// ── The uuid guard: a malformed context_id denies, it does not throw ─────────

describe('hasEngagementCapability — a malformed context_id denies without touching the DB', () => {
  /**
   * ⚠ WHY THIS IS A SECURITY TEST AND NOT A TIDINESS TEST. `contextId` is a bare `string`
   * off a polymorphic column with no FK, so a caller can hand this seam anything. Before
   * the guard, `''` or `'abc'` reached `eq(table.id, contextId)`, postgres-js inferred
   * `$1::uuid`, and the query REJECTED with `22P02` — an exception out of a predicate
   * whose stated contract is "contains no throw: a caller must never have to catch to stay
   * safe". An attacker-shaped input class turning a deny into a 500 (or, in a caller that
   * catches broadly, into an unhandled path) is the failure this closes.
   */
  const MALFORMED_CONTEXT_IDS: readonly [string, string][] = [
    ['empty string', ''],
    ['a bare word', 'abc'],
    ['a readable placeholder id', 'engagement_1'],
    ['a uuid one character short', '11111111-1111-4111-8111-11111111111'],
    ['a uuid with a non-hex character', '11111111-1111-4111-8111-11111111111g'],
    ['a braced uuid — valid to Postgres, rejected here on purpose', `{${ENGAGEMENT_ID}}`],
    ['a SQL fragment', "' OR '1'='1"],
    ['a uuid with trailing whitespace', `${ENGAGEMENT_ID} `],
  ];

  it.each(NON_ADMIN_CONTEXT_TYPES)(
    'denies BOTH tokens on a %s subject for every malformed id, with ZERO repository calls',
    async (contextType) => {
      for (const [, contextId] of MALFORMED_CONTEXT_IDS) {
        vi.clearAllMocks();
        armDefaultRepos();
        const subject: EngagementHostSubject = { contextType, contextId };

        for (const token of ALL_TOKENS) {
          await expect(hasEngagementCapability(host, token, subject)).resolves.toBe(false);
        }
        await expect(resolveHostContext(subject, host.id)).resolves.toBeNull();
        // The point of validating at the SEAM ENTRY: no arm ever got the chance to hand a
        // non-uuid to a repository.
        expect(repoCallCounts()).toEqual(NO_REPOSITORY_CALLS);
      }
    }
  );

  it('logs the malformed id as its own integrity signal, distinct from a missing row', async () => {
    await expect(
      resolveHostContext({ contextType: 'case', contextId: 'not-a-uuid' }, host.id)
    ).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextType: 'case',
        contextId: 'not-a-uuid',
        actorId: EXPERT_USER_ID,
        missing: 'invalid_context_id',
      }),
      expect.stringContaining('unusable')
    );
  });

  it('accepts an UPPERCASE uuid — case is not a validity signal for Postgres', async () => {
    // Guards the guard from the other side: a regex that denied valid ids would make every
    // deny above vacuous.
    const subject: EngagementHostSubject = {
      contextType: 'case',
      contextId: ENGAGEMENT_ID.toUpperCase(),
    };
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, subject)
    ).resolves.toBe(true);
    expect(mockEngagementFindById).toHaveBeenCalledWith(ENGAGEMENT_ID.toUpperCase());
  });

  it('accepts a non-v4 uuid — the guard is looser than z.uuid() on purpose', async () => {
    // A v1 uuid (version nibble `1`, variant nibble `9`) is a perfectly valid Postgres
    // `uuid`. Denying it would be a functional regression dressed as hardening.
    const v1 = '11111111-1111-1111-9111-111111111111';
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, {
        contextType: 'case',
        contextId: v1,
      })
    ).resolves.toBe(true);
  });
});

// ── Fail-closed contract ─────────────────────────────────────────────────────

describe('hasEngagementCapability — fails closed, never throws', () => {
  const denyEngagement = (): void => {
    mockEngagementFindById.mockResolvedValue(undefined);
  };

  const MISSING_ROW_CASES: readonly [string, EngagementHostSubject, () => void][] = [
    // The four engagement-grain labels share ONE resolver branch and therefore one arrange
    // step — written as data rather than four near-identical tuples (CLAUDE.md's 3+ rule).
    ...ENGAGEMENT_GRAIN_TYPES.map((contextType): [string, EngagementHostSubject, () => void] => [
      contextType,
      { contextType, contextId: ENGAGEMENT_ID },
      denyEngagement,
    ]),
    [
      'project_discovery',
      DISCOVERY_SUBJECT,
      () => {
        mockProjectRequestFindById.mockResolvedValue(undefined);
      },
    ],
    [
      'request_interaction',
      INTERACTION_SUBJECT,
      () => {
        mockRelationshipFindById.mockResolvedValue(undefined);
      },
    ],
    [
      'the expert profile behind a case',
      CASE_SUBJECT,
      () => {
        mockFindProfileById.mockResolvedValue(undefined);
      },
    ],
  ];

  it('covers every non-admin context type (non-vacuity guard for the cases below)', () => {
    // Without this, dropping a label from the list above would silently shrink the suite.
    const covered = new Set(MISSING_ROW_CASES.map(([, subject]) => subject.contextType));
    expect([...covered].sort()).toEqual([...NON_ADMIN_CONTEXT_TYPES].sort());
  });

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
    // ⚠ The `contextId` is a VALID uuid on purpose: the seam-entry uuid guard runs first,
    // so a junk id here would exercise that branch instead and leave the default arm of
    // the switch untested.
    const unknownSubject = {
      contextType: 'workshop',
      contextId: ENGAGEMENT_ID,
    } as unknown as EngagementHostSubject;
    await expect(
      hasEngagementCapability(host, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, unknownSubject)
    ).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: EXPERT_USER_ID }),
      expect.stringContaining('Unhandled meeting_context_type')
    );
    expect(repoCallCounts()).toEqual(NO_REPOSITORY_CALLS);
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
      armDefaultRepos(role);

      const hostResult = await hasEngagementCapability(
        actor,
        ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
        subject
      );
      const hostSequence = repoCallSequence();

      vi.clearAllMocks();
      armDefaultRepos(role);

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
      resolvedForActorId: 'user_agency_owner',
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: 'owner' },
    });
  });

  it('reports a non-member as actorRole null rather than omitting the agency', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(resolveHostContext(CASE_SUBJECT, 'user_stranger')).resolves.toEqual({
      resolvedForActorId: 'user_stranger',
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: null },
    });
  });

  it('reports an independent expert as agency null — the context never lies about the world', async () => {
    mockFindProfileById.mockResolvedValue(INDEPENDENT_EXPERT);
    await expect(resolveHostContext(CASE_SUBJECT, EXPERT_USER_ID)).resolves.toEqual({
      resolvedForActorId: EXPERT_USER_ID,
      expertUserId: EXPERT_USER_ID,
      agency: null,
    });
  });

  it('still reports the agency for an AGENCY-based expert asking about themselves', async () => {
    // The tempting extra short-circuit (skip the lookup when the actor IS the expert)
    // would return `agency: null` here — a context that lies. It is deliberately absent.
    await expect(resolveHostContext(CASE_SUBJECT, EXPERT_USER_ID)).resolves.toEqual({
      resolvedForActorId: EXPERT_USER_ID,
      expertUserId: EXPERT_USER_ID,
      agency: { agencyId: AGENCY_ID, actorRole: null },
    });
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, EXPERT_USER_ID);
  });

  it('returns null for an admin context with no I/O', async () => {
    await expect(resolveHostContext(ADMIN_SUBJECT, EXPERT_USER_ID)).resolves.toBeNull();
    expect(repoCallCounts()).toEqual(NO_REPOSITORY_CALLS);
  });
});

// ── The confused-deputy brand, end to end through the async seam (BAL-413) ───

describe('resolveHostContext brands the context with the actor it was resolved FOR', () => {
  /**
   * The pure-core half of this guard lives in `@balo/shared/authz`'s `engagement.test.ts`.
   * THIS half proves the async resolver actually stamps the ACTOR — not the delivering
   * expert, not the agency — so the two halves cannot pass while disagreeing about which
   * id the brand carries. Without that, the core could be correct and the resolver could
   * still stamp `expertUserId`, which would re-open the escalation for every caller.
   */
  it.each([
    ['an agency admin', 'user_agency_admin', 'admin'],
    ['a non-member stranger', 'user_stranger', undefined],
    ['the delivering expert themselves', EXPERT_USER_ID, undefined],
  ])('stamps %s’s own id on the agency path', async (_label, actorId, role) => {
    mockGetMemberRole.mockResolvedValue(role);
    const context = await resolveHostContext(CASE_SUBJECT, actorId);
    expect(context?.resolvedForActorId).toBe(actorId);
    // …and never the delivering expert's id, unless they ARE the actor.
    expect(context?.expertUserId).toBe(EXPERT_USER_ID);
  });

  it('stamps the actor on the INDEPENDENT-expert path too (no agency lookup happens)', async () => {
    mockFindProfileById.mockResolvedValue(INDEPENDENT_EXPERT);
    const context = await resolveHostContext(CASE_SUBJECT, 'user_stranger');
    expect(context).toEqual({
      resolvedForActorId: 'user_stranger',
      expertUserId: EXPERT_USER_ID,
      agency: null,
    });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('makes RESOLVE-ONCE / CHECK-MANY fail closed — the confused-deputy attack, end to end', async () => {
    // The exact misuse `resolveHostContext` being exported invites: resolve as a
    // privileged actor, then wave every other participant through the same context.
    mockGetMemberRole.mockResolvedValue('owner');
    const ownersContext = await resolveHostContext(CASE_SUBJECT, 'user_agency_owner');

    for (const token of ALL_TOKENS) {
      expect(hostContextGrants(ownersContext, { id: 'user_agency_owner' }, token)).toBe(true);
      expect(hostContextGrants(ownersContext, { id: 'user_attacker' }, token)).toBe(false);
      // Including the delivering expert, who would otherwise pass the identity branch.
      expect(hostContextGrants(ownersContext, { id: EXPERT_USER_ID }, token)).toBe(false);
    }
  });
});
