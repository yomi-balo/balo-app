import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindWithCompany,
  mockFindWalletByCompany,
  mockRepoOpen,
  mockFindWithContexts,
  mockFindClosureSubject,
} = vi.hoisted(() => ({
  mockFindWithCompany: vi.fn(),
  mockFindWalletByCompany: vi.fn(),
  mockRepoOpen: vi.fn(),
  mockFindWithContexts: vi.fn(),
  mockFindClosureSubject: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// NOTE: `@balo/shared/authz` is intentionally NOT mocked — the service uses the real, pure
// `roleHasCapability` map (owner/admin/member/expert hold CONSUME_CREDITS; 'finance'/unknown don't).
vi.mock('@balo/db', () => ({
  usersRepository: { findWithCompany: mockFindWithCompany },
  creditWalletsRepository: { findByCompanyId: mockFindWalletByCompany },
  creditSessionsRepository: { open: mockRepoOpen },
  meetingsRepository: { findWithContexts: mockFindWithContexts },
  caseEngagementsRepository: { findClosureSubject: mockFindClosureSubject },
}));

import { openSession } from './open-session.js';

const INPUT = { initiatingMemberId: 'user_1', expertProfileId: 'expert_1', estimatedMinutes: 30 };

/** A single eligible `member` membership on `company_1` (name + null logo). */
function singleEligible(): { companyMemberships: unknown[] } {
  return {
    companyMemberships: [
      { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
    ],
  };
}

describe('openSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue(singleEligible());
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockRepoOpen.mockResolvedValue({ ok: true, session: { id: 'session_1', holdId: 'hold_1' } });
  });

  it('opens a pending session on the happy path (single eligible, no companyId)', async () => {
    const result = await openSession(INPUT);
    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
    });
    expect(mockFindWalletByCompany).toHaveBeenCalledWith('company_1');
    expect(mockRepoOpen).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      initiatingMemberId: 'user_1',
      estimatedMinutes: 30,
    });
  });

  it('fails closed (forbidden) when the user has no company membership', async () => {
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [] });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('fails closed (forbidden) when the only membership role lacks CONSUME_CREDITS', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'finance' },
      ],
    });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('honours a provided companyId that is in the eligible set', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
        {
          company: { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
          role: 'admin',
        },
      ],
    });
    const result = await openSession({ ...INPUT, companyId: 'company_2' });
    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
    });
    expect(mockFindWalletByCompany).toHaveBeenCalledWith('company_2');
    expect(mockRepoOpen).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company_2', walletId: 'wallet_1' })
    );
  });

  it('fails closed (forbidden) when the provided companyId is not a membership (IDOR)', async () => {
    const result = await openSession({ ...INPUT, companyId: 'company_999' });
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('fails closed (forbidden) when the provided companyId is a membership but role-filtered out', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
        { company: { id: 'company_2', name: 'Globex', logoUrl: null }, role: 'finance' },
      ],
    });
    const result = await openSession({ ...INPUT, companyId: 'company_2' });
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('returns company_selection_required when >1 eligible and no companyId', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'owner' },
        {
          company: { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
          role: 'member',
        },
      ],
    });
    const result = await openSession(INPUT);
    expect(result).toEqual({
      ok: false,
      code: 'company_selection_required',
      companies: [
        { id: 'company_1', name: 'Acme', logoUrl: null },
        { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
      ],
    });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('projects companies narrowly (exactly id/name/logoUrl — no company internals leak)', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        {
          company: {
            id: 'company_1',
            name: 'Acme',
            logoUrl: null,
            isPersonal: true,
            billingEmail: 'billing@secret.test',
          },
          role: 'owner',
        },
        {
          company: {
            id: 'company_2',
            name: 'Globex',
            logoUrl: 'https://logo/globex.png',
            isPersonal: false,
          },
          role: 'member',
        },
      ],
    });
    const result = await openSession(INPUT);
    if (result.ok || result.code !== 'company_selection_required') {
      throw new Error('expected company_selection_required');
    }
    for (const company of result.companies) {
      expect(Object.keys(company).sort()).toEqual(['id', 'logoUrl', 'name']);
    }
    const [first] = result.companies;
    expect(first?.logoUrl).toBeNull();
  });

  it('returns wallet_missing when the chosen company has no wallet', async () => {
    mockFindWalletByCompany.mockResolvedValue(undefined);
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'wallet_missing' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('passes through a repo gate rejection code (insufficient_no_mandate)', async () => {
    mockRepoOpen.mockResolvedValue({ ok: false, code: 'insufficient_no_mandate' });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'insufficient_no_mandate' });
  });

  it('passes through the account_hold rejection', async () => {
    mockRepoOpen.mockResolvedValue({ ok: false, code: 'account_hold' });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'account_hold' });
  });
});

