import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRequireManager, mockSetIndustry, mockAfter } = vi.hoisted(() => ({
  mockRequireManager: vi.fn(),
  mockSetIndustry: vi.fn(),
  mockAfter: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { setIndustry: (...a: unknown[]) => mockSetIndustry(...a) },
}));
vi.mock('./_shared/require-company-details-manager', () => ({
  requireCompanyDetailsManager: () => mockRequireManager(),
}));
vi.mock('@/lib/logging', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('./_shared/company-details-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_shared/company-details-action')>();
  return { ...actual, afterCompanyDetailsChange: (...a: unknown[]) => mockAfter(...a) };
});

import { setCompanyIndustryAction } from './set-company-industry';
import { log } from '@/lib/logging';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const INDUSTRY_ID = '22222222-2222-4222-8222-222222222222';
const STAFF = { id: 'staff-1', platformRole: 'admin' };

const input = (overrides: Record<string, unknown> = {}) =>
  ({ companyId: COMPANY_ID, industryId: INDUSTRY_ID, ...overrides }) as Parameters<
    typeof setCompanyIndustryAction
  >[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireManager.mockResolvedValue({ ok: true, user: STAFF });
});

describe('setCompanyIndustryAction', () => {
  it('denies before parsing or any repository call', async () => {
    mockRequireManager.mockResolvedValue({ ok: false, error: 'nope' });

    expect(await setCompanyIndustryAction({ junk: 1 } as never)).toEqual({
      success: false,
      error: 'nope',
      code: 'denied',
    });
    expect(mockSetIndustry).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid company', { companyId: 'x' }],
    ['a non-uuid industry', { industryId: 'x' }],
    ['an unknown key', { extra: 1 }],
  ])('rejects %s without writing', async (_label, overrides) => {
    expect(await setCompanyIndustryAction(input(overrides))).toEqual({
      success: false,
      error: "That request wasn't valid. Refresh and try again.",
    });
    expect(mockSetIndustry).not.toHaveBeenCalled();
  });

  it('sets the industry, runs side effects and names the new industry', async () => {
    mockSetIndustry.mockResolvedValue({
      outcome: 'changed',
      companyName: 'Acme',
      from: null,
      to: INDUSTRY_ID,
      toName: 'Logistics',
    });

    const result = await setCompanyIndustryAction(input());

    expect(mockSetIndustry).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      industryId: INDUSTRY_ID,
      actorUserId: 'staff-1',
    });
    expect(mockAfter).toHaveBeenCalledWith({
      kind: 'industry',
      actorUserId: 'staff-1',
      companyId: COMPANY_ID,
      cleared: false,
    });
    expect(result).toEqual({ success: true, message: "Acme's industry is now Logistics." });
  });

  it('clears the industry', async () => {
    mockSetIndustry.mockResolvedValue({
      outcome: 'changed',
      companyName: 'Acme',
      from: INDUSTRY_ID,
      to: null,
      toName: null,
    });

    const result = await setCompanyIndustryAction(input({ industryId: null }));

    expect(mockAfter).toHaveBeenCalledWith(expect.objectContaining({ cleared: true }));
    expect(result).toEqual({ success: true, message: "Acme's industry was cleared." });
  });

  it('reports an unchanged value as success with no side effects', async () => {
    mockSetIndustry.mockResolvedValue({ outcome: 'unchanged', companyName: 'Acme' });

    expect(await setCompanyIndustryAction(input())).toEqual({
      success: true,
      message: 'Acme already has that industry, so nothing changed.',
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('maps a retired industry to its code and copy', async () => {
    mockSetIndustry.mockResolvedValue({ outcome: 'industry_unavailable' });

    expect(await setCompanyIndustryAction(input())).toEqual({
      success: false,
      error: "That industry isn't available any more. Pick another.",
      code: 'industry_unavailable',
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('maps a missing company to not_found', async () => {
    mockSetIndustry.mockResolvedValue({ outcome: 'company_not_found' });

    expect(await setCompanyIndustryAction(input())).toMatchObject({
      success: false,
      code: 'not_found',
    });
  });

  it('logs and reports a failed save when the repository throws', async () => {
    mockSetIndustry.mockRejectedValue(new Error('db down'));

    expect(await setCompanyIndustryAction(input())).toEqual({
      success: false,
      error: "Couldn't save that change. Nothing was changed — try again.",
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to set company industry',
      expect.objectContaining({ companyId: COMPANY_ID, error: 'db down' })
    );
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
