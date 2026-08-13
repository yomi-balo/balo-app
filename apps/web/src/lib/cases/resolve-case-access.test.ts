import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the case surface's READ gate.
 *
 * ⚠⚠ THE MOCK BOUNDARY IS `@balo/db`, NOT `authorize-conversation-context`, AND THAT IS THE
 * WHOLE VALUE OF THIS FILE. `resolveCaseAccess` is a thin adapter; mocking the gate beneath it
 * would leave nothing but a rename under test. Mocking only the four repositories means the
 * REAL resolution chain runs — `actorHasExpertSideVisibility`, `roleHasCapability` and the
 * membership-before-state ordering all included — so the width assertions below are assertions
 * about the SHIPPED RULE rather than about a fixture someone wrote.
 *
 * ⚠⚠ THE EXPERT-SIDE WIDTH IS PINNED ON PURPOSE, INCLUDING AGENCY ROLE `expert`.
 * CLAUDE.md and ADR-1046 §7 (resolved 2026-08-03) record it as DELIBERATE AND PERMANENT:
 * "visibility (delivering expert ∪ any live agency member) and act rights (delivering expert ∪
 * agency owner/admin) are different rules by design. Do not narrow it." The narrower ACT axis
 * is pinned in `lib/authz/engagement.test.ts`, which refuses role `expert`. The two files
 * disagreeing is CORRECT; a change that made them agree is the regression.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000002';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000003';
const AGENCY_ID = 'a0000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000005';

const EXPERT_USER_ID = 'u0000000-0000-4000-8000-00000000000e';
const CLIENT_USER_ID = 'u0000000-0000-4000-8000-00000000000c';
const COLLEAGUE_ID = 'u0000000-0000-4000-8000-00000000000a';
const STRANGER_ID = 'u0000000-0000-4000-8000-00000000000f';

vi.mock('server-only', () => ({}));

const mockFindEngagement = vi.fn();
const mockGetMemberRole = vi.fn();
const mockFindProfile = vi.fn();
const mockFindConversation = vi.fn();

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
  expertsRepository: { findProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  conversationsRepository: { findByContext: (...a: unknown[]) => mockFindConversation(...a) },
}));

import { resolveCaseAccess } from './resolve-case-access';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    status: 'active',
  });
  mockFindProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
  mockFindConversation.mockResolvedValue({ id: CONVERSATION_ID });
  mockGetMemberRole.mockResolvedValue(undefined);
});

/** `getMemberRole` returning `role` for exactly one (party, partyId, userId) triple. */
function membership(party: string, partyId: string, userId: string, role: string): void {
  mockGetMemberRole.mockImplementation((p: string, id: string, u: string) =>
    Promise.resolve(p === party && id === partyId && u === userId ? role : undefined)
  );
}

describe('resolveCaseAccess — the CLIENT arm (membership axis, company scope)', () => {
  it.each([['owner'], ['admin'], ['member']])(
    'admits company role %s — every company role carries PARTICIPATE',
    async (role) => {
      membership('company', COMPANY_ID, CLIENT_USER_ID, role);
      const access = await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
      expect(access?.lens).toBe('client');
    }
  );

  it('reports the engagement row companyId and expertProfileId, not anything from input', async () => {
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    const access = await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
    expect(access).toEqual({
      lens: 'client',
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      engagementStatus: 'active',
      conversationId: CONVERSATION_ID,
      conversationWritable: true,
    });
  });

  it('never reaches the expert arm for a company member — the two can never both fire', async () => {
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
    expect(mockFindProfile).not.toHaveBeenCalled();
  });

  it('refuses a company role that carries NO capability', async () => {
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'observer');
    expect(await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID)).toBeNull();
  });
});

describe('resolveCaseAccess — the EXPERT arm is the shipped VISIBILITY rule, deliberately WIDE', () => {
  it('admits the DELIVERING expert, with no agency lookup at all', async () => {
    const access = await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID);
    expect(access?.lens).toBe('expert');
    // Arm 1 short-circuits on `profile.userId === userId`. Only the company lookup ran.
    expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, EXPERT_USER_ID);
  });

  it('admits an INDEPENDENT delivering expert (agencyId null) with no agency lookup', async () => {
    mockFindProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });
    const access = await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID);
    expect(access?.lens).toBe('expert');
    expect(mockGetMemberRole).not.toHaveBeenCalledWith(
      'agency',
      expect.anything(),
      expect.anything()
    );
  });

  it.each([['owner'], ['admin']])('admits agency %s', async (role) => {
    membership('agency', AGENCY_ID, COLLEAGUE_ID, role);
    expect((await resolveCaseAccess(ENGAGEMENT_ID, COLLEAGUE_ID))?.lens).toBe('expert');
  });

  /**
   * ⚠⚠ THE ASSERTION NOBODY MAY "TIGHTEN". Agency role `expert` READS the whole case surface.
   * It is REFUSED the act (`lib/authz/engagement.test.ts` pins that), and the gap between the
   * two is the design. If this test ever fails, the fix is to revert the narrowing — not to
   * update this expectation. ADR-1046 §7 · CLAUDE.md · BAL-419.
   */
  it('ADMITS agency role `expert` — MEMBERSHIP EXISTING GRANTS. DO NOT NARROW (ADR-1046 §7)', async () => {
    membership('agency', AGENCY_ID, COLLEAGUE_ID, 'expert');
    const access = await resolveCaseAccess(ENGAGEMENT_ID, COLLEAGUE_ID);
    expect(access).not.toBeNull();
    expect(access?.lens).toBe('expert');
  });

  it('admits an UNKNOWN agency role too — the question is "inside the agency", not "which token"', async () => {
    // `actorHasExpertSideVisibility` tests `agencyRole !== undefined`, deliberately NOT
    // `roleHasCapability`. A future agency role must not silently lose read access.
    membership('agency', AGENCY_ID, COLLEAGUE_ID, 'finance');
    expect((await resolveCaseAccess(ENGAGEMENT_ID, COLLEAGUE_ID))?.lens).toBe('expert');
  });

  it('refuses a member of a DIFFERENT agency', async () => {
    membership('agency', 'some-other-agency', COLLEAGUE_ID, 'owner');
    expect(await resolveCaseAccess(ENGAGEMENT_ID, COLLEAGUE_ID)).toBeNull();
  });
});

