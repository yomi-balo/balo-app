import { describe, it, expect } from 'vitest';
import { applyBaloFee, DEFAULT_BALO_FEE_BPS } from '@balo/shared/pricing';
import {
  parseSearchParams,
  serializeSearchFilters,
  filtersToSearchRequest,
  countActiveFilters,
  EMPTY_FILTERS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_VERTICAL,
  type SearchFilters,
} from './filters';

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe('parseSearchParams', () => {
  it('returns defaults for empty params', () => {
    expect(parseSearchParams({})).toEqual(EMPTY_FILTERS);
    expect(parseSearchParams(new URLSearchParams())).toEqual(EMPTY_FILTERS);
  });

  it('parses q', () => {
    expect(parseSearchParams({ q: 'agentforce' }).q).toBe('agentforce');
  });

  it('parses array params from a record (single + multiple)', () => {
    const single = parseSearchParams({ products: 'p1' });
    expect(single.products).toEqual(['p1']);

    const multi = parseSearchParams({ products: ['p1', 'p2'] });
    expect(multi.products).toEqual(['p1', 'p2']);
  });

  it('parses repeated array keys from URLSearchParams', () => {
    const params = new URLSearchParams();
    params.append('supportTypes', 's1');
    params.append('supportTypes', 's2');
    params.append('languages', 'l1');
    const parsed = parseSearchParams(params);
    expect(parsed.supportTypes).toEqual(['s1', 's2']);
    expect(parsed.languages).toEqual(['l1']);
  });

  it('parses valid timeframe and rejects invalid to null', () => {
    expect(parseSearchParams({ timeframe: 'week' }).timeframe).toBe('week');
    expect(parseSearchParams({ timeframe: 'eventually' }).timeframe).toBeNull();
  });

  it('parses rate bounds as numbers and rejects invalid/negative', () => {
    expect(parseSearchParams({ rateMin: '2', rateMax: '8' })).toMatchObject({
      rateMinDollars: 2,
      rateMaxDollars: 8,
    });
    expect(parseSearchParams({ rateMin: 'abc' }).rateMinDollars).toBeNull();
    expect(parseSearchParams({ rateMin: '-3' }).rateMinDollars).toBeNull();
    expect(parseSearchParams({ rateMin: '' }).rateMinDollars).toBeNull();
  });

  it('defaults vertical when absent or blank', () => {
    expect(parseSearchParams({}).vertical).toBe(DEFAULT_VERTICAL);
    expect(parseSearchParams({ vertical: '   ' }).vertical).toBe(DEFAULT_VERTICAL);
    expect(parseSearchParams({ vertical: 'commerce' }).vertical).toBe('commerce');
  });

  it('clamps invalid sort to best_match', () => {
    expect(parseSearchParams({ sort: 'lowest_rate' }).sort).toBe('lowest_rate');
    expect(parseSearchParams({ sort: 'nonsense' }).sort).toBe('best_match');
  });

  it('clamps invalid/zero/negative/float page to 1', () => {
    expect(parseSearchParams({ page: '3' }).page).toBe(3);
    expect(parseSearchParams({ page: '0' }).page).toBe(1);
    expect(parseSearchParams({ page: '-1' }).page).toBe(1);
    expect(parseSearchParams({ page: '2.5' }).page).toBe(1);
    expect(parseSearchParams({ page: 'x' }).page).toBe(1);
  });
});

describe('serializeSearchFilters', () => {
  it('omits defaults and empties', () => {
    const params = serializeSearchFilters(EMPTY_FILTERS);
    expect(params.toString()).toBe('');
  });

  it('serializes set values, omitting default vertical/sort/page', () => {
    const params = serializeSearchFilters(
      make({
        q: 'flows',
        products: ['p1', 'p2'],
        timeframe: 'today',
        rateMinDollars: 2,
        rateMaxDollars: 8,
        sort: 'soonest',
        page: 2,
      })
    );
    expect(params.getAll('products')).toEqual(['p1', 'p2']);
    expect(params.get('q')).toBe('flows');
    expect(params.get('timeframe')).toBe('today');
    expect(params.get('rateMin')).toBe('2');
    expect(params.get('rateMax')).toBe('8');
    expect(params.get('sort')).toBe('soonest');
    expect(params.get('page')).toBe('2');
    expect(params.has('vertical')).toBe(false);
  });

  it('serializes non-default vertical', () => {
    expect(serializeSearchFilters(make({ vertical: 'commerce' })).get('vertical')).toBe('commerce');
  });
});

