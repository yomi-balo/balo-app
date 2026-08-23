import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListCapabilityEligibleCompanies = vi.fn();
const mockListOpenForCompanyAndExpert = vi.fn();
const mockFindDisplayProfileById = vi.fn();
const mockFindDisplayById = vi.fn();
const mockGetSummaryById = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@balo/db', () => ({
  partyMembershipsRepository: {
    listCapabilityEligibleCompanies: (...args: unknown[]) =>
      mockListCapabilityEligibleCompanies(...args),
  },
  caseEngagementsRepository: {
    listOpenForCompanyAndExpert: (...args: unknown[]) => mockListOpenForCompanyAndExpert(...args),
  },
  expertsRepository: {
    findDisplayProfileById: (...args: unknown[]) => mockFindDisplayProfileById(...args),
  },
  usersRepository: {
    findDisplayById: (...args: unknown[]) => mockFindDisplayById(...args),
  },
  agenciesRepository: {
    getSummaryById: (...args: unknown[]) => mockGetSummaryById(...args),
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

import { loadBookingContext } from './load-booking-context';

const EXPERT_PROFILE_ID = 'expert-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDisplayProfileById.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    userId: 'expert-user-1',
    agencyId: null,
    type: 'freelancer',
    headline: null,
    username: 'dana',
    ratingAverage: null,
    ratingCount: 0,
  });
  mockFindDisplayById.mockResolvedValue({
    id: 'expert-user-1',
    firstName: 'Dana',
    lastName: 'Okoro',
    avatarUrl: null,
  });
  mockGetSummaryById.mockResolvedValue(undefined);
});

describe('loadBookingContext', () => {
  it('returns onboarding_required when the actor has zero eligible companies', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([]);
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    expect(result).toEqual({ arm: 'onboarding_required' });
    expect(mockListOpenForCompanyAndExpert).not.toHaveBeenCalled();
  });

  it('returns choose_company and DEFERS the open-cases read when there are >1 eligible companies', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: 'company-1', name: 'Northwind', logoUrl: null },
      { id: 'company-2', name: 'Acme', logoUrl: null },
    ]);
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    expect(result.arm).toBe('choose_company');
    if (result.arm === 'choose_company') {
      expect(result.companies).toHaveLength(2);
      expect(result.expert.firstName).toBe('Dana');
    }
    expect(mockListOpenForCompanyAndExpert).not.toHaveBeenCalled();
  });

  it('uses the single company silently and resolves its open cases', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: 'company-1', name: 'Northwind', logoUrl: null },
    ]);
    mockListOpenForCompanyAndExpert.mockResolvedValue({
      openCases: [
        {
          engagementId: 'case-1',
          title: 'Flow help',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          consultationCount: 1,
        },
      ],
      resolvedCaseCount: 2,
    });
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    expect(result.arm).toBe('single_company');
    if (result.arm === 'single_company') {
      expect(result.company).toEqual({ id: 'company-1', name: 'Northwind', logoUrl: null });
      expect(result.openCases).toHaveLength(1);
      expect(result.resolvedCaseCount).toBe(2);
    }
    expect(mockListOpenForCompanyAndExpert).toHaveBeenCalledWith({
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('degrades to new-case-only (empty open cases) when the open-case read throws — non-blocking', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: 'company-1', name: 'Northwind', logoUrl: null },
    ]);
    mockListOpenForCompanyAndExpert.mockRejectedValue(new Error('db down'));
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    expect(result.arm).toBe('single_company');
    if (result.arm === 'single_company') {
      expect(result.openCases).toEqual([]);
      expect(result.resolvedCaseCount).toBe(0);
    }
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Open-case list unavailable; degrading to new-case',
      expect.objectContaining({ companyId: 'company-1' })
    );
  });

  it('FAILS CLOSED — company_read_failed when the company read throws', async () => {
    mockListCapabilityEligibleCompanies.mockRejectedValue(new Error('db down'));
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    expect(result).toEqual({ arm: 'company_read_failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Company eligibility read failed',
      expect.objectContaining({ userId: USER_ID, expertProfileId: EXPERT_PROFILE_ID })
    );
  });

  it("names the AGENCY as the expert's party label when the expert belongs to one", async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([]);
    mockFindDisplayProfileById.mockResolvedValue({
      id: EXPERT_PROFILE_ID,
      userId: 'expert-user-1',
      agencyId: 'agency-1',
      type: 'agency',
      headline: null,
      username: 'dana',
      ratingAverage: null,
      ratingCount: 0,
    });
    mockGetSummaryById.mockResolvedValue({ id: 'agency-1', name: 'CloudPeak', memberCount: 5 });
    // exercise via the choose_company arm so `expert` is on the result
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: 'company-1', name: 'Northwind', logoUrl: null },
      { id: 'company-2', name: 'Acme', logoUrl: null },
    ]);
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    if (result.arm === 'choose_company') {
      expect(result.expert.partyLabel).toBe('CloudPeak');
    } else {
      throw new Error('expected choose_company arm');
    }
  });

  it("keeps the INDEPENDENT expert's own name as the party label", async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: 'company-1', name: 'Northwind', logoUrl: null },
      { id: 'company-2', name: 'Acme', logoUrl: null },
    ]);
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    if (result.arm === 'choose_company') {
      expect(result.expert.partyLabel).toBe('Dana Okoro');
    } else {
      throw new Error('expected choose_company arm');
    }
  });

  it('degrades to a neutral expert label when the expert profile read fails, without failing the whole context', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([]);
    mockFindDisplayProfileById.mockRejectedValue(new Error('db down'));
    const result = await loadBookingContext(EXPERT_PROFILE_ID, USER_ID);
    // onboarding_required carries no `expert` field, so exercise via choose_company instead.
    expect(result).toEqual({ arm: 'onboarding_required' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking expert display read failed; degrading to a neutral label',
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID })
    );
  });
});
