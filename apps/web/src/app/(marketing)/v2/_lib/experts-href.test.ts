import { describe, expect, it } from 'vitest';
import { parseSearchParams } from '@/lib/search/filters';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { VERTICAL } from './content';
import { buildExpertsHref, resolveTickerHref } from './experts-href';
import { toV2Taxonomy, type V2Taxonomy } from './product-facet-model';

/**
 * A small "live" fixture — deliberately NOT the real production taxonomy (that's an
 * integration concern of `/experts` itself, out of scope here). It exists to prove
 * `resolveTickerHref`'s exact-name / case-insensitive / group-never-matches contract
 * against a handful of the ref's 18 ticker labels (O2).
 */
const LIVE_TAXONOMY: V2Taxonomy = {
  source: 'live',
  groups: [
    {
      group: 'Sales',
      items: [
        { id: 'prod-sales-cloud', name: 'Sales Cloud' },
        { id: 'prod-cpq', name: 'CPQ' },
      ],
    },
    {
      group: 'Integration',
      items: [{ id: 'prod-mulesoft', name: 'MuleSoft' }],
    },
    {
      // The group name deliberately collides with a ticker label that has NO matching
      // item — resolveTickerHref must never match on the group name (O1 dissolves N2).
      group: 'Marketing Cloud',
      items: [{ id: 'prod-account-engagement', name: 'Account Engagement' }],
    },
  ],
};

const FALLBACK_V2_TAXONOMY = toV2Taxonomy(EMPTY_TAXONOMY);

describe('buildExpertsHref', () => {
  it('returns bare /experts with no q and no products (no trailing "?")', () => {
    expect(buildExpertsHref({ q: '', productIds: [] })).toBe('/experts');
  });

  it('appends q only', () => {
    expect(buildExpertsHref({ q: 'flow debugging', productIds: [] })).toBe(
      '/experts?q=flow+debugging'
    );
  });

  it('omits whitespace-only q — pins the .trim() guard shared with /experts', () => {
    expect(buildExpertsHref({ q: '   ', productIds: [] })).toBe('/experts');
  });

  it('emits repeated products= params, in selection order, never comma-joined', () => {
    const href = buildExpertsHref({ q: '', productIds: ['id-1', 'id-2'] });
    expect(href).toBe('/experts?products=id-1&products=id-2');
  });

  it('combines q and products', () => {
    const href = buildExpertsHref({ q: 'flow', productIds: ['id-1'] });
    expect(href).toBe('/experts?q=flow&products=id-1');
  });

  it('round-trips through the repo’s own parseSearchParams (O1)', () => {
    const href = buildExpertsHref({ q: 'agentforce rollout', productIds: ['id-1', 'id-2'] });
    const [, queryString] = href.split('?');
    const parsed = parseSearchParams(new URLSearchParams(queryString ?? ''));
    expect(parsed.q).toBe('agentforce rollout');
    expect(parsed.products).toEqual(['id-1', 'id-2']);
  });

  it('round-trips an empty result too', () => {
    const href = buildExpertsHref({ q: '', productIds: [] });
    const [, queryString] = href.split('?');
    const parsed = parseSearchParams(new URLSearchParams(queryString ?? ''));
    expect(parsed.q).toBe('');
    expect(parsed.products).toEqual([]);
  });
});

describe('resolveTickerHref', () => {
  it('exact full-name hit resolves to a filtered /experts href', () => {
    expect(resolveTickerHref('Sales Cloud', LIVE_TAXONOMY)).toBe(
      '/experts?products=prod-sales-cloud'
    );
  });

  it('documented miss: "Revenue Cloud & CPQ" has no matching product row (do not alias it)', () => {
    expect(resolveTickerHref('Revenue Cloud & CPQ', LIVE_TAXONOMY)).toBe('/experts');
  });

  it('is case-insensitive and whitespace-trimmed', () => {
    expect(resolveTickerHref('mulesoft', LIVE_TAXONOMY)).toBe('/experts?products=prod-mulesoft');
    expect(resolveTickerHref('  MuleSoft  ', LIVE_TAXONOMY)).toBe(
      '/experts?products=prod-mulesoft'
    );
  });

  it('never matches on the group name', () => {
    expect(resolveTickerHref('Marketing Cloud', LIVE_TAXONOMY)).toBe('/experts');
  });

  it('fallback taxonomy (every id null) always misses — a null id cannot build a products= param', () => {
    for (const label of VERTICAL.ticker) {
      expect(resolveTickerHref(label, FALLBACK_V2_TAXONOMY)).toBe('/experts');
    }
  });

  it('sweep: all 18 ticker labels resolve to a string starting with /experts, never a bare "#" (AC 4)', () => {
    expect(VERTICAL.ticker).toHaveLength(18);
    for (const label of VERTICAL.ticker) {
      const href = resolveTickerHref(label, LIVE_TAXONOMY);
      expect(href.startsWith('/experts')).toBe(true);
      expect(href.startsWith('#')).toBe(false);
    }
  });
});
