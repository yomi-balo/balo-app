import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the case-surface mutation preamble.
 *
 * ⚠⚠ THE CENTREPIECE IS THE ANTI-ORACLE PROPERTY, AND IT IS TESTED BY DEEP-EQUALITY OF THE
 * WHOLE RESULT, not by `success === false`. `authorizeRecapCaseMutation` gets the property for
 * free by refusing to accept an engagement id at all; here the subject IS the engagement id, so
 * the property survives only because three structurally different refusals were made to return
 * ONE literal. A `success:false` assertion would stay green if someone "helpfully" differentiated
 * the copy ("You don't have access to this case." vs "No such case.") — which is exactly the
 * change that would turn this gate into a readable index of every `engagements.id` on the
 * platform.
 *
 * ⚠ `zod` IS REAL — the strict schema is part of what is under test.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
/** A company the CALLER might wish they were acting in. Never the one the gate reports. */
const ATTACKER_COMPANY_ID = 'c0000000-0000-4000-8000-0000000000ff';

vi.mock('server-only', () => ({}));

const mockFindCase = vi.fn();
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: (...a: unknown[]) => mockFindCase(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

import { authorizeCaseMutation } from './authorize-case-mutation';
import { log } from '@/lib/logging';

const ACCESS = {
  lens: 'client',
  engagementId: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
  engagementStatus: 'active',
  conversationId: 'conv-1',
  conversationWritable: true,
};

const CASE_ROW = { engagementId: ENGAGEMENT_ID, title: 'Flow interview loop', closedAt: null };

const INPUT = { engagementId: ENGAGEMENT_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockFindCase.mockResolvedValue(CASE_ROW);
});

