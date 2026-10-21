import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthorizeCaseAttach = vi.fn();
const mockResolveBillingCompanyId = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('./authorize-case-attach', () => ({
  authorizeCaseAttach: (...args: unknown[]) => mockAuthorizeCaseAttach(...args),
}));
vi.mock('./resolve-billing-company', () => ({
  resolveBillingCompanyId: (...args: unknown[]) => mockResolveBillingCompanyId(...args),
}));

import { resolveFundingSubject } from './resolve-funding-subject';

const USER_ID = 'user-1';
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveFundingSubject — an existing case', () => {
  it("returns the ROW's company and expert, never the request's claim", async () => {
    mockAuthorizeCaseAttach.mockResolvedValue({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: 'row-expert',
      title: 'A case',
    });

    const subject = await resolveFundingSubject(USER_ID, {
      expertProfileId: EXPERT_PROFILE_ID,
      caseChoice: { kind: 'existing', engagementId: ENGAGEMENT_ID },
    });

    expect(subject).toEqual({ ok: true, companyId: COMPANY_ID, expertProfileId: 'row-expert' });
    expect(mockAuthorizeCaseAttach).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect(mockResolveBillingCompanyId).not.toHaveBeenCalled();
  });

  it('collapses a denied attach to { ok: false } with no reason', async () => {
    mockAuthorizeCaseAttach.mockResolvedValue({ ok: false, code: 'case_not_available' });

    const subject = await resolveFundingSubject(USER_ID, {
      expertProfileId: EXPERT_PROFILE_ID,
      caseChoice: { kind: 'existing', engagementId: ENGAGEMENT_ID },
    });

    expect(subject).toEqual({ ok: false });
  });
});

describe('resolveFundingSubject — a new case', () => {
  it('bills the company the eligibility check proves, with the requested expert', async () => {
    mockResolveBillingCompanyId.mockResolvedValue({ ok: true, companyId: COMPANY_ID });

    const subject = await resolveFundingSubject(USER_ID, {
      expertProfileId: EXPERT_PROFILE_ID,
      caseChoice: { kind: 'new', companyId: COMPANY_ID },
    });

    expect(subject).toEqual({
      ok: true,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect(mockResolveBillingCompanyId).toHaveBeenCalledWith(USER_ID, COMPANY_ID);
    expect(mockAuthorizeCaseAttach).not.toHaveBeenCalled();
  });

  it.each(['no_eligible_company', 'company_selection_required', 'company_not_eligible'])(
    'collapses %s to { ok: false }',
    async (code) => {
      mockResolveBillingCompanyId.mockResolvedValue({ ok: false, code });

      const subject = await resolveFundingSubject(USER_ID, {
        expertProfileId: EXPERT_PROFILE_ID,
        caseChoice: { kind: 'new' },
      });

      expect(subject).toEqual({ ok: false });
      expect(mockResolveBillingCompanyId).toHaveBeenCalledWith(USER_ID, undefined);
    }
  );
});
