import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEngagementFindById, mockProjectRequestFindById, mockGetMemberRole } = vi.hoisted(
  () => ({
    mockEngagementFindById: vi.fn(),
    mockProjectRequestFindById: vi.fn(),
    mockGetMemberRole: vi.fn(),
  })
);

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: mockEngagementFindById },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));
// NOTE: `@balo/shared/authz` is deliberately NOT mocked — the real, pure `roleHasCapability`
// map is the thing under test at the capability step (owner/admin/member hold PARTICIPATE;
// an unknown role holds nothing).

import { authorizeMeetingBooking } from './authorize-meeting-booking.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const CONTEXT_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMemberRole.mockResolvedValue('member');
});

/**
 * The `engagements` row shape the gate reads — company, type, coarse status, expert. Defined
 * ONCE so every case states only what it is varying, and so adding a fourth column the gate
 * consults is a one-line change here rather than an eight-site sweep (which is exactly how the
 * `status` column came to be missing from all of them).
 */
function engagementRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    companyId: COMPANY_ID,
    engagementType: 'case',
    status: 'active',
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

/** The gate call under test, for the default `case` label. */
const authorizeCase = (): Promise<unknown> =>
  authorizeMeetingBooking({ contextType: 'case', contextId: CONTEXT_ID, userId: USER_ID });

