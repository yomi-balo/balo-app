import { describe, expect, it } from 'vitest';
import { isMarketingHomePath } from './is-marketing-home-path';

describe('isMarketingHomePath', () => {
  it('matches the bare root path', () => {
    expect(isMarketingHomePath('/')).toBe(true);
  });

  it('ignores a query string', () => {
    expect(isMarketingHomePath('/?utm_source=x')).toBe(true);
  });

  it('ignores a hash', () => {
    expect(isMarketingHomePath('/#hero')).toBe(true);
  });

  it('ignores both a query string and a hash', () => {
    expect(isMarketingHomePath('/?ref=y#hero')).toBe(true);
  });

  it('does not match a nested marketing route', () => {
    expect(isMarketingHomePath('/experts')).toBe(false);
    expect(isMarketingHomePath('/experts/some-username')).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(isMarketingHomePath('')).toBe(false);
  });

  it('does not match a lookalike path', () => {
    expect(isMarketingHomePath('//')).toBe(false);
  });
});
