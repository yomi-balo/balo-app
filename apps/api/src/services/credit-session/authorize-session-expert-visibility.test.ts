import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

const { mockFindById, mockFindProfileById, mockGetMemberRole, mockFindEngagementById } = vi.hoisted(
  () => ({
    mockFindById: vi.fn(),
    mockFindProfileById: vi.fn(),
    mockGetMemberRole: vi.fn(),
    mockFindEngagementById: vi.fn(),
  })
);

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findById: mockFindById },
  engagementsRepository: { findById: mockFindEngagementById },
  expertsRepository: { findProfileById: mockFindProfileById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

import { authorizeSessionExpertVisibility } from './authorize-session-expert-visibility.js';

const SESSION = {
  id: 'session_1',
  companyId: 'company_1',
  expertProfileId: 'expert_1',
  engagementId: null,
};

describe('authorizeSessionExpertVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(SESSION);
  });

  it('returns not_found when the session is missing/soft-deleted (never leaks existence)', async () => {
    mockFindById.mockResolvedValue(undefined);
    const res = await authorizeSessionExpertVisibility({ sessionId: 'nope', userId: 'user_1' });
    expect(res).toEqual({ ok: false, code: 'not_found' });
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });

  it('grants an INDEPENDENT expert (userId === profile.userId)', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1', agencyId: null });
    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'expert_user_1',
    });
    expect(res).toEqual({ ok: true, session: SESSION, expertProfileId: 'expert_1' });
    // No agency lookup needed for the independent expert.
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE OTHER HALF OF THE SHORT-CIRCUIT, AND THE ONE A LAZY→EAGER REFACTOR ACTUALLY BREAKS.
   * The test above only pins `agencyId: null`, where no lookup is POSSIBLE — so it survives a
   * predicate that resolves the agency role eagerly. The DELIVERING EXPERT OF AN AGENCY
   * PROFILE is the case that distinguishes them: `profile.agencyId` is a real id, so an eager
   * implementation would issue a DB round-trip that today never happens, while still answering
   * `true`. Without this test the module docblock's "asserted by call-count" claim is false
   * here (mutation-verified in the BAL-419 review).
   */
  it('grants the DELIVERING EXPERT of an AGENCY profile with NO agency lookup at all', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1', agencyId: 'agency_9' });
    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'expert_user_1',
    });
    expect(res).toEqual({ ok: true, session: SESSION, expertProfileId: 'expert_1' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE 2026-08-03 RULING, PINNED (ADR-1046 §7). This gate is the VISIBILITY rule: the
   * delivering expert ∪ ANY live agency member, INCLUDING agency role `expert`. That set is
   * deliberately WIDER than the act-axis holder set (`resolveHostRole`, which excludes role
   * `expert`). The previous version pinned `'member'` — a COMPANY role — so the one case the
   * decision turns on was never covered here. "Do not narrow it."
   */
  it.each(['owner', 'admin', 'expert'])(
    'grants an agency colleague with role %s — VISIBILITY, wider than the act-axis holder set',
    async (agencyRole) => {
      mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_9' });
      mockGetMemberRole.mockResolvedValue(agencyRole);
      const res = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'agency_user',
      });
      expect(res).toEqual({ ok: true, session: SESSION, expertProfileId: 'expert_1' });
      expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'agency_9', 'agency_user');
    }
  );

  it('denies a stranger who is neither the expert nor an agency member (cross-tenant)', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_9' });
    mockGetMemberRole.mockResolvedValue(undefined);
    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'stranger',
    });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
  });

  it('denies when the expert has no agency and the caller is not the expert', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: null });
    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'stranger',
    });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  describe('a session on an engagement reads the engagement pin', () => {
    const ENGAGEMENT_SESSION = { ...SESSION, engagementId: 'eng_1' };

    beforeEach(() => {
      mockFindById.mockResolvedValue(ENGAGEMENT_SESSION);
    });

    it("checks membership of the pinned agency, not the profile's current agency", async () => {
      mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_B' });
      mockFindEngagementById.mockResolvedValue({ id: 'eng_1', deliveringAgencyId: 'agency_A' });
      mockGetMemberRole.mockImplementation(async (_party: string, agencyId: string) =>
        agencyId === 'agency_A' ? 'admin' : undefined
      );

      const res = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'agency_a_admin',
      });

      expect(res).toEqual({ ok: true, session: ENGAGEMENT_SESSION, expertProfileId: 'expert_1' });
      expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'agency_A', 'agency_a_admin');
      expect(mockGetMemberRole).not.toHaveBeenCalledWith('agency', 'agency_B', expect.anything());
    });

    it('denies a member of the profile current agency when the pin names another', async () => {
      mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_B' });
      mockFindEngagementById.mockResolvedValue({ id: 'eng_1', deliveringAgencyId: 'agency_A' });
      mockGetMemberRole.mockImplementation(async (_party: string, agencyId: string) =>
        agencyId === 'agency_B' ? 'owner' : undefined
      );

      const res = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'agency_b_owner',
      });

      expect(res).toEqual({ ok: false, code: 'forbidden' });
    });

    it('a NULL pin grants the expert but no agency colleague, with no agency lookup', async () => {
      mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1', agencyId: 'agency_B' });
      mockFindEngagementById.mockResolvedValue({ id: 'eng_1', deliveringAgencyId: null });

      const expert = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'expert_user_1',
      });
      const colleague = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'colleague',
      });

      expect(expert.ok).toBe(true);
      expect(colleague).toEqual({ ok: false, code: 'forbidden' });
      expect(mockGetMemberRole).not.toHaveBeenCalled();
    });

    it('a missing engagement keeps the expert and denies colleagues', async () => {
      mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1', agencyId: 'agency_B' });
      mockFindEngagementById.mockResolvedValue(undefined);

      const expert = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'expert_user_1',
      });
      const colleague = await authorizeSessionExpertVisibility({
        sessionId: 'session_1',
        userId: 'colleague',
      });

      expect(expert.ok).toBe(true);
      expect(colleague).toEqual({ ok: false, code: 'forbidden' });
      expect(mockGetMemberRole).not.toHaveBeenCalled();
    });
  });

  it('a request-grain session (no engagement) uses the profile agency and reads no engagement', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_9' });
    mockGetMemberRole.mockResolvedValue('admin');

    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'agency_user',
    });

    expect(res.ok).toBe(true);
    expect(mockFindEngagementById).not.toHaveBeenCalled();
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'agency_9', 'agency_user');
  });

  it('denies when the expert profile is missing', async () => {
    mockFindProfileById.mockResolvedValue(undefined);
    const res = await authorizeSessionExpertVisibility({
      sessionId: 'session_1',
      userId: 'user_1',
    });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
  });
});

