import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);
vi.mock('server-only', () => ({}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockFindApprovalById = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
  },
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

const mockGetBaloApiJson = vi.fn();
vi.mock('@/lib/api/balo-api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/balo-api-client')>()),
  getBaloApiJson: (...args: unknown[]) => mockGetBaloApiJson(...args),
}));

import { log } from '@/lib/logging';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';
import { getPayoutFormSchemaAction } from './get-payout-form-schema';
import {
  APPROVED_PROFILE_ROW,
  itEnforcesApprovedExpertGate,
} from '@/test/fixtures/approved-expert-gate-cases';

const EXPERT_USER = {
  onboardingCompleted: true,
  id: 'user-1',
  email: 'expert@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  activeMode: 'expert',
  expertProfileId: 'profile-1',
};

const INPUT = { country: 'AU', currency: 'AUD', method: 'LOCAL', entityType: 'COMPANY' } as const;
const GENERIC = "We couldn't load the bank details form. Please try again.";

describe('getPayoutFormSchemaAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: EXPERT_USER, accessToken: 'tok' };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
    mockGetBaloApiJson.mockResolvedValue({ ok: true, data: { fields: [], hiddenDefaults: {} } });
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = {};
    await expect(getPayoutFormSchemaAction(INPUT)).rejects.toThrow('Unauthorized');
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          user: { ...EXPERT_USER, ...u, expertProfileId: u.expertProfileId ?? undefined },
        };
      },
      setProfileRow: (row) => mockFindApprovalById.mockResolvedValue(row),
      findApprovalById: mockFindApprovalById,
      run: () => getPayoutFormSchemaAction(INPUT),
      expectAllowed: (result) => expect(result).toEqual(expect.objectContaining({ ok: true })),
      expectRefused: (result) =>
        expect(result).toEqual({
          ok: false,
          code: 'not_approved_expert',
          error: 'Expert profile required',
        }),
      expectNoSideEffect: () => expect(mockGetBaloApiJson).not.toHaveBeenCalled(),
    });
  });

  it('refuses an impersonated session before the API hop', async () => {
    mockSessionObj = {
      user: { ...EXPERT_USER, isImpersonating: true, impersonatorUserId: 'admin-1' },
    };
    const result = await getPayoutFormSchemaAction(INPUT);
    expect(result).toEqual({
      ok: false,
      code: 'impersonation_refused',
      error: "Bank details can't be loaded while you're viewing as this expert.",
    });
    expect(mockGetBaloApiJson).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('impersonated'),
      expect.objectContaining({ userId: 'user-1', impersonatorUserId: 'admin-1' })
    );
  });

  it('maps an unmarked 401 to session_expired', async () => {
    mockGetBaloApiJson.mockResolvedValue({ ok: false, status: 401, code: 'Unauthorized' });
    expect(await getPayoutFormSchemaAction(INPUT)).toEqual({
      ok: false,
      code: 'session_expired',
      error: SESSION_EXPIRED_MESSAGE,
    });
  });

  it('maps an account-refusal code to request_failed, never session_expired', async () => {
    mockGetBaloApiJson.mockResolvedValue({ ok: false, status: 401, code: 'account_suspended' });
    expect(await getPayoutFormSchemaAction(INPUT)).toEqual({
      ok: false,
      code: 'request_failed',
      error: GENERIC,
    });
  });

  it('maps a 400 to unsupported', async () => {
    mockGetBaloApiJson.mockResolvedValue({ ok: false, status: 400, code: 'bad' });
    expect(await getPayoutFormSchemaAction(INPUT)).toEqual({
      ok: false,
      code: 'unsupported',
      error: "Payouts aren't available for this country and currency yet.",
    });
  });

  it('maps a transport failure to request_failed', async () => {
    mockGetBaloApiJson.mockResolvedValue({ ok: false, status: 0, code: 'request_failed' });
    expect(await getPayoutFormSchemaAction(INPUT)).toEqual({
      ok: false,
      code: 'request_failed',
      error: GENERIC,
    });
  });

  it('rejects invalid input without calling the API', async () => {
    const result = await getPayoutFormSchemaAction({ ...INPUT, country: 'AUS' });
    expect(result).toEqual({ ok: false, code: 'invalid_request', error: GENERIC });
    expect(mockFindApprovalById).not.toHaveBeenCalled();
    expect(mockGetBaloApiJson).not.toHaveBeenCalled();
  });

  it.each([
    ['AU', 'AUD'],
    ['US', 'USD'],
    ['GB', 'GBP'],
  ])('builds the %s/%s query and returns the fields', async (country, currency) => {
    const fields = [{ path: 'a.b', label: 'A' }];
    mockGetBaloApiJson.mockResolvedValue({
      ok: true,
      data: { fields, hiddenDefaults: { 'x.y': 'z' } },
    });

    const result = await getPayoutFormSchemaAction({
      country,
      currency,
      method: 'LOCAL',
      entityType: 'COMPANY',
    });

    expect(mockGetBaloApiJson).toHaveBeenCalledWith(
      `/api/payouts/schema?country=${country}&currency=${currency}&method=LOCAL&entity_type=COMPANY`,
      expect.any(Function),
      'payout-form-schema'
    );
    expect(result).toEqual({ ok: true, fields, hiddenDefaults: { 'x.y': 'z' } });
  });

  it('omits unset optional params from the query', async () => {
    await getPayoutFormSchemaAction({ country: 'AU' });
    expect(mockGetBaloApiJson.mock.calls[0]?.[0]).toBe('/api/payouts/schema?country=AU');
  });

  it('parses a body without fields as malformed and keeps only string hidden defaults', async () => {
    await getPayoutFormSchemaAction(INPUT);
    const parse = mockGetBaloApiJson.mock.calls[0]?.[1] as (b: Record<string, unknown>) => unknown;
    expect(parse({})).toBeNull();
    expect(parse({ fields: [], hiddenDefaults: { a: 'b', c: 1 } })).toEqual({
      fields: [],
      hiddenDefaults: { a: 'b' },
    });
    expect(parse({ fields: [], hiddenDefaults: ['x'] })).toEqual({
      fields: [],
      hiddenDefaults: {},
    });
  });

  it('logs and returns request_failed when the approval read throws', async () => {
    mockFindApprovalById.mockRejectedValue(new Error('DB down'));
    expect(await getPayoutFormSchemaAction(INPUT)).toEqual({
      ok: false,
      code: 'request_failed',
      error: GENERIC,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load payout form schema',
      expect.objectContaining({ userId: 'user-1', error: 'DB down' })
    );
    expect(mockGetBaloApiJson).not.toHaveBeenCalled();
  });
});
