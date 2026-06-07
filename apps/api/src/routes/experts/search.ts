import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { expertSearchRepository, type ExpertSearchParams } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, SEARCH_SERVER_EVENTS } from '@balo/analytics/server';
import { getRedis } from '../../lib/redis.js';
import { checkRateLimit, type RateLimitConfig } from '../../lib/rate-limiter.js';
import { isAvailabilityGateEnabled } from '../../lib/search-availability-gate.js';
import { searchQuerySchema, type SearchQuery } from './schema.js';
import { mapRowToExpertSearchResult } from './mapper.js';
import type { ExpertSearchResponse } from './types.js';

const log = createLogger('expert-search-route');

/** 60 req/min/IP — generous for a human filtering/typing with debounce; throttles scrapers. */
const RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:expert-search',
  maxRequests: 60,
  windowSeconds: 60,
};

/** Stable per-visitor analytics id WITHOUT storing PII — hashed client IP. */
function searchDistinctId(ip: string): string {
  return `search:${crypto.createHash('sha256').update(ip).digest('hex')}`;
}

/** TTL for the facet-count cache. Facet totals are selection-independent and
 *  change slowly, so a short window absorbs the GROUP-BY cost across the burst
 *  of requests a single browsing session generates. */
const FACET_CACHE_TTL_SECONDS = 60;

type FacetCounts = Awaited<ReturnType<typeof expertSearchRepository.facetCounts>>;

/**
 * Short-TTL Redis cache around `facetCounts`. Keyed by `(verticalId, gateOn|off)`
 * — the only inputs the repo result depends on. FAIL-OPEN: any Redis error
 * (unavailable, parse failure, write failure) falls back to a live repo
 * computation so a cache outage never breaks search.
 */
async function getCachedFacetCounts(
  verticalId: string,
  availabilityGateEnabled: boolean,
  now: Date
): Promise<FacetCounts> {
  const key = `search:facets:${verticalId}:${availabilityGateEnabled ? 'on' : 'off'}`;
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as FacetCounts;
    }
    const result = await expertSearchRepository.facetCounts(
      verticalId,
      availabilityGateEnabled,
      now
    );
    await redis.set(key, JSON.stringify(result), 'EX', FACET_CACHE_TTL_SECONDS);
    return result;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Facet cache Redis unavailable, computing live'
    );
    return expertSearchRepository.facetCounts(verticalId, availabilityGateEnabled, now);
  }
}

/** Count applied filters: non-empty facets + rate bounds + timeframe. */
function countAppliedFilters(query: SearchQuery): number {
  let count = 0;
  if (query.products.length) count += 1;
  if (query.supportTypes.length) count += 1;
  if (query.languages.length) count += 1;
  if (query.industries.length) count += 1;
  if (query.rateMin !== undefined) count += 1;
  if (query.rateMax !== undefined) count += 1;
  if (query.timeframe !== undefined) count += 1;
  return count;
}

/** Applied-filter snapshot for the zero-results event (ids + rate/timeframe). */
function appliedFiltersSnapshot(query: SearchQuery): Record<string, unknown> {
  return {
    products: query.products,
    supportTypes: query.supportTypes,
    languages: query.languages,
    industries: query.industries,
    rateMin: query.rateMin ?? null,
    rateMax: query.rateMax ?? null,
    timeframe: query.timeframe ?? null,
  };
}

/**
 * Rate-limit preHandler keyed by client IP. Fail-open on Redis error (search
 * availability outranks strict limiting on a public read-only endpoint).
 * Returns `true` if the request was rejected (caller must stop).
 */
async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try {
    const result = await checkRateLimit(getRedis(), RATE_LIMIT, request.ip);
    if (!result.allowed) {
      reply
        .header('Retry-After', String(result.ttlSeconds))
        .status(429)
        .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
      return true;
    }
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Search rate-limit Redis unavailable — failing open'
    );
  }
  return false;
}

export async function searchRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/experts/search',
    { preHandler: [enforceRateLimit] },
    async (request, reply): Promise<ExpertSearchResponse | undefined> => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.status(400).send({
          error: 'invalid_query',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
        return undefined;
      }

      const query = parsed.data;
      const now = new Date();

      try {
        const verticalId = await expertSearchRepository.resolveVerticalId(query.vertical);
        if (!verticalId) {
          log.warn({ slug: query.vertical }, 'Unknown vertical slug');
          reply.status(400).send({ error: 'invalid_query', details: ['unknown vertical'] });
          return undefined;
        }

        const availabilityGateEnabled = isAvailabilityGateEnabled();

        const searchParams: ExpertSearchParams = {
          query: query.q,
          productIds: query.products,
          supportTypeIds: query.supportTypes,
          languageIds: query.languages,
          industryIds: query.industries,
          verticalId,
          timeframe: query.timeframe,
          rateMinCents: query.rateMin,
          rateMaxCents: query.rateMax,
          sort: query.sort,
          page: query.page,
          pageSize: query.pageSize,
          availabilityGateEnabled,
          now,
        };

        const [{ rows, total }, facetCounts] = await Promise.all([
          expertSearchRepository.search(searchParams),
          getCachedFacetCounts(verticalId, availabilityGateEnabled, now),
        ]);

        const experts = rows.map((row) => mapRowToExpertSearchResult(row, now));
        const distinctId = searchDistinctId(request.ip);
        const hasQuery = (query.q?.length ?? 0) > 0;

        // Additive zero-results probe: distinguish "no competencies match" from
        // "matched but none currently bookable". Runs ONLY in the rare
        // `total === 0 && gate-on` path so the hot path adds zero queries.
        let wasAvailabilityGated = false;
        if (total === 0 && availabilityGateEnabled) {
          const ungatedCount = await expertSearchRepository.countMatchingIgnoringGate({
            ...searchParams,
            availabilityGateEnabled: false,
            timeframe: undefined,
          });
          wasAvailabilityGated = ungatedCount > 0;
        }

        // Analytics is best-effort telemetry — a throw here must NOT turn a
        // successful 200 into a 500.
        try {
          trackServer(SEARCH_SERVER_EVENTS.SEARCH_PERFORMED, {
            has_query: hasQuery,
            filter_count: countAppliedFilters(query),
            result_count: total,
            sort: query.sort,
            vertical: query.vertical,
            distinct_id: distinctId,
          });

          if (total === 0) {
            trackServer(SEARCH_SERVER_EVENTS.SEARCH_ZERO_RESULTS, {
              query: query.q ?? '',
              filters: appliedFiltersSnapshot(query),
              distinct_id: distinctId,
            });
          }
        } catch (error) {
          log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Search analytics tracking failed (non-fatal)'
          );
        }

        reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        return { experts, total, facetCounts, wasAvailabilityGated };
      } catch (error) {
        log.error(
          {
            verticalSlug: query.vertical,
            sort: query.sort,
            page: query.page,
            filterCount: countAppliedFilters(query),
            hasQuery: (query.q?.length ?? 0) > 0,
            queryLength: query.q?.length ?? 0,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Expert search failed'
        );
        reply.status(500).send({ error: 'search_failed' });
        return undefined;
      }
    }
  );
}
