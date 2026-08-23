import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockListCapabilityEligibleCompanies = vi.fn();
const mockListOpenForCompanyAndExpert = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@balo/db', () => ({
  partyMembershipsRepository: {
    listCapabilityEligibleCompanies: (...args: unknown[]) =>
      mockListCapabilityEligibleCompanies(...args),
  },
  caseEngagementsRepository: {
    listOpenForCompanyAndExpert: (...args: unknown[]) => mockListOpenForCompanyAndExpert(...args),
  },
}));
vi.mock('@/lib/authz', () => ({
  CAPABILITIES: { CONSUME_CREDITS: 'consume_credits' },
}));
vi.mock('@/lib/logging', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    info: vi.fn(),
  },
}));

import { refetchOpenCasesAction } from './refetch-open-cases';

const USER = { id: 'user-1', onboardingCompleted: true };
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_COMPANY_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockListCapabilityEligibleCompanies.mockResolvedValue([
    { id: COMPANY_ID, name: 'Northwind', logoUrl: null },
  ]);
  mockListOpenForCompanyAndExpert.mockResolvedValue({
    openCases: [
      {
        engagementId: 'engagement-1',
        title: 'Flow interview loop',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        lastActivityAt: new Date('2026-06-01T00:00:00.000Z'),
        consultationCount: 2,
      },
    ],
    resolvedCaseCount: 1,
  });
});

describe('refetchOpenCasesAction', () => {
  it('always authenticates via requireOnboardedUser (the mutation gate)', async () => {
    await refetchOpenCasesAction({ expertProfileId: EXPERT_PROFILE_ID, companyId: COMPANY_ID });
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input before touching any repository', async () => {
    const result = await refetchOpenCasesAction({
      expertProfileId: 'not-a-uuid',
      companyId: COMPANY_ID,
    });
    expect(result).toEqual({ ok: false });
    expect(mockListCapabilityEligibleCompanies).not.toHaveBeenCalled();
  });

  // The IDOR guard this action exists for: a client-supplied companyId must be re-verified
  // against the caller's OWN eligible set, even though it can only ever be one the caller's
  // own CompanyPicker rendered.
  it('DENIES a companyId outside the caller eligible set, and logs it', async () => {
    const result = await refetchOpenCasesAction({
      expertProfileId: EXPERT_PROFILE_ID,
      companyId: OTHER_COMPANY_ID,
    });
    expect(result).toEqual({ ok: false });
    expect(mockListOpenForCompanyAndExpert).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Open-case refetch denied — company not eligible',
      expect.objectContaining({ userId: 'user-1', companyId: OTHER_COMPANY_ID })
    );
  });

  it('returns the open cases, ISO-formatted, for an eligible company', async () => {
    const result = await refetchOpenCasesAction({
      expertProfileId: EXPERT_PROFILE_ID,
      companyId: COMPANY_ID,
    });
    expect(result).toEqual({
      ok: true,
      resolvedCaseCount: 1,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-05-01T00:00:00.000Z',
          lastActivityAt: '2026-06-01T00:00:00.000Z',
          consultationCount: 2,
        },
      ],
    });
  });

  it('degrades to {ok:false} and logs on a repository throw', async () => {
    mockListOpenForCompanyAndExpert.mockRejectedValue(new Error('pg: connection reset'));
    const result = await refetchOpenCasesAction({
      expertProfileId: EXPERT_PROFILE_ID,
      companyId: COMPANY_ID,
    });
    expect(result).toEqual({ ok: false });
    expect(mockLogError).toHaveBeenCalledWith(
      'Open-case refetch failed',
      expect.objectContaining({ companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID })
    );
  });
});
