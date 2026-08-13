import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@balo/shared/testing';

vi.mock('server-only', () => ({}));

const {
  mockEngagementFindById,
  mockFindProfileById,
  mockGetMemberRole,
  mockFindByContext,
  mockEnsureForContext,
} = vi.hoisted(() => ({
  mockEngagementFindById: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindByContext: vi.fn(),
  mockEnsureForContext: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...args: unknown[]) => mockEngagementFindById(...args) },
  expertsRepository: { findProfileById: (...args: unknown[]) => mockFindProfileById(...args) },
  partyMembershipsRepository: {
    getMemberRole: (...args: unknown[]) => mockGetMemberRole(...args),
  },
  conversationsRepository: {
    findByContext: (...args: unknown[]) => mockFindByContext(...args),
    ensureForContext: (...args: unknown[]) => mockEnsureForContext(...args),
  },
}));

import { authorizeEngagementConversation } from './authorize-conversation-context';
import { log } from '@/lib/logging';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const AGENCY_ID = 'd0000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'e0000000-0000-4000-8000-000000000005';

const CLIENT_USER_ID = 'user-client';
const EXPERT_USER_ID = 'user-expert';
const COLLEAGUE_USER_ID = 'user-colleague';
const STRANGER_USER_ID = 'user-stranger';

const NOT_FOUND = { ok: false, code: 'conversation_not_found' };

function engagement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'active',
    ...overrides,
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