describe('per-context-type resolution of the owning party', () => {
  it.each([
    { contextType: 'case', engagementType: 'case' },
    { contextType: 'project_kickoff', engagementType: 'project' },
    { contextType: 'package_session', engagementType: 'package' },
  ] as const)(
    '$contextType reads engagements and returns engagementType "$engagementType"',
    async ({ contextType, engagementType }) => {
      mockEngagementFindById.mockResolvedValue(engagementRow({ engagementType }));

      const result = await authorizeMeetingBooking({
        contextType,
        contextId: CONTEXT_ID,
        userId: USER_ID,
      });

      expect(result).toEqual({
        ok: true,
        companyId: COMPANY_ID,
        engagementType,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      expect(mockEngagementFindById).toHaveBeenCalledWith(CONTEXT_ID);
      expect(mockProjectRequestFindById).not.toHaveBeenCalled();
      // The membership check runs against the company the SUBJECT named, never one supplied
      // by the caller — that is the whole tenancy guarantee.
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
    }
  );

  it('project_discovery reads project_requests and returns a NULL engagementType', async () => {
    // D4: a discovery call anchors on a `project_requests.id` and has NO engagement, so
    // there is no supertype discriminator to read. Fabricating one would corrupt the funnel.
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    const result = await authorizeMeetingBooking({
      contextType: 'project_discovery',
      contextId: CONTEXT_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({
      ok: true,
      companyId: COMPANY_ID,
      engagementType: null,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect(mockProjectRequestFindById).toHaveBeenCalledWith(CONTEXT_ID);
    expect(mockEngagementFindById).not.toHaveBeenCalled();
  });
});

describe('the resolved expertProfileId is threaded back', () => {
  /**
   * ⚠ IT IS NOT A CONVENIENCE. The caller's two aggregate availability-DoS bounds — the
   * per-(user, expert) rate limit and `isWindowAvailableForExpert` — must act on the SAME
   * expert the consultation projection will resolve at write time. Reading it off the row the
   * gate already loaded for `companyId` is free and makes the two unable to disagree; a second
   * lookup in the route would be a second place they could.
   */
  it('reads it off the engagement row the gate already loaded — no second read', async () => {
    mockEngagementFindById.mockResolvedValue(engagementRow());

    const result = (await authorizeCase()) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, expertProfileId: EXPERT_PROFILE_ID });
    expect(mockEngagementFindById).toHaveBeenCalledTimes(1);
  });

  it('is NULL for a match-routed project request — nobody to rate-limit or check', async () => {
    // The repository then throws `MatchModeDiscoveryNotBookableError`, which the route maps to
    // `409 discovery_not_routed`. So a null expert is a SKIP of the expert-scoped guards, not
    // a bypass of them.
    mockProjectRequestFindById.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });

    await expect(
      authorizeMeetingBooking({
        contextType: 'project_discovery',
        contextId: CONTEXT_ID,
        userId: USER_ID,
      })
    ).resolves.toEqual({
      ok: true,
      companyId: COMPANY_ID,
      engagementType: null,
      expertProfileId: null,
    });
  });
});

describe('missing or soft-deleted subjects', () => {
  it('context_not_found when the engagement does not resolve', async () => {
    // Both repository reads already filter `deleted_at IS NULL`, so missing and soft-deleted
    // collapse to the same `undefined` — and to the same literal, which hands a prober nothing.
    mockEngagementFindById.mockResolvedValue(undefined);

    const result = (await authorizeCase()) as Record<string, unknown>;

    expect(result).toEqual({ ok: false, code: 'context_not_found' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('context_not_found when the project request does not resolve', async () => {
    mockProjectRequestFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingBooking({
      contextType: 'project_discovery',
      contextId: CONTEXT_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'context_not_found' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });
});

describe('the membership gate — fail-closed, PARTICIPATE, company scope', () => {
  beforeEach(() => {
    mockEngagementFindById.mockResolvedValue(engagementRow());
  });

  it('THE CROSS-TENANT CASE: context_not_found when the actor holds no membership on the owning company', async () => {
    // This is the denial-of-service `schema/meeting-contexts.ts` names BAL-129 as carrying:
    // `context_id` has no FK and no RLS, so without this the booking would resolve happily to
    // a stranger's expert and block their calendar.
    mockGetMemberRole.mockResolvedValue(undefined);

    const result = (await authorizeCase()) as Record<string, unknown>;

    expect(result).toEqual({ ok: false, code: 'context_not_found' });
  });

  it('AN EXPERT-SIDE ACTOR MAY NOT BOOK — no company_members row means context_not_found', async () => {
    // Deliberate (§5.6). An expert is an agency member; the gate resolves COMPANY membership
    // only. Do not "fix" this with an agency-membership fallback.
    mockGetMemberRole.mockResolvedValue(undefined);

    await expect(authorizeCase()).resolves.toEqual({ ok: false, code: 'context_not_found' });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it.each(['owner', 'admin', 'member'])(
    'allows a company `%s` — every role holds PARTICIPATE',
    async (role) => {
      mockGetMemberRole.mockResolvedValue(role);

      await expect(authorizeCase()).resolves.toEqual({
        ok: true,
        companyId: COMPANY_ID,
        engagementType: 'case',
        expertProfileId: EXPERT_PROFILE_ID,
      });
    }
  );

  it('context_not_found for an unknown role string — the capability map grants nothing by default', async () => {
    mockGetMemberRole.mockResolvedValue('finance');

    await expect(authorizeCase()).resolves.toEqual({ ok: false, code: 'context_not_found' });
  });
});

describe('THE GATE IS NOT A CROSS-TENANT EXISTENCE-OR-TYPE ORACLE', () => {
  /**
   * ⚠ THE REGRESSION THIS BLOCK EXISTS FOR. The first version ran the engagement-type
   * coherence check BEFORE the membership read, so an actor with no membership anywhere could
   * distinguish three states of a guessed `engagements.id` from the status code alone:
   *
   *   · not a live engagement                      → 404 context_not_found
   *   · someone else's engagement, WRONG label     → 400 context_type_mismatch
   *   · someone else's engagement, RIGHT label     → 403 forbidden
   *
   * That is an existence AND type oracle over every engagement on the platform, readable by
   * any self-serve signup. Both fixes are asserted here: membership is checked FIRST, and the
   * two denial shapes collapse into ONE literal (there is no `forbidden` code at all — the
   * `sessionActorErrorStatus` "also hides existence" precedent).
   */
  it('a NON-MEMBER gets context_not_found even when the label MISMATCHES the engagement type', async () => {
    mockEngagementFindById.mockResolvedValue(engagementRow({ engagementType: 'project' }));
    mockGetMemberRole.mockResolvedValue(undefined);

    await expect(authorizeCase()).resolves.toEqual({ ok: false, code: 'context_not_found' });
    // The membership read HAPPENED — the ordering, not just the literal, is what closes it.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('a non-member sees the SAME literal for a live engagement and a nonexistent one', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);

    mockEngagementFindById.mockResolvedValue(engagementRow());
    const live = await authorizeCase();

    mockEngagementFindById.mockResolvedValue(undefined);
    const missing = await authorizeCase();

    expect(live).toEqual(missing);
  });
});

describe('the engagement must still be ACTIVE — a closed case is not a booking handle', () => {
  /**
   * ⚠ THE DEFECT THIS BLOCK CLOSES. `engagements.status` was never read, and the enum is
   * exactly `active | completed | cancelled` — so a `completed` case (written by
   * `caseEngagementsRepository.close()` and never cleared) stayed a DURABLE handle for booking
   * that expert's calendar forever. Each such booking writes a `confirmed` consultation the
   * availability resolver subtracts from real availability, so the harm compounds silently.
   */
  beforeEach(() => {
    mockGetMemberRole.mockResolvedValue('member');
  });

  it.each(['completed', 'cancelled'] as const)(
    'context_not_found for a `%s` engagement, even for a proven member',
    async (status) => {
      mockEngagementFindById.mockResolvedValue(engagementRow({ status }));

      await expect(authorizeCase()).resolves.toEqual({ ok: false, code: 'context_not_found' });
    }
  );

  it('uses `context_not_found`, NOT a distinct literal — §3’s oracle decision holds', async () => {
    // A `context_completed` code would tell a prober "that uuid IS a real engagement, just a
    // finished one". Every denial an outsider can reach stays indistinguishable on the wire.
    mockEngagementFindById.mockResolvedValue(engagementRow({ status: 'completed' }));
    const closed = await authorizeCase();

    mockEngagementFindById.mockResolvedValue(undefined);
    const missing = await authorizeCase();

    expect(closed).toEqual(missing);
  });

  it('runs AFTER the membership read — a non-member never reaches it', async () => {
    // Same ordering rule as the coherence check: a status check in front of the membership read
    // would be a cross-tenant liveness oracle over every engagement on the platform.
    mockEngagementFindById.mockResolvedValue(engagementRow({ status: 'completed' }));
    mockGetMemberRole.mockResolvedValue(undefined);

    await expect(authorizeCase()).resolves.toEqual({ ok: false, code: 'context_not_found' });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('does NOT apply to project_discovery — a request row has no engagement lifecycle', async () => {
    // The discovery arm anchors on `project_requests.id`, which carries no
    // `engagement_status`. Its subject loads `status: null`, and the check is inside the
    // engagement branch, so a routed discovery request stays bookable.
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    await expect(
      authorizeMeetingBooking({
        contextType: 'project_discovery',
        contextId: CONTEXT_ID,
        userId: USER_ID,
      })
    ).resolves.toMatchObject({ ok: true, expertProfileId: EXPERT_PROFILE_ID });
  });
});

describe('the engagement-type / context-label coherence check', () => {
  beforeEach(() => {
    // ⚠ EVERY CASE HERE IS A PROVEN MEMBER. That is now a precondition of reaching this check
    // at all — see the oracle block above.
    mockGetMemberRole.mockResolvedValue('member');
  });

  it('context_type_mismatch when a `case` label names a `project` engagement', async () => {
    // Harmless for tenancy, corrupting for D4's analytics — a member could otherwise label
    // their own case engagement `project_kickoff` and the funnel would record the claim.
    mockEngagementFindById.mockResolvedValue(engagementRow({ engagementType: 'project' }));

    const result = (await authorizeCase()) as Record<string, unknown>;

    expect(result).toEqual({ ok: false, code: 'context_type_mismatch' });
    // And it is returned ONLY to a member, for whom the row's existence is not a secret.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('context_type_mismatch when a `package_session` label names a `retainer` engagement', async () => {
    mockEngagementFindById.mockResolvedValue(engagementRow({ engagementType: 'retainer' }));

    const result = await authorizeMeetingBooking({
      contextType: 'package_session',
      contextId: CONTEXT_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'context_type_mismatch' });
  });
});