describe('resolveCaseAccess — a stranger is refused, indistinguishably from not-found', () => {
  it('refuses a stranger with membership NOWHERE', async () => {
    expect(await resolveCaseAccess(ENGAGEMENT_ID, STRANGER_ID)).toBeNull();
  });

  /**
   * ⚠⚠ THE ANTI-ORACLE PROPERTY. Every denial shape collapses into ONE `null`; the shape goes
   * to `log.warn` with a distinct `reason`, never to the caller. Without this, any self-serve
   * signup could distinguish "this uuid is a live case I may not read" from "this uuid is
   * nothing" — an existence oracle over every `engagements.id` on the platform.
   */
  it('a CROSS-TENANT case and a NON-EXISTENT one are the SAME answer', async () => {
    const crossTenant = await resolveCaseAccess(ENGAGEMENT_ID, STRANGER_ID);

    mockFindEngagement.mockResolvedValue(undefined);
    const missing = await resolveCaseAccess(ENGAGEMENT_ID, STRANGER_ID);

    expect(crossTenant).toBeNull();
    expect(missing).toBeNull();
    expect(crossTenant).toEqual(missing);
  });

  it('a SOFT-DELETED case is the same answer (findById filters deleted_at)', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID)).toBeNull();
  });

  it('a missing EXPERT PROFILE is the same answer, even for a real would-be reader', async () => {
    mockFindProfile.mockResolvedValue(undefined);
    expect(await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID)).toBeNull();
  });

  it('a missing THREAD is the same answer — the accepted coupling, stated in the docblock', async () => {
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    mockFindConversation.mockResolvedValue(undefined);
    expect(await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID)).toBeNull();
  });

  it('never names the thread before authorization completes', async () => {
    // "AUTHORIZATION IS COMPLETE ABOVE THIS LINE. Only now may we name the thread."
    await resolveCaseAccess(ENGAGEMENT_ID, STRANGER_ID);
    expect(mockFindConversation).not.toHaveBeenCalled();
  });

  it('reads the thread, never MINTS one — a gate must not create rows', async () => {
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
    expect(mockFindConversation).toHaveBeenCalledWith({
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
    });
  });
});

/**
 * Read access and WRITE access are separate questions. A closed case stays fully READABLE by
 * everyone who could read it while it was open — the gate decides only the first.
 */
describe('resolveCaseAccess — conversationWritable is composed once, here', () => {
  it.each([
    ['active', true],
    ['completed', false],
    ['cancelled', false],
  ])('status %s ⇒ writable %s', async (status, writable) => {
    mockFindEngagement.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      status,
    });
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    const access = await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
    expect(access?.conversationWritable).toBe(writable);
  });

  it('a CLOSED case is still fully readable — read and write are different questions', async () => {
    mockFindEngagement.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      status: 'completed',
    });
    membership('company', COMPANY_ID, CLIENT_USER_ID, 'member');
    const access = await resolveCaseAccess(ENGAGEMENT_ID, CLIENT_USER_ID);
    expect(access).not.toBeNull();
    expect(access?.lens).toBe('client');
    expect(access?.conversationWritable).toBe(false);
  });
});

describe('resolveCaseAccess — the lens is resolved server-side, never from a toggle', () => {
  it('gives the SAME person a different lens on a different case, from the row alone', async () => {
    // One user who is both a company member on one case and the delivering expert on another.
    // `activeMode` is nowhere in this module; the lens follows the engagement's own row.
    membership('company', COMPANY_ID, EXPERT_USER_ID, 'member');
    expect((await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID))?.lens).toBe('client');

    mockGetMemberRole.mockResolvedValue(undefined);
    expect((await resolveCaseAccess(ENGAGEMENT_ID, EXPERT_USER_ID))?.lens).toBe('expert');
  });
});
