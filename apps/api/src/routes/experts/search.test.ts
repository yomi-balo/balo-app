import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { ExpertSearchRow } from '@balo/db';

// ── Hoisted mocks — run before vi.mock factory callbacks ─────────────────────

const {
  mockResolveVerticalId,
  mockSearch,
  mockFacetCounts,
  mockCountMatchingIgnoringGate,
  mockCheckRateLimit,
  mockTrackServer,
  mockRedisGet,
  mockRedisSet,
  mockGetRedis,
} = vi.hoisted(() => {
  const redisGet = vi.fn();
  const redisSet = vi.fn();
  return {
    mockResolveVerticalId: vi.fn(),
    mockSearch: vi.fn(),
    mockFacetCounts: vi.fn(),
    mockCountMatchingIgnoringGate: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockTrackServer: vi.fn(),
    mockRedisGet: redisGet,
    mockRedisSet: redisSet,
    // Shared fake Redis for both the rate-limiter and the facet cache. `get`
    // returns null (cache miss → compute live), `set` resolves.
    mockGetRedis: vi.fn(() => ({ get: redisGet, set: redisSet })),
  };
});

vi.mock('@balo/db', () => ({
  expertSearchRepository: {
    resolveVerticalId: mockResolveVerticalId,
    search: mockSearch,
    facetCounts: mockFacetCounts,
    countMatchingIgnoringGate: mockCountMatchingIgnoringGate,
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: mockGetRedis,
}));

vi.mock('../../lib/rate-limiter.js', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  SEARCH_SERVER_EVENTS: {
    SEARCH_PERFORMED: 'search_performed',
    SEARCH_ZERO_RESULTS: 'search_zero_results',
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

const VERTICAL_ID = 'vertical-uuid-1';
const UUID_A = '11111111-1111-4111-8111-111111111111';

function buildRow(overrides: Partial<ExpertSearchRow> = {}): ExpertSearchRow {
  return {
    id: 'expert-1',
    username: 'jdoe',
    firstName: 'Jane',
    lastName: 'Doe',
    avatarUrl: null,
    countryCode: 'AU',
    headline: 'Salesforce architect',
    bio: null,
    rateCents: 250,
    earliestAvailableAt: new Date('2026-06-03T09:30:00.000Z'),
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
    yearStartedSalesforce: 2016,
    agencyName: null,
    agencyLogoUrl: null,
    consultationCount: 0,
    languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
    competencies: [
      {
        productId: 'sales-cloud',
        productName: 'Sales Cloud',
        supportTypeSlug: 'technical-fix-support',
        proficiency: 5,
      },
    ],
    ...overrides,
  };
}

const EMPTY_FACETS = { products: [], supportTypes: [], languages: [] };

describe('GET /experts/search', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
    mockResolveVerticalId.mockResolvedValue(VERTICAL_ID);
    mockSearch.mockResolvedValue({ rows: [buildRow()], total: 1 });
    mockFacetCounts.mockResolvedValue(EMPTY_FACETS);
    mockCountMatchingIgnoringGate.mockResolvedValue(0);
    delete process.env.EXPERT_SEARCH_AVAILABILITY_GATE;
    // Facet cache: miss by default → route computes live via facetCounts.
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
  });

  function inject(query = '') {
    return app.inject({ method: 'GET', url: `/experts/search${query}` });
  }

  it('returns 200 with the response envelope shape', async () => {
    const res = await inject();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('experts');
    expect(body).toHaveProperty('total', 1);
    expect(body.facetCounts).toEqual(EMPTY_FACETS);
    expect(body.experts[0]).toMatchObject({ id: 'expert-1', name: 'Jane Doe', rate: 2.5 });
  });

  it("passes each expert's competencies through to the response", async () => {
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(res.json().experts[0].competencies).toEqual([
      {
        productId: 'sales-cloud',
        productName: 'Sales Cloud',
        supportTypeSlug: 'technical-fix-support',
        proficiency: 5,
      },
    ]);
  });

  it('sets a public Cache-Control header on success', async () => {
    const res = await inject();
    expect(res.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
  });

  it('returns 400 invalid_query on a bad query param', async () => {
    const res = await inject('?pageSize=999');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    expect(Array.isArray(res.json().details)).toBe(true);
  });

  it('returns 400 invalid_query on a non-UUID facet', async () => {
    const res = await inject('?products=not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
  });

  it('returns 400 invalid_query for an unknown vertical', async () => {
    mockResolveVerticalId.mockResolvedValue(null);
    const res = await inject('?vertical=unknownco');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_query', details: ['unknown vertical'] });
  });

  it('returns 429 rate_limited with Retry-After when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 61, ttlSeconds: 42 });
    const res = await inject();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 42 });
    expect(res.headers['retry-after']).toBe('42');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('fails open (200) when the rate-limit check throws', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('Redis down'));
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(mockSearch).toHaveBeenCalledOnce();
  });

  it('passes the gate flag (false by default) through to the repo', async () => {
    delete process.env.EXPERT_SEARCH_AVAILABILITY_GATE;
    await inject();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityGateEnabled: false, verticalId: VERTICAL_ID })
    );
    expect(mockFacetCounts).toHaveBeenCalledWith(VERTICAL_ID, false, expect.any(Date));
  });

  it('derives availabilityGateEnabled=true when env is "on"', async () => {
    process.env.EXPERT_SEARCH_AVAILABILITY_GATE = 'on';
    await inject();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityGateEnabled: true })
    );
    delete process.env.EXPERT_SEARCH_AVAILABILITY_GATE;
  });

  it('forwards parsed filters to the repo', async () => {
    await inject(`?q=agentforce&products=${UUID_A}&sort=soonest&page=2&pageSize=10`);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'agentforce',
        productIds: [UUID_A],
        sort: 'soonest',
        page: 2,
        pageSize: 10,
      })
    );
  });

  it('emits search_performed on success', async () => {
    await inject('?q=agentforce');
    expect(mockTrackServer).toHaveBeenCalledWith(
      'search_performed',
      expect.objectContaining({
        has_query: true,
        result_count: 1,
        sort: 'best_match',
        vertical: 'salesforce',
        distinct_id: expect.stringMatching(/^search:[0-9a-f]{64}$/),
      })
    );
  });

  it('does not emit search_zero_results when there are results', async () => {
    await inject();
    expect(mockTrackServer).not.toHaveBeenCalledWith('search_zero_results', expect.anything());
  });

  it('emits both events when total is 0', async () => {
    mockSearch.mockResolvedValue({ rows: [], total: 0 });
    await inject('?q=nomatch');
    expect(mockTrackServer).toHaveBeenCalledWith(
      'search_performed',
      expect.objectContaining({ result_count: 0 })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'search_zero_results',
      expect.objectContaining({ query: 'nomatch', filters: expect.any(Object) })
    );
  });

  it('counts applied filters for analytics', async () => {
    await inject(`?products=${UUID_A}&rateMin=100&timeframe=week`);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'search_performed',
      expect.objectContaining({ filter_count: 3 })
    );
  });

  it('returns 500 search_failed when the repo throws', async () => {
    mockSearch.mockRejectedValue(new Error('boom'));
    const res = await inject();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'search_failed' });
  });

  it('computes facet counts live and caches them on a cache miss', async () => {
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(mockFacetCounts).toHaveBeenCalledOnce();
    expect(mockRedisGet).toHaveBeenCalledWith('search:facets:vertical-uuid-1:off');
    expect(mockRedisSet).toHaveBeenCalledWith(
      'search:facets:vertical-uuid-1:off',
      JSON.stringify(EMPTY_FACETS),
      'EX',
      60
    );
  });

  it('serves facet counts from the cache on a hit (no repo call)', async () => {
    const cached = {
      products: [{ id: 'p1', name: 'P', count: 3 }],
      supportTypes: [],
      languages: [],
    };
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(res.json().facetCounts).toEqual(cached);
    expect(mockFacetCounts).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('fails open: computes facet counts live when Redis throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis down'));
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(res.json().facetCounts).toEqual(EMPTY_FACETS);
    expect(mockFacetCounts).toHaveBeenCalledOnce();
  });

  it('does not turn a 200 into a 500 when analytics tracking throws', async () => {
    mockTrackServer.mockImplementation(() => {
      throw new Error('analytics down');
    });
    const res = await inject('?q=agentforce');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('total', 1);
  });

  // ── wasAvailabilityGated (additive zero-results probe) ──────────────────────

  describe('wasAvailabilityGated', () => {
    it('is false (no probe) when there are results', async () => {
      process.env.EXPERT_SEARCH_AVAILABILITY_GATE = 'on';
      mockSearch.mockResolvedValue({ rows: [buildRow()], total: 1 });
      const res = await inject('?q=agentforce');
      expect(res.statusCode).toBe(200);
      expect(res.json().wasAvailabilityGated).toBe(false);
      expect(mockCountMatchingIgnoringGate).not.toHaveBeenCalled();
    });

    it('is false (no probe) when total is 0 but the gate is off', async () => {
      delete process.env.EXPERT_SEARCH_AVAILABILITY_GATE;
      mockSearch.mockResolvedValue({ rows: [], total: 0 });
      const res = await inject('?q=nomatch');
      expect(res.statusCode).toBe(200);
      expect(res.json().wasAvailabilityGated).toBe(false);
      expect(mockCountMatchingIgnoringGate).not.toHaveBeenCalled();
    });

    it('is true when total is 0, gate is on, and the ungated probe finds matches', async () => {
      process.env.EXPERT_SEARCH_AVAILABILITY_GATE = 'on';
      mockSearch.mockResolvedValue({ rows: [], total: 0 });
      mockCountMatchingIgnoringGate.mockResolvedValue(3);
      const res = await inject('?q=nomatch&timeframe=today');
      expect(res.statusCode).toBe(200);
      expect(res.json().wasAvailabilityGated).toBe(true);
      // Probe ignores the gate and the self-gating timeframe filter.
      expect(mockCountMatchingIgnoringGate).toHaveBeenCalledWith(
        expect.objectContaining({ availabilityGateEnabled: false, timeframe: undefined })
      );
    });

    it('is false when total is 0, gate is on, and the ungated probe finds nothing', async () => {
      process.env.EXPERT_SEARCH_AVAILABILITY_GATE = 'on';
      mockSearch.mockResolvedValue({ rows: [], total: 0 });
      mockCountMatchingIgnoringGate.mockResolvedValue(0);
      const res = await inject('?q=nomatch');
      expect(res.statusCode).toBe(200);
      expect(res.json().wasAvailabilityGated).toBe(false);
      expect(mockCountMatchingIgnoringGate).toHaveBeenCalledOnce();
    });
  });
});