/**
 * BAL-129 (D5) — the `meetingId` seam. The client sends a meeting; the SERVICE derives the
 * engagement. Every failure shape collapses to ONE literal so a caller cannot learn whether
 * a guessed uuid exists.
 *
 * ⚠⚠ G1 (second review round) — EVERY CALL BELOW NOW ALSO PASSES `durationSource: 'presence'`.
 * Before this round, `meetingId` alone (no `durationSource`) was a legitimate, successful
 * input — that was exactly the bidirectional-coherence gap G1 closed (see
 * `openSession — BAL-466 (D4), durationSource`'s new tests below). Omitting it here now would
 * make every test in this block hit the NEW `meeting_not_bookable` guard instead of the
 * engagement-resolution logic they exist to pin.
 */
describe('openSession — the BAL-129 meetingId seam', () => {
  const MEETING_ID = 'meeting_1';
  const ENGAGEMENT_ID = 'engagement_1';

  /** A live meeting carrying exactly one `case` context. */
  function meetingWithCaseContext(contextId: string | null = ENGAGEMENT_ID): unknown {
    return { meeting: { id: MEETING_ID }, contexts: [{ contextType: 'case', contextId }] };
  }

  /**
   * The `CaseClosureSubject` `findClosureSubject` resolves to — coherent with `INPUT` by
   * default. D17.5 — `resolveCaseBillingSubject` now delegates the engagement/case-row read to
   * `caseEngagementsRepository.findClosureSubject`, so this test mocks THAT boundary directly
   * rather than the engagement row it used to read; `findClosureSubject`'s own coherence rules
   * (not a case, not active under `requireActive`, …) are covered where it is implemented
   * (`case-engagements.integration.test.ts`).
   */
  function coherentSubject(overrides: Record<string, unknown> = {}): unknown {
    return {
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue(singleEligible());
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockRepoOpen.mockResolvedValue({ ok: true, session: { id: 'session_1', holdId: 'hold_1' } });
    mockFindWithContexts.mockResolvedValue(meetingWithCaseContext());
    mockFindClosureSubject.mockResolvedValue(coherentSubject());
  });

  it('REGRESSION GUARD: omitting meetingId calls `open` byte-identically to before', async () => {
    // Neither key may appear — not even as an explicit `undefined`. A future change that
    // starts passing `meetingId: undefined` would break `exactOptionalPropertyTypes` callers
    // and silently widen what the repository sees.
    await openSession(INPUT);

    expect(mockRepoOpen).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      initiatingMemberId: 'user_1',
      estimatedMinutes: 30,
    });
    expect(mockFindWithContexts).not.toHaveBeenCalled();
  });

  it('passes BOTH meetingId and the RESOLVED engagementId when the pair is coherent', async () => {
    const result = await openSession({
      ...INPUT,
      meetingId: MEETING_ID,
      durationSource: 'presence',
    });

    expect(result).toMatchObject({ ok: true });
    expect(mockRepoOpen).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      initiatingMemberId: 'user_1',
      estimatedMinutes: 30,
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      durationSource: 'presence',
    });
  });

  it('resolves the engagement id from the CONTEXT, never from client input', async () => {
    mockFindWithContexts.mockResolvedValue(meetingWithCaseContext('engagement_from_context'));
    mockFindClosureSubject.mockResolvedValue(coherentSubject());

    await openSession({ ...INPUT, meetingId: MEETING_ID, durationSource: 'presence' });

    expect(mockFindClosureSubject).toHaveBeenCalledWith('engagement_from_context', {
      requireActive: true,
    });
    expect(mockRepoOpen).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'engagement_from_context' })
    );
  });

  it.each([
    {
      label: 'the meeting is missing or soft-deleted',
      arrange: () => mockFindWithContexts.mockResolvedValue(undefined),
    },
    {
      label: 'the meeting has NO case context',
      arrange: () =>
        mockFindWithContexts.mockResolvedValue({
          meeting: { id: MEETING_ID },
          contexts: [{ contextType: 'project_kickoff', contextId: ENGAGEMENT_ID }],
        }),
    },
    {
      label: 'the meeting has TWO case contexts (ambiguous)',
      arrange: () =>
        mockFindWithContexts.mockResolvedValue({
          meeting: { id: MEETING_ID },
          contexts: [
            { contextType: 'case', contextId: ENGAGEMENT_ID },
            { contextType: 'case', contextId: 'engagement_2' },
          ],
        }),
    },
    {
      label: 'the case context carries a null contextId',
      arrange: () => mockFindWithContexts.mockResolvedValue(meetingWithCaseContext(null)),
    },
    {
      // ⚠ COVERS "the engagement does not resolve", "is not a case", "is COMPLETED" and "is
      // CANCELLED" all at once — those distinctions are now `findClosureSubject`'s own contract
      // (see `case-engagements.integration.test.ts`), invisible past this mocked boundary.
      // `requireActive: true` (the member path) refuses every one of them alike.
      label:
        'the closure subject does not resolve (no case, missing engagement, or inactive under requireActive)',
      arrange: () => mockFindClosureSubject.mockResolvedValue(undefined),
    },
    {
      label: 'IDOR: the subject names a DIFFERENT company',
      arrange: () =>
        mockFindClosureSubject.mockResolvedValue(coherentSubject({ companyId: 'company_99' })),
    },
    {
      label: 'IDOR: the subject names a DIFFERENT expert',
      arrange: () =>
        mockFindClosureSubject.mockResolvedValue(coherentSubject({ expertProfileId: 'expert_99' })),
    },
  ])('meeting_not_bookable when $label — and NO session is opened', async ({ arrange }) => {
    arrange();

    const result = await openSession({
      ...INPUT,
      meetingId: MEETING_ID,
      durationSource: 'presence',
    });

    // ONE literal for every shape: distinguishing them would tell a caller whether a guessed
    // uuid exists.
    expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('runs the coherence check AFTER the capability gate — a non-member never reaches it', async () => {
    // Placement matters: `chosenCompanyId` must already be capability-gated when the
    // equality check runs, or the "company mismatch" arm would be comparing against a
    // company the caller never proved anything about.
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [] });

    const result = await openSession({
      ...INPUT,
      meetingId: MEETING_ID,
      durationSource: 'presence',
    });

    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWithContexts).not.toHaveBeenCalled();
  });

  it('resolves the meeting BEFORE the wallet lookup', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);

    await openSession({ ...INPUT, meetingId: MEETING_ID, durationSource: 'presence' });

    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
  });
});

