import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * `cache()` has no request scope in a unit test, so it is replaced by a memo keyed on the
 * argument tuple, standing in for ONE render pass.
 */
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache: <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
      const memo = new Map<string, R>();
      return (...args: A): R => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key) as R;
      };
    },
  };
});

const mockFindProfile = vi.fn();
const mockGetMemberRole = vi.fn();

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: vi.fn() },
  expertsRepository: { findProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
}));

const PROFILE_ID = 'p0000000-0000-4000-8000-000000000002';
const AGENCY_ID = 'a0000000-0000-4000-8000-000000000003';
const ADMIN_ID = 'u0000000-0000-4000-8000-000000000004';
const OTHER_ID = 'u0000000-0000-4000-8000-000000000005';
const LOG_CONTEXT = { contextType: 'case', contextId: 'e1' };
const DELIVERY = {
  expertProfileId: PROFILE_ID,
  agency: { from: 'engagement', deliveringAgencyId: AGENCY_ID },
} as const;

let administersDeliveringAgency: typeof import('./engagement').administersDeliveringAgency;
let hasExpertDeliveryCapability: typeof import('./engagement').hasExpertDeliveryCapability;

beforeEach(async () => {
  vi.clearAllMocks();
  // A fresh module instance per test is a fresh render pass: the memo lives at module scope.
  vi.resetModules();
  ({ administersDeliveringAgency, hasExpertDeliveryCapability } = await import('./engagement'));
  mockFindProfile.mockResolvedValue({ userId: 'u-expert', agencyId: AGENCY_ID });
  mockGetMemberRole.mockImplementation(async (_party, _id, actorId: string) =>
    actorId === ADMIN_ID ? 'admin' : undefined
  );
});

describe('host-context lookups are request-deduped', () => {
  it('shares one build between both resolvers and every token for the same actor and profile', async () => {
    const actor = { id: ADMIN_ID };
    await hasExpertDeliveryCapability(actor, 'manage_engagement', DELIVERY, LOG_CONTEXT);
    await administersDeliveringAgency(actor, DELIVERY);
    await hasExpertDeliveryCapability(actor, 'host_meetings', DELIVERY, LOG_CONTEXT);
    await hasExpertDeliveryCapability(actor, 'log_time', DELIVERY, LOG_CONTEXT);

    expect(mockFindProfile).toHaveBeenCalledTimes(1);
    expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
  });

  it('never shares a build across actors', async () => {
    const admin = await administersDeliveringAgency({ id: ADMIN_ID }, DELIVERY);
    const other = await administersDeliveringAgency({ id: OTHER_ID }, DELIVERY);

    expect(admin).toBe(true);
    expect(other).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledTimes(2);
  });

  it('never shares a build across different agency sources for the same profile and actor', async () => {
    const actor = { id: ADMIN_ID };
    const unpinned = {
      expertProfileId: PROFILE_ID,
      agency: { from: 'engagement', deliveringAgencyId: null },
    } as const;

    expect(await administersDeliveringAgency(actor, DELIVERY)).toBe(true);
    expect(await administersDeliveringAgency(actor, unpinned)).toBe(false);
  });
});
