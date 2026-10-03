import { describe, it, expect } from 'vitest';
import { buildSimilarExpertsHref } from './similar-experts-href';
import { parseSearchParams } from './filters';

function parse(href: string): ReturnType<typeof parseSearchParams> {
  const [path, query] = href.split('?');
  expect(path).toBe('/experts');
  return parseSearchParams(new URLSearchParams(query));
}

describe('buildSimilarExpertsHref', () => {
  it('scopes to the vertical, this week and soonest-first', () => {
    const filters = parse(buildSimilarExpertsHref({ verticalSlug: 'salesforce' }));
    expect(filters.vertical).toBe('salesforce');
    expect(filters.timeframe).toBe('week');
    expect(filters.sort).toBe('soonest');
    expect(filters.products).toEqual([]);
  });

  it('adds the top product when one is given', () => {
    const filters = parse(buildSimilarExpertsHref({ verticalSlug: 'salesforce', productId: 'p1' }));
    expect(filters.products).toEqual(['p1']);
  });

  it('carries a non-default vertical in the URL', () => {
    expect(buildSimilarExpertsHref({ verticalSlug: 'workday' })).toContain('vertical=workday');
  });

  it('omits the vertical param for the default vertical', () => {
    expect(buildSimilarExpertsHref({ verticalSlug: 'salesforce' })).not.toContain('vertical=');
  });
});