describe('openSession — BAL-466 (D4), durationSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue(singleEligible());
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockRepoOpen.mockResolvedValue({ ok: true, session: { id: 'session_1', holdId: 'hold_1' } });
    mockFindWithContexts.mockResolvedValue({
      meeting: { id: 'meeting_1' },
      contexts: [{ contextType: 'case', contextId: 'engagement_1' }],
    });
    mockFindClosureSubject.mockResolvedValue({
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
    });
  });

  it('is forwarded to creditSessionsRepository.open when supplied, alongside meetingId/engagementId', async () => {
    await openSession({ ...INPUT, meetingId: 'meeting_1', durationSource: 'presence' });

    expect(mockRepoOpen).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      initiatingMemberId: 'user_1',
      estimatedMinutes: 30,
      meetingId: 'meeting_1',
      engagementId: 'engagement_1',
      durationSource: 'presence',
    });
  });

  it('omitted ⇒ the key is ABSENT — byte-identical to the pre-BAL-466 call (exactOptionalPropertyTypes)', async () => {
    await openSession(INPUT);

    const call = mockRepoOpen.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty('durationSource');
  });

  it("'presence' WITHOUT meetingId returns meeting_not_bookable BEFORE any repository read", async () => {
    const result = await openSession({ ...INPUT, durationSource: 'presence' });

    expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
    expect(mockFindWithCompany).not.toHaveBeenCalled();
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockFindWithContexts).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it("'live_capture' without meetingId is unaffected by the coherence guard", async () => {
    const result = await openSession({ ...INPUT, durationSource: 'live_capture' });
    expect(result).toMatchObject({ ok: true });
  });

  describe('G1 (second review round) — the guard is bidirectional', () => {
    it("a meetingId WITHOUT durationSource: 'presence' returns meeting_not_bookable BEFORE any repository read", async () => {
      const result = await openSession({ ...INPUT, meetingId: 'meeting_1' });

      expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
      expect(mockFindWithCompany).not.toHaveBeenCalled();
      expect(mockFindWalletByCompany).not.toHaveBeenCalled();
      expect(mockFindWithContexts).not.toHaveBeenCalled();
      expect(mockRepoOpen).not.toHaveBeenCalled();
    });

    it("a meetingId WITH durationSource: 'live_capture' EXPLICITLY is refused identically — omission and an explicit non-presence value are the same case", async () => {
      const result = await openSession({
        ...INPUT,
        meetingId: 'meeting_1',
        durationSource: 'live_capture',
      });

      expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
      expect(mockRepoOpen).not.toHaveBeenCalled();
    });
  });
});

