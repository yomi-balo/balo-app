import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMPTY_FILTERS, type SearchFilters } from './filters';

const { mockLoggedFetch } = vi.hoisted(() => ({ mockLoggedFetch: vi.fn() }));
vi.mock('@/lib/logging/fetch-wrapper', () => ({ loggedFetch: mockLoggedFetch }));

import { searchExperts } from './search-data';

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Pull the querystring portion of the URL the seam fetched. */
function fetchedQuery(): URLSearchParams {
  const url = mockLoggedFetch.mock.calls[0]![0] as string;
  return new URLSearchParams(url.split('?')[1] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchExperts', () => {
  it('returns the parsed JSON body on success', async () => {
    const body = {
      experts: [],
      total: 0,
      facetCounts: { products: [], supportTypes: [], languages: [] },
      wasAvailabilityGated: false,
    };
    mockLoggedFetch.mockResolvedValue(jsonResponse(body));
    await expect(searchExperts(make())).resolves.toEqual(body);
  });

  it('calls loggedFetch with the expert-search service and GET', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({}));
    await searchExperts(make());
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/experts/search?'),
      expect.objectContaining({ service: 'expert-search', method: 'GET' })
    );
  });

  it('always includes vertical, sort, page, and pageSize defaults', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({}));
    await searchExperts(make());
    const q = fetchedQuery();
    expect(q.get('vertical')).toBe('salesforce');
    expect(q.get('sort')).toBe('best_match');
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('20');
  });

  it('omits empty arrays and absent scalar params', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({}));
    await searchExperts(make());
    const q = fetchedQuery();
    expect(q.getAll('products')).toEqual([]);
    expect(q.has('q')).toBe(false);
    expect(q.has('timeframe')).toBe(false);
    expect(q.has('rateMin')).toBe(false);
  });

  it('serializes arrays as repeated keys and converts rate to cents', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({}));
    await searchExperts(
      make({ products: ['p1', 'p2'], q: 'flows', rateMinDollars: 2, timeframe: 'today' })
    );
    const q = fetchedQuery();
    expect(q.getAll('products')).toEqual(['p1', 'p2']);
    expect(q.get('q')).toBe('flows');
    expect(q.get('rateMin')).toBe('200');
    expect(q.get('timeframe')).toBe('today');
  });

  it('throws on a non-2xx response', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({}, false, 429));
    await expect(searchExperts(make())).rejects.toThrow(/429/);
  });
});