describe('round-trip parse(serialize(x)) === x', () => {
  const cases: SearchFilters[] = [
    EMPTY_FILTERS,
    make({ q: 'agentforce', sort: 'most_experienced', page: 4 }),
    make({ products: ['a', 'b'], supportTypes: ['s'], languages: ['l1', 'l2'] }),
    make({ timeframe: '3days', rateMinDollars: 1, rateMaxDollars: 6 }),
    make({ vertical: 'commerce' }),
  ];

  it.each(cases.map((c, i) => [i, c] as const))('round-trips case %i', (_i, filters) => {
    expect(parseSearchParams(serializeSearchFilters(filters))).toEqual(filters);
  });
});

describe('filtersToSearchRequest', () => {
  it('passes facet ids through and converts client A$ → EXPERT-facing cents', () => {
    const req = filtersToSearchRequest(
      make({ products: ['p1'], rateMinDollars: 2, rateMaxDollars: 8.5 })
    );
    expect(req.products).toEqual(['p1']);
    // A$2.00 client → 200c client → ceil(200 × 10000 / 12500) = 160c expert.
    expect(req.rateMin).toBe(160);
    // A$8.50 client → 850c client → floor(850 × 10000 / 12500) = 680c expert.
    expect(req.rateMax).toBe(680);
  });

  it('omits q/timeframe/rate when absent and sets defaults', () => {
    const req = filtersToSearchRequest(EMPTY_FILTERS);
    expect(req.q).toBeUndefined();
    expect(req.timeframe).toBeUndefined();
    expect(req.rateMin).toBeUndefined();
    expect(req.rateMax).toBeUndefined();
    expect(req.vertical).toBe(DEFAULT_VERTICAL);
    expect(req.sort).toBe('best_match');
    expect(req.page).toBe(1);
    expect(req.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('rounds fractional dollar amounts to nearest cent before removing the fee', () => {
    // A$3.336 → 334c client → ceil(334 × 10000 / 12500) = ceil(267.2) = 268c expert.
    expect(filtersToSearchRequest(make({ rateMinDollars: 3.336 })).rateMin).toBe(268);
  });

  /**
   * BAL-493 fix round 1 — the fee-concealment regression guard. The slider is CLIENT-facing
   * (D1 displays `applyBaloFee(rate_cents, 2500)`); the API bound is EXPERT-facing. If this
   * mapper ever passed the client figure through unconverted, an anonymous visitor could
   * bisect `?rateMax=` to recover an expert's raw `rate_cents` and read Balo's markup off the
   * displayed rate. These assertions are stated as a ROUND TRIP through `applyBaloFee` — they
   * fail if the conversion is dropped, and they fail if floor/ceil are swapped.
   */
  describe('the client→expert rate-bound conversion (fee concealment)', () => {
    it('never sends the client-facing figure as the expert-facing bound', () => {
      const req = filtersToSearchRequest(make({ rateMinDollars: 5, rateMaxDollars: 5 }));
      expect(req.rateMin).not.toBe(500);
      expect(req.rateMax).not.toBe(500);
    });

    it('max: the widest admitted expert rate still DISPLAYS at or under the slider max', () => {
      const clientMaxCents = 500; // the A$5.00/min the user actually dragged to
      const req = filtersToSearchRequest(make({ rateMaxDollars: 5 }));
      const bound = req.rateMax;
      expect(bound).toBe(400);
      if (bound === undefined) throw new Error('expected a rateMax bound');
      expect(applyBaloFee(bound, DEFAULT_BALO_FEE_BPS)).toBeLessThanOrEqual(clientMaxCents);
      // …and the first expert rate the bound rejects really displays ABOVE the slider max.
      expect(applyBaloFee(bound + 1, DEFAULT_BALO_FEE_BPS)).toBeGreaterThan(clientMaxCents);
    });

    it('min: the narrowest admitted expert rate still DISPLAYS at or over the slider min', () => {
      const clientMinCents = 500;
      const req = filtersToSearchRequest(make({ rateMinDollars: 5 }));
      const bound = req.rateMin;
      expect(bound).toBe(400);
      if (bound === undefined) throw new Error('expected a rateMin bound');
      expect(applyBaloFee(bound, DEFAULT_BALO_FEE_BPS)).toBeGreaterThanOrEqual(clientMinCents);
      // …and the last expert rate the bound rejects really displays BELOW the slider min.
      expect(applyBaloFee(bound - 1, DEFAULT_BALO_FEE_BPS)).toBeLessThan(clientMinCents);
    });
  });
});

describe('countActiveFilters', () => {
  it('returns 0 for empty', () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
  });

  it('counts each non-empty group, timeframe, each rate bound, and q', () => {
    expect(
      countActiveFilters(
        make({
          q: 'x',
          products: ['p'],
          supportTypes: ['s'],
          languages: ['l'],
          timeframe: 'week',
          rateMinDollars: 1,
          rateMaxDollars: 5,
        })
      )
    ).toBe(7);
  });

  it('does not count empty arrays or blank query', () => {
    expect(countActiveFilters(make({ q: '   ', products: [] }))).toBe(0);
  });
});