// ── The one-definition invariant, asserted against the PRODUCTION SOURCE ─────

/**
 * ⚠ ONE DEFINITION OF EXPERT-SIDE VISIBILITY, PINNED MECHANICALLY (BAL-419 / ADR-1046 §7).
 * The two `apps/web` consumers already carry this scan; without it here the invariant held at
 * only TWO of its THREE sites, and a dev re-inlining `agencyRole !== undefined` in this module
 * would break nothing. Precedent: `services/meetings/authorize-engagement-host.test.ts`.
 *
 * A DRIFT ALARM, NOT THE GUARANTEE. The guarantee is the visibility-vs-act table in
 * `packages/shared/src/authz/expert-side-visibility.test.ts`; this stops a SECOND definition
 * from being added here unnoticed.
 *
 * ⚠ `stripComments` COMES FROM `@balo/shared/testing`, NOT A LOCAL REGEX. The naive
 * `/\/\*[\s\S]*?\*\//g` shape is super-linear (SonarCloud S5852 — `[\s\S]` does not exclude
 * the terminator, so an unterminated block comment backtracks O(n²)). The shared helper is an
 * indexOf scan with zero ReDoS surface.
 */
describe('axis discipline — the shared visibility rule is CONSUMED, not redefined', () => {
  const raw = readFileSync(
    fileURLToPath(new URL('./authorize-session-expert-visibility.ts', import.meta.url)),
    'utf8'
  );
  const code = stripComments(raw);

  it('reads its own source, and the stripper really ran (non-vacuity guard)', () => {
    // Without the first line, every assertion below passes for free on a failed read. Without
    // the rest, they pass for free if `stripComments` ever silently became a no-op — and this
    // module's docblock NAMES the identifiers scanned below, so an unstripped scan would
    // assert the prose rather than the code. Pinned on comment SYNTAX rather than on any
    // particular sentence, so ordinary prose edits cannot make the guard rot.
    expect(code).toContain('export async function authorizeSessionExpertVisibility');
    expect(raw).toContain('/**');
    expect(code).not.toContain('/**');
    expect(code).not.toContain('//');
  });

  /**
   * ⚠ THE CALL, NOT MERELY THE SYMBOL. `toContain('actorHasExpertSideVisibility')` alone stays
   * green if the CALL is deleted and the IMPORT left behind — the exact regression this pins
   * against. Matching on the open paren, and counting it, means one call site exactly: zero
   * would be a re-inlined local rule, two an ungoverned second consumer.
   */
  it('delegates the agency arm to the shared predicate — exactly one CALL site', () => {
    expect([...code.matchAll(/actorHasExpertSideVisibility\(/g)]).toHaveLength(1);
  });

  it('defines no local membership branch of its own', () => {
    // The `agencyRole !== undefined` line lives in `@balo/shared/authz` and ONLY there.
    expect(code).not.toContain('agencyRole');
  });
});