describe('authorizeEngagementConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngagementFindById.mockResolvedValue(engagement());
    mockFindProfileById.mockResolvedValue(profile());
    mockGetMemberRole.mockResolvedValue(undefined);
    mockFindByContext.mockResolvedValue({ id: CONVERSATION_ID });
  });

  // ── The client arm: membership axis, company scope, PARTICIPATE ──────
  describe('client side', () => {
    it('grants a company member and names the thread', async () => {
      mockGetMemberRole.mockResolvedValue('member');
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(result).toEqual({
        ok: true,
        side: 'client',
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        engagementStatus: 'active',
        conversationId: CONVERSATION_ID,
      });
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, CLIENT_USER_ID);
      // ⚠ A READ, never `ensureForContext` — a gate must not mint rows.
      expect(mockFindByContext).toHaveBeenCalledWith({
        contextType: 'engagement',
        contextId: ENGAGEMENT_ID,
      });
      expect(mockEnsureForContext).not.toHaveBeenCalled();
    });

    it('denies a company member whose role lacks PARTICIPATE, and never falls through to the expert arm', async () => {
      // A role string outside the shipped map holds no capability at all.
      mockGetMemberRole.mockResolvedValue('spectator');
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
      // The two arms cannot both fire: holding a company membership settles the side.
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });
  });

  // ── The expert arm: the SHIPPED VISIBILITY rule ─────────────────────
  describe('expert side', () => {
    /**
     * ⚠ THE INDEPENDENT-EXPERT SHORT-CIRCUIT. `agencyId === null` must resolve on
     * `profile.userId === userId` alone — asserting the agency lookup was NOT performed is
     * what pins that (a `getMemberRole('agency', null, …)` would be a bug).
     */
    it('grants an INDEPENDENT delivering expert with no agency lookup', async () => {
      mockFindProfileById.mockResolvedValue(profile({ agencyId: null }));
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: EXPERT_USER_ID,
      });
      expect(result).toMatchObject({ ok: true, side: 'expert' });
      expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, EXPERT_USER_ID);
    });

    /**
     * ⚠ THE SHORT-CIRCUIT CASE A LAZY→EAGER REFACTOR ACTUALLY BREAKS. The independent-expert
     * test above cannot catch one: with `agencyId === null` no lookup is POSSIBLE either way.
     * Here `profile.agencyId` is a real id, so a predicate that resolved the agency role
     * eagerly would issue a DB round-trip that today never happens — while still answering
     * `true`, and so passing every other assertion in this file. The COUNT is therefore the
     * assertion, not the verdict: exactly ONE membership read, the company arm that ran before
     * the expert arm was reached. (Mutation-verified in the BAL-419 review, where this suite
     * was one of the two that let the eager mutant through.)
     */
    it('grants the delivering expert of an agency-based profile, with NO agency lookup', async () => {
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: EXPERT_USER_ID,
      });
      expect(result).toMatchObject({ ok: true, side: 'expert' });
      expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, EXPERT_USER_ID);
    });

    /**
     * ⚠⚠ THIS TEST IS THE 2026-08-11 RULING, PINNED. The expert arm consumes the SHIPPED
     * VISIBILITY rule (`actorHasExpertSideVisibility`, `@balo/shared/authz`): the delivering
     * expert ∪ ANY live agency member, INCLUDING agency role `expert`. That set is WIDER than the
     * ADR-1046 engagement-axis holder set (which excludes role `expert`), because visibility
     * and act rights are different rules by design — ADR-1046 §7, "Do not narrow it".
     *
     * BAL-419 SETTLED IT — confirmed, not narrowed. The single `agencyRole !== undefined`
     * branch now lives in `@balo/shared/authz`'s `actorHasExpertSideVisibility`, which this
     * module CONSUMES (pinned by the delegation scan in `axis discipline` below).
     */
    it.each(['owner', 'admin', 'expert'])(
      'grants an agency colleague with role %s — membership EXISTING is the rule',
      async (agencyRole) => {
        mockGetMemberRole.mockImplementation((partyType: string) =>
          Promise.resolve(partyType === 'agency' ? agencyRole : undefined)
        );
        const result = await authorizeEngagementConversation({
          engagementId: ENGAGEMENT_ID,
          userId: COLLEAGUE_USER_ID,
        });
        expect(result).toMatchObject({ ok: true, side: 'expert' });
        expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, COLLEAGUE_USER_ID);
      }
    );

    it('denies a member of a DIFFERENT agency with the same literal', async () => {
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: STRANGER_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
      expect(log.warn).toHaveBeenCalledWith(
        'Engagement conversation access denied',
        expect.objectContaining({ reason: 'cross_tenant' })
      );
    });

    it('denies when the expert profile is missing', async () => {
      mockFindProfileById.mockResolvedValue(undefined);
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: STRANGER_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
    });
  });

  // ── Ordering + the single literal ───────────────────────────────────
  describe('denials collapse to one literal', () => {
    it('denies a missing OR soft-deleted engagement identically', async () => {
      // `findById` filters `deleted_at IS NULL`, so both shapes arrive as `undefined`.
      mockEngagementFindById.mockResolvedValue(undefined);
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
      expect(mockGetMemberRole).not.toHaveBeenCalled();
      expect(mockFindByContext).not.toHaveBeenCalled();
    });

    it('denies a non-member of either party with the same literal', async () => {
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: STRANGER_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
    });

    it('denies when the engagement has no thread yet', async () => {
      mockGetMemberRole.mockResolvedValue('member');
      mockFindByContext.mockResolvedValue(undefined);
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
    });

    /**
     * ⚠ AUTHORIZATION RUNS BEFORE ANY STATE OR COHERENCE READ. Otherwise an actor with
     * membership NOWHERE could distinguish states of a GUESSED uuid by response alone — an
     * existence oracle over every `engagements.id` on the platform.
     */
    it('resolves membership BEFORE it ever looks up the thread', async () => {
      const order: string[] = [];
      mockGetMemberRole.mockImplementation(() => {
        order.push('membership');
        return Promise.resolve('member');
      });
      mockFindByContext.mockImplementation(() => {
        order.push('thread');
        return Promise.resolve({ id: CONVERSATION_ID });
      });
      await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(order).toEqual(['membership', 'thread']);
    });

    it('reports which shape it was to the LOG only, never to the wire', async () => {
      mockGetMemberRole.mockResolvedValue('spectator');
      const result = await authorizeEngagementConversation({
        engagementId: ENGAGEMENT_ID,
        userId: CLIENT_USER_ID,
      });
      expect(result).toEqual(NOT_FOUND);
      expect(log.warn).toHaveBeenCalledWith(
        'Engagement conversation access denied',
        expect.objectContaining({ reason: 'no_capability' })
      );
    });
  });

  // ── Status is REPORTED, never enforced here ─────────────────────────
  it('authorizes a CLOSED engagement and reports its status for the caller to compose', async () => {
    // Read access and WRITE access are different questions: a closed case stays readable by
    // everyone who could read it while it was open. `engagementConversationIsWritable` is
    // the caller's composition step, not this gate's.
    mockEngagementFindById.mockResolvedValue(engagement({ status: 'completed' }));
    mockGetMemberRole.mockResolvedValue('member');
    const result = await authorizeEngagementConversation({
      engagementId: ENGAGEMENT_ID,
      userId: CLIENT_USER_ID,
    });
    expect(result).toMatchObject({ ok: true, engagementStatus: 'completed' });
  });
});

