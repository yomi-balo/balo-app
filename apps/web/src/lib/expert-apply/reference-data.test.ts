import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// `loadReferenceData` is wrapped in React's `cache()`, which requires a request scope to run.
// In unit tests there is no such scope — same pass-through pattern as
// `apps/web/src/lib/actions/expert-checklist.test.ts`.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

// BAL-502 FIX round — `unstable_cache` needs Next's Data Cache runtime, unavailable in a plain
// vitest process. Pass through so the wrapped function still runs and is still testable.
vi.mock('next/cache', () => ({
  unstable_cache: <T>(fn: T): T => fn,
}));

const mockGetSalesforceVertical = vi.fn();
const mockGetProductsByVertical = vi.fn();
const mockGetSupportTypes = vi.fn();
const mockGetCertificationsByVertical = vi.fn();
const mockGetLanguages = vi.fn();
const mockGetIndustries = vi.fn();

vi.mock('@balo/db', () => ({
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getProductsByVertical: (...args: unknown[]) => mockGetProductsByVertical(...args),
    getSupportTypes: (...args: unknown[]) => mockGetSupportTypes(...args),
    getCertificationsByVertical: (...args: unknown[]) => mockGetCertificationsByVertical(...args),
    getLanguages: (...args: unknown[]) => mockGetLanguages(...args),
    getIndustries: (...args: unknown[]) => mockGetIndustries(...args),
  },
}));

import { loadReferenceData } from './reference-data';

const VERTICAL = { id: 'vertical-1', name: 'Salesforce' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSalesforceVertical.mockResolvedValue(VERTICAL);
  mockGetProductsByVertical.mockResolvedValue([{ category: 'CRM', products: [] }]);
  mockGetSupportTypes.mockResolvedValue([{ id: 'support-1', name: 'Implementation' }]);
  mockGetCertificationsByVertical.mockResolvedValue([{ category: 'Admin', certifications: [] }]);
  mockGetLanguages.mockResolvedValue([{ id: 'en', name: 'English' }]);
  mockGetIndustries.mockResolvedValue([{ id: 'fin', name: 'Financial Services' }]);
});

describe('loadReferenceData', () => {
  it('resolves the vertical first, then reads the remaining five catalogues scoped to it', async () => {
    await loadReferenceData();

    expect(mockGetSalesforceVertical).toHaveBeenCalledTimes(1);
    expect(mockGetProductsByVertical).toHaveBeenCalledWith('vertical-1');
    expect(mockGetSupportTypes).toHaveBeenCalledWith('vertical-1');
    expect(mockGetCertificationsByVertical).toHaveBeenCalledWith('vertical-1');
    expect(mockGetLanguages).toHaveBeenCalledTimes(1);
    expect(mockGetIndustries).toHaveBeenCalledTimes(1);
  });

  it('assembles the six reads into one ReferenceData object', async () => {
    const result = await loadReferenceData();

    expect(result).toEqual({
      vertical: VERTICAL,
      productsByCategory: [{ category: 'CRM', products: [] }],
      supportTypes: [{ id: 'support-1', name: 'Implementation' }],
      certificationsByCategory: [{ category: 'Admin', certifications: [] }],
      languages: [{ id: 'en', name: 'English' }],
      industries: [{ id: 'fin', name: 'Financial Services' }],
    });
  });

  it('propagates a repository failure rather than swallowing it', async () => {
    mockGetSalesforceVertical.mockRejectedValue(new Error('db unavailable'));
    await expect(loadReferenceData()).rejects.toThrow('db unavailable');
  });
});

// BAL-502 FIX round — `unstable_cache` needs Next's request-scoped incremental-cache handler,
// absent in a plain vitest process (and, rarely, in a misconfigured production cache handler).
// This suite proves the fallback: reset the module registry and remock `next/cache` so
// `unstable_cache` throws the exact invariant Next throws, then assert `loadReferenceData`
// still resolves (from the uncached read) and logs a warning rather than throwing.
describe('loadReferenceData — unstable_cache fallback', () => {
  it('falls back to the uncached read and logs a warning when unstable_cache throws', async () => {
    vi.resetModules();
    vi.doMock('next/cache', () => ({
      unstable_cache: () => () => {
        throw new Error('Invariant: incrementalCache missing in unstable_cache');
      },
    }));

    const { loadReferenceData: freshLoadReferenceData } = await import('./reference-data');
    const { log } = await import('@/lib/logging');

    const result = await freshLoadReferenceData();

    expect(result.vertical).toEqual(VERTICAL);
    expect(log.warn).toHaveBeenCalledWith(
      'unstable_cache unavailable for expert-apply reference data; reading uncached',
      expect.objectContaining({ error: expect.stringContaining('incrementalCache') })
    );

    vi.doUnmock('next/cache');
    vi.resetModules();
  });
});
