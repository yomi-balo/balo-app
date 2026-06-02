import { describe, it, expect } from 'vitest';
import { searchQuerySchema } from './schema.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('searchQuerySchema', () => {
  it('applies defaults on an empty query', () => {
    const result = searchQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      vertical: 'salesforce',
      sort: 'best_match',
      page: 1,
      pageSize: 20,
      products: [],
      supportTypes: [],
      languages: [],
      industries: [],
    });
    expect(result.data.q).toBeUndefined();
    expect(result.data.timeframe).toBeUndefined();
  });

  it('coerces a single facet value into an array', () => {
    const result = searchQuerySchema.safeParse({ products: UUID_A });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.products).toEqual([UUID_A]);
  });

  it('keeps a repeated facet param as an array', () => {
    const result = searchQuerySchema.safeParse({ products: [UUID_A, UUID_B] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.products).toEqual([UUID_A, UUID_B]);
  });

  it('rejects a non-UUID facet value', () => {
    const result = searchQuerySchema.safeParse({ products: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown sort value', () => {
    const result = searchQuerySchema.safeParse({ sort: 'cheapest' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown timeframe value', () => {
    const result = searchQuerySchema.safeParse({ timeframe: 'tomorrow' });
    expect(result.success).toBe(false);
  });

  it('accepts each valid timeframe', () => {
    for (const tf of ['today', '3days', 'week'] as const) {
      expect(searchQuerySchema.safeParse({ timeframe: tf }).success).toBe(true);
    }
  });

  it('caps pageSize at 50', () => {
    expect(searchQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ pageSize: 50 }).success).toBe(true);
  });

  it('rejects pageSize below 1', () => {
    expect(searchQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
  });

  it('rejects page below 1', () => {
    expect(searchQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it('coerces numeric strings for page/pageSize/rate', () => {
    const result = searchQuerySchema.safeParse({
      page: '3',
      pageSize: '10',
      rateMin: '100',
      rateMax: '200',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.page).toBe(3);
    expect(result.data.pageSize).toBe(10);
    expect(result.data.rateMin).toBe(100);
    expect(result.data.rateMax).toBe(200);
  });

  it('rejects negative rate bounds', () => {
    expect(searchQuerySchema.safeParse({ rateMin: -1 }).success).toBe(false);
  });

  it('rejects q longer than 200 chars', () => {
    expect(searchQuerySchema.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'a'.repeat(200) }).success).toBe(true);
  });

  it('trims q whitespace', () => {
    const result = searchQuerySchema.safeParse({ q: '  agentforce  ' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.q).toBe('agentforce');
  });

  it('rejects an empty vertical slug', () => {
    expect(searchQuerySchema.safeParse({ vertical: '' }).success).toBe(false);
  });

  it('rejects rateMax < rateMin', () => {
    const result = searchQuerySchema.safeParse({ rateMin: 200, rateMax: 100 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['rateMax']);
  });

  it('accepts rateMax >= rateMin', () => {
    expect(searchQuerySchema.safeParse({ rateMin: 100, rateMax: 100 }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ rateMin: 100, rateMax: 200 }).success).toBe(true);
  });

  it('allows only one rate bound', () => {
    expect(searchQuerySchema.safeParse({ rateMin: 100 }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ rateMax: 100 }).success).toBe(true);
  });
});