describe('authorizeCaseMutation — the gates, IN ORDER', () => {
  it('1. requires an ONBOARDED session BEFORE anything else runs', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));

    expect(await authorizeCaseMutation(INPUT)).toEqual({
      ok: false,
      error: 'You are not signed in.',
    });
    // Server Actions bypass middleware; this is the only thing between an un-onboarded
    // session and a write, so nothing downstream may have been touched.
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('2. rejects a malformed engagementId BEFORE ANY DB READ', async () => {
    const result = await authorizeCaseMutation({ engagementId: 'not-a-uuid' });
    expect(result).toEqual({ ok: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('2b. the schema is STRICT — an extra key is rejected, never silently ignored', async () => {
    // `engagementId` is the ONLY trusted input. A gate that accepted stray keys is one
    // refactor away from reading one of them.
    const result = await authorizeCaseMutation({
      engagementId: ENGAGEMENT_ID,
      companyId: ATTACKER_COMPANY_ID,
    } as { engagementId: string });
    expect(result).toEqual({ ok: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('3. runs the FULL tenancy gate for the SESSION user, re-derived — never trusting the page', async () => {
    await authorizeCaseMutation(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('4. runs the case-TYPE coherence check AFTER authorization, never before (BAL-129)', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    await authorizeCaseMutation(INPUT);
    // Running `findByEngagementId` first would let a stranger tell "a project engagement"
    // from "someone else's case" from "no such uuid" by response alone.
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('admits, reporting the lens and threading the loaded row back', async () => {
    const result = await authorizeCaseMutation(INPUT);
    expect(result).toEqual({
      ok: true,
      user: { id: USER_ID },
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      lens: 'client',
      caseRow: CASE_ROW,
    });
  });

  it('reports the EXPERT lens unchanged — this gate decides no capability', async () => {
    // "THIS GATE DOES NOT DECIDE THE CAPABILITY … each action then checks its OWN axis."
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, lens: 'expert' });
    const result = await authorizeCaseMutation(INPUT);
    expect(result).toMatchObject({ ok: true, lens: 'expert' });
  });
});

describe('authorizeCaseMutation — companyId comes from the GATE, never from input', () => {
  it('reports the LOADED engagement row companyId', async () => {
    const result = await authorizeCaseMutation(INPUT);
    expect(result).toMatchObject({ ok: true, companyId: COMPANY_ID });
  });

  /**
   * ADR-1029: the company scope is re-derived from the engagement's own row. If it could be
   * influenced by the caller, every downstream `hasCapability(…, { companyId })` would be
   * asking about a company the actor chose — i.e. the actor would be naming the scope they
   * are then checked against, which is not a check at all.
   */
  it('a caller-supplied companyId cannot reach the result — the strict schema rejects it', async () => {
    const result = await authorizeCaseMutation({
      engagementId: ENGAGEMENT_ID,
      companyId: ATTACKER_COMPANY_ID,
    } as { engagementId: string });
    expect(JSON.stringify(result)).not.toContain(ATTACKER_COMPANY_ID);
  });

  it('tracks the gate when the gate reports a DIFFERENT company than the last call', async () => {
    // Pins that the value is READ from the gate each time rather than cached or defaulted.
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, companyId: ATTACKER_COMPANY_ID });
    const result = await authorizeCaseMutation(INPUT);
    expect(result).toMatchObject({ ok: true, companyId: ATTACKER_COMPANY_ID });
  });
});

/**
 * ⚠⚠ THE ANTI-ORACLE PROPERTY. Three structurally different refusals — you may not read this
 * case / this id is a PROJECT engagement / no such row — must be INDISTINGUISHABLE to the
 * caller. The distinguishing reason goes to `log.warn` inside the gate, never to the wire.
 */
describe('authorizeCaseMutation — gate-denied, non-case and not-found are ONE answer', () => {
  const UNAVAILABLE = { ok: false, error: 'This case is no longer available.' };

  it('gate-denied (cross-tenant, no capability, soft-deleted, no thread) ⇒ the shared literal', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await authorizeCaseMutation(INPUT)).toEqual(UNAVAILABLE);
  });

  it('a NON-case engagement (a project id) ⇒ the SAME literal', async () => {
    // `findByEngagementId` filters `engagement_type = 'case'`, so a project id lands here.
    mockFindCase.mockResolvedValue(undefined);
    expect(await authorizeCaseMutation(INPUT)).toEqual(UNAVAILABLE);
  });

  it('NOT FOUND ⇒ the SAME literal', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    mockFindCase.mockResolvedValue(undefined);
    expect(await authorizeCaseMutation(INPUT)).toEqual(UNAVAILABLE);
  });

  it('ALL THREE ARE BYTE-IDENTICAL — the property, asserted as one statement', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const denied = await authorizeCaseMutation(INPUT);

    mockResolveCaseAccess.mockResolvedValue(ACCESS);
    mockFindCase.mockResolvedValue(undefined);
    const nonCase = await authorizeCaseMutation(INPUT);

    mockResolveCaseAccess.mockResolvedValue(null);
    mockFindCase.mockResolvedValue(undefined);
    const notFound = await authorizeCaseMutation(INPUT);

    // Deep equality, not `.success`: differentiating the COPY is the regression this catches.
    expect(denied).toEqual(nonCase);
    expect(nonCase).toEqual(notFound);
    expect(new Set([denied, nonCase, notFound].map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('the refusal names NOTHING about the case — no id, no title, no company', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const serialized = JSON.stringify(await authorizeCaseMutation(INPUT));
    expect(serialized).not.toContain(ENGAGEMENT_ID);
    expect(serialized).not.toContain(COMPANY_ID);
    expect(serialized).not.toContain('Flow interview loop');
  });
});

describe('authorizeCaseMutation — an infrastructure failure is not a denial', () => {
  it('logs and returns generic copy when a repository REJECTS', async () => {
    mockFindCase.mockRejectedValue(new Error('connection refused'));
    expect(await authorizeCaseMutation(INPUT)).toEqual({
      ok: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Case mutation authorization failed',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    );
  });

  it('the outage answer is DISTINCT from the refusal answer — a 500 is not a 404', async () => {
    // Deliberately the one place the answers differ: collapsing them would tell an operator
    // that a database outage was a permissions problem.
    mockResolveCaseAccess.mockResolvedValue(null);
    const refusal = await authorizeCaseMutation(INPUT);

    mockResolveCaseAccess.mockRejectedValue(new Error('connection refused'));
    const outage = await authorizeCaseMutation(INPUT);

    expect(refusal).not.toEqual(outage);
  });
});