/**
 * ⚠⚠ THE STATIC IMPORT GUARD — the 2026-08-11 ruling's other half.
 *
 * `hasEngagementCapability`'s two tokens (`host_meetings`, `manage_engagement`) authorize the
 * ACT, never the READ; reading a thread is not an act, so gating this module on that axis
 * would be a category error WHEREVER the module lived. It would also deny the wrong people —
 * that holder set excludes agency role `expert`, the colleagues most likely to need a
 * delivery thread. This module must therefore never reach for it.
 *
 * ⚠ THE `apps/web` SEAM IS NOW OPEN — BAL-421 opened it (`lib/authz/engagement.ts`), not
 * BAL-410/BAL-411 as originally deferred. THAT MAKES THIS GUARD MORE LOAD-BEARING, NOT LESS:
 * the import is now merely a keystroke away rather than impossible, so the assertion below is
 * the only thing keeping a READ gate off the ACT axis. Do not relax it.
 */
describe('axis discipline', () => {
  /**
   * ⚠ `stripComments` COMES FROM `@balo/shared/testing`, NOT A LOCAL REGEX. The naive
   * `/\/\*[\s\S]*?\*\//g` shape this suite used before is super-linear (SonarCloud S5852 —
   * `[\s\S]` does not exclude the terminator, so an unterminated block comment backtracks
   * O(n²)). The shared helper is an indexOf scan with zero ReDoS surface, and hoisting it to
   * describe scope lets both assertions below share one read.
   */
  const raw = readFileSync(join(import.meta.dirname, 'authorize-conversation-context.ts'), 'utf8');
  const code = stripComments(raw);

  it('reads its own source, and the stripper really ran (guards against a vacuous pass)', () => {
    // If the read ever broke, every assertion below would pass for free — and so would they
    // if `stripComments` silently became a no-op, because this module's docblocks NAME the
    // identifiers scanned below (`hasEngagementCapability`, `agencyRole`), precisely to
    // explain why they are absent from the code. Pinned on comment SYNTAX rather than on any
    // particular sentence, so ordinary prose edits cannot make this guard rot.
    expect(code).toContain('export async function authorizeEngagementConversation');
    expect(raw).toContain('/**');
    expect(code).not.toContain('/**');
    expect(code).not.toContain('//');
  });

  it('never imports hasEngagementCapability', () => {
    expect(code).not.toContain('hasEngagementCapability');
    expect(code).not.toContain('HOST_MEETINGS');
    expect(code).not.toContain('MANAGE_ENGAGEMENT');
  });

  /**
   * ⚠ ONE DEFINITION OF EXPERT-SIDE VISIBILITY, PINNED MECHANICALLY (BAL-419 / ADR-1046 §7).
   * The expert arm must CONSUME `actorHasExpertSideVisibility` from `@balo/shared/authz` —
   * the single definition on this platform — rather than re-deriving `agencyRole !== undefined`
   * locally, which could silently diverge from the answer the other two gates give about the
   * SAME agency colleague. A drift alarm, not the guarantee: the guarantee is the
   * visibility-vs-act table in `packages/shared/src/authz/expert-side-visibility.test.ts`.
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
