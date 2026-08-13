import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-435 (ruling R10) — WHO THE WAITING STAGE IS WAITING FOR.
 *
 * ⚠⚠ THE TWO SIDES ANSWER DIFFERENT **KINDS** OF NAME, AND THAT ASYMMETRY IS THE DESIGN:
 * the expert side names exactly one individual (a person joins a call), the client side names
 * none, so it answers with the PARTY. Every assertion below is about not inventing a person.
 *
 * ⚠ AND NOTHING HERE MAY EVER FAIL A JOIN. A name is decoration on a surface whose job is to
 * connect a call.
 */

const {
  mockCompanyFindNameById,
  mockExpertFindDisplayProfileById,
  mockFindNamesByIds,
  mockLogError,
} = vi.hoisted(() => ({
  mockCompanyFindNameById: vi.fn(),
  mockExpertFindDisplayProfileById: vi.fn(),
  mockFindNamesByIds: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { findNameById: mockCompanyFindNameById },
  expertsRepository: { findDisplayProfileById: mockExpertFindDisplayProfileById },
  usersRepository: { findNamesByIds: mockFindNamesByIds },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError }),
}));

const { resolveWaitingCounterparty } = await import('./resolve-waiting-counterparty.js');

const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const EXPERT_USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockExpertFindDisplayProfileById.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    userId: EXPERT_USER_ID,
  });
  mockFindNamesByIds.mockResolvedValue([{ firstName: 'Dana', lastName: 'Okoro' }]);
  mockCompanyFindNameById.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
});

describe('resolveWaitingCounterparty — a CLIENT is waiting', () => {
  it('names the delivering expert by FIRST name', async () => {
    const name = await resolveWaitingCounterparty({
      viewerRole: 'client',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    expect(name).toBe('Dana');
    expect(mockFindNamesByIds).toHaveBeenCalledWith([EXPERT_USER_ID]);
  });

  it('⚠ reads names through `findNamesByIds` — never a hydrated user row', async () => {
    // `findById` would carry `workosId`, email and phone into a value bound for a browser
    // (memory `reference_drizzle_with_hydration_leaks_secrets`).
    await resolveWaitingCounterparty({
      viewerRole: 'client',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    expect(mockCompanyFindNameById).not.toHaveBeenCalled();
  });

  it('⚠ a match-routed discovery has NO expert — null, and no read at all', async () => {
    const name = await resolveWaitingCounterparty({
      viewerRole: 'client',
      companyId: COMPANY_ID,
      expertProfileId: null,
    });

    expect(name).toBeNull();
    expect(mockExpertFindDisplayProfileById).not.toHaveBeenCalled();
  });

  it('a missing profile is null, not a thrown join', async () => {
    mockExpertFindDisplayProfileById.mockResolvedValue(undefined);

    await expect(
      resolveWaitingCounterparty({
        viewerRole: 'client',
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      })
    ).resolves.toBeNull();
  });

  it('a nameless expert is null rather than an empty {Name} in the copy', async () => {
    mockFindNamesByIds.mockResolvedValue([{ firstName: null, lastName: 'Okoro' }]);

    await expect(
      resolveWaitingCounterparty({
        viewerRole: 'client',
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      })
    ).resolves.toBeNull();
  });
});

describe('resolveWaitingCounterparty — an EXPERT is waiting', () => {
  it('⚠⚠ names the client COMPANY, because the client side names no individual', async () => {
    const name = await resolveWaitingCounterparty({
      viewerRole: 'expert',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    expect(name).toBe('Northwind Industrial');
    // ⚠ NO PERSON IS INVENTED FROM COMPANY MEMBERSHIP. Picking one member of several would be a
    // fabrication on a surface that settles money.
    expect(mockExpertFindDisplayProfileById).not.toHaveBeenCalled();
    expect(mockFindNamesByIds).not.toHaveBeenCalled();
  });

  it('trims, and treats a blank company name as no name', async () => {
    mockCompanyFindNameById.mockResolvedValue({ id: COMPANY_ID, name: '  ' });

    await expect(
      resolveWaitingCounterparty({
        viewerRole: 'expert',
        companyId: COMPANY_ID,
        expertProfileId: null,
      })
    ).resolves.toBeNull();
  });
});

describe('resolveWaitingCounterparty — it never fails a join', () => {
  it('⚠⚠ swallows a repository failure, logs it with a stack, and answers null', async () => {
    mockCompanyFindNameById.mockRejectedValue(new Error('db down'));

    const name = await resolveWaitingCounterparty({
      viewerRole: 'expert',
      companyId: COMPANY_ID,
      expertProfileId: null,
    });

    expect(name).toBeNull();
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [fields] = mockLogError.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ viewerRole: 'expert', companyId: COMPANY_ID });
    expect((fields as { stack?: string }).stack).toBeDefined();
  });
});
