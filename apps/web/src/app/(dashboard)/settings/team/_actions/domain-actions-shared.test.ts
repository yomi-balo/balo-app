import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  companiesRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

import { assertRealCompany } from './domain-actions-shared';

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

describe('assertRealCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null (allowed) for a real, non-personal company', async () => {
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: false });
    await expect(assertRealCompany(COMPANY_ID)).resolves.toBeNull();
    expect(mockFindById).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('denies a personal-workspace company', async () => {
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: true });
    await expect(assertRealCompany(COMPANY_ID)).resolves.toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
  });

  it('denies a company that no longer exists (undefined)', async () => {
    mockFindById.mockResolvedValue(undefined);
    await expect(assertRealCompany(COMPANY_ID)).resolves.toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
  });
});
