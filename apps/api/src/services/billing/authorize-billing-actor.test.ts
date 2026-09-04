import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetMemberRole = vi.fn();
vi.mock('@balo/db', () => ({
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
}));

import { actorHoldsManageBilling } from './authorize-billing-actor.js';

const COMPANY_ID = 'company_1';
const ACTOR_USER_ID = 'user_1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('actorHoldsManageBilling (BAL-522)', () => {
  it('true for an owner (holds MANAGE_BILLING)', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    expect(await actorHoldsManageBilling(COMPANY_ID, ACTOR_USER_ID)).toBe(true);
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, ACTOR_USER_ID);
  });

  it('true for an admin (holds MANAGE_BILLING)', async () => {
    mockGetMemberRole.mockResolvedValue('admin');
    expect(await actorHoldsManageBilling(COMPANY_ID, ACTOR_USER_ID)).toBe(true);
  });

  it('false for a plain member (MANAGE_BILLING excluded)', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    expect(await actorHoldsManageBilling(COMPANY_ID, ACTOR_USER_ID)).toBe(false);
  });

  it('false (fails closed) for a non-member / platform-role actor — getMemberRole resolves undefined', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    expect(await actorHoldsManageBilling(COMPANY_ID, ACTOR_USER_ID)).toBe(false);
  });
});