// ── BAL-474 (ADR-1040 Amendment 7 §B) — the overdraft-tolerant funding policy ───────────────────────

describe('openSession — BAL-474, fundingPolicy', () => {
  const PRESENCE_INPUT = {
    ...INPUT,
    meetingId: 'meeting_1',
    durationSource: 'presence',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue(singleEligible());
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockFindWithContexts.mockResolvedValue({
      meeting: { id: 'meeting_1' },
      contexts: [{ contextType: 'case', contextId: 'engagement_1' }],
    });
    mockFindClosureSubject.mockResolvedValue({
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
    });
    mockRepoOpen.mockResolvedValue({
      ok: true,
      session: { id: 'session_1', holdId: 'hold_1' },
      toleratedGates: ['negative_balance'],
    });
  });

  it('the tolerant policy is forwarded to the repository, and the tolerated gates come back on the result', async () => {
    const result = await openSession({ ...PRESENCE_INPUT, fundingPolicy: 'overdraft_tolerant' });

    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
      toleratedGates: ['negative_balance'],
    });
    expect(mockRepoOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        fundingPolicy: 'overdraft_tolerant',
        meetingId: 'meeting_1',
        engagementId: 'engagement_1',
        durationSource: 'presence',
      })
    );
  });

  it('omitted ⇒ the key is ABSENT — the gated open, byte-identical to every shipped caller', async () => {
    await openSession(PRESENCE_INPUT);
    const [call] = mockRepoOpen.mock.calls[0] as [Record<string, unknown>];
    expect(call).not.toHaveProperty('fundingPolicy');
  });

  it('⚠ the tolerant policy WITHOUT presence provenance is refused before any read — tolerance is only safe on the presence-settled path', async () => {
    const result = await openSession({ ...INPUT, fundingPolicy: 'overdraft_tolerant' });

    expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
    expect(mockFindWithCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('the tolerant policy with an explicit live_capture provenance is refused identically', async () => {
    const result = await openSession({
      ...INPUT,
      fundingPolicy: 'overdraft_tolerant',
      durationSource: 'live_capture',
    });
    expect(result).toEqual({ ok: false, code: 'meeting_not_bookable' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('meeting_session_exists (the in-lock one-session-per-meeting check) passes through as a service code', async () => {
    mockRepoOpen.mockResolvedValue({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: 'session_winner',
    });
    await expect(
      openSession({ ...PRESENCE_INPUT, fundingPolicy: 'overdraft_tolerant' })
    ).resolves.toEqual({ ok: false, code: 'meeting_session_exists' });
  });

  it('a member’s admission still resolves through the SHARED case-billing subject with requireActive: a closed case is refused', async () => {
    // A `requireActive: true` read of a non-active case is `findClosureSubject`'s own contract —
    // it answers `undefined` rather than a subject with `isActive: false` (see
    // `case-engagements.integration.test.ts`).
    mockFindClosureSubject.mockResolvedValue(undefined);
    await expect(
      openSession({ ...PRESENCE_INPUT, fundingPolicy: 'overdraft_tolerant' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_bookable' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });
});
