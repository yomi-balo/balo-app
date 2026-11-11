import { describe, it, expect } from 'vitest';
import { DEFAULT_RESULTS_LAYOUT, layoutParamFor, parseResultsLayout } from './layout';

describe('parseResultsLayout', () => {
  it('defaults to list', () => {
    expect(DEFAULT_RESULTS_LAYOUT).toBe('list');
    expect(parseResultsLayout(undefined)).toBe('list');
  });

  it('falls back to the default for junk and arrays', () => {
    expect(parseResultsLayout('table')).toBe('list');
    expect(parseResultsLayout('')).toBe('list');
    expect(parseResultsLayout(['grid', 'list'])).toBe('list');
  });

  it('returns grid and list when given exactly those values', () => {
    expect(parseResultsLayout('grid')).toBe('grid');
    expect(parseResultsLayout('list')).toBe('list');
  });
});

describe('layoutParamFor', () => {
  it('writes grid and clears the param for the default', () => {
    expect(layoutParamFor('grid')).toBe('grid');
    expect(layoutParamFor('list')).toBeNull();
  });
});
