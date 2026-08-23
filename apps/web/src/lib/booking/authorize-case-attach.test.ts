import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindByEngagementId = vi.fn();
const mockHasCapability = vi.fn();
const mockLogWarn = vi.fn();

vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    findByEngagementId: (...args: unknown[]) => mockFindByEngagementId(...args),
  },
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { CONSUME_CREDITS: 'consume_credits' },
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: (...args: unknown[]) => mockLogWarn(...args), error: vi.fn(), info: vi.fn() },
}));

import { authorizeCaseAttach } from './authorize-case-attach';

const BASE_ROW = {
  id: 'engagement-1',
  companyId: 'company-1',
  expertProfileId: 'expert-1',
  engagementType: 'case' as const,
  status: 'active' as const,
  closedAt: null,
  title: 'Salesforce flow help',
};

const INPUT = {
  actorUserId: 'user-1',
  engagementId: 'engagement-1',
  expertProfileId: 'expert-1',
};

describe('authorizeCaseAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies with case_not_available when the engagement does not exist', async () => {
    mockFindByEngagementId.mockResolvedValue(undefined);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'no_engagement' })
    );
  });

  it('denies with case_not_available when the actor is not a CONSUME_CREDITS member', async () => {
    mockFindByEngagementId.mockResolvedValue(BASE_ROW);
    mockHasCapability.mockResolvedValue(false);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockHasCapability).toHaveBeenCalledWith({ id: 'user-1' }, 'consume_credits', {
      companyId: 'company-1',
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'no_capability' })
    );
  });

  it('authorizes membership BEFORE the coherence checks — a non-member never reaches them', async () => {
    mockFindByEngagementId.mockResolvedValue({ ...BASE_ROW, engagementType: 'project' });
    mockHasCapability.mockResolvedValue(false);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    // The FIRST (and only) denial reason logged is the membership one, not `not_a_case`.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'no_capability' })
    );
  });

  it('denies (not_a_case) when the engagement is not a case', async () => {
    mockFindByEngagementId.mockResolvedValue({ ...BASE_ROW, engagementType: 'project' });
    mockHasCapability.mockResolvedValue(true);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'not_a_case' })
    );
  });

  it('denies (engagement_not_active) when the parent status is not active', async () => {
    mockFindByEngagementId.mockResolvedValue({ ...BASE_ROW, status: 'completed' });
    mockHasCapability.mockResolvedValue(true);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'engagement_not_active' })
    );
  });

  it('denies (case_closed) when the case is already closed', async () => {
    mockFindByEngagementId.mockResolvedValue({ ...BASE_ROW, closedAt: new Date() });
    mockHasCapability.mockResolvedValue(true);
    const result = await authorizeCaseAttach(INPUT);
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'case_closed' })
    );
  });

  it('denies (expert_mismatch) when the case belongs to a different expert', async () => {
    mockFindByEngagementId.mockResolvedValue(BASE_ROW);
    mockHasCapability.mockResolvedValue(true);
    const result = await authorizeCaseAttach({ ...INPUT, expertProfileId: 'expert-2' });
    expect(result).toEqual({ ok: false, code: 'case_not_available' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Case attach denied',
      expect.objectContaining({ reason: 'expert_mismatch' })
    );
  });

  it('returns ok:true with the companyId, the ROW’s expertProfileId and the title', async () => {
    mockFindByEngagementId.mockResolvedValue(BASE_ROW);
    mockHasCapability.mockResolvedValue(true);
    const result = await authorizeCaseAttach(INPUT);
    // S1/M5 — `expertProfileId` comes off the ROW, so the caller never has to hold (or
    // re-read) the client's claimed one.
    expect(result).toEqual({
      ok: true,
      engagementId: 'engagement-1',
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      title: 'Salesforce flow help',
    });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('every denial returns the SAME literal, regardless of reason', async () => {
    const scenarios = [
      async () => {
        mockFindByEngagementId.mockResolvedValueOnce(undefined);
        return authorizeCaseAttach(INPUT);
      },
      async () => {
        mockFindByEngagementId.mockResolvedValueOnce(BASE_ROW);
        mockHasCapability.mockResolvedValueOnce(false);
        return authorizeCaseAttach(INPUT);
      },
      async () => {
        mockFindByEngagementId.mockResolvedValueOnce({ ...BASE_ROW, closedAt: new Date() });
        mockHasCapability.mockResolvedValueOnce(true);
        return authorizeCaseAttach(INPUT);
      },
    ];
    for (const scenario of scenarios) {
      const result = await scenario();
      expect(result).toEqual({ ok: false, code: 'case_not_available' });
    }
  });
});
