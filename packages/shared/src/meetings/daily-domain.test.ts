import { describe, expect, it } from 'vitest';
import { isDailyDomainLabel } from './daily-domain';

describe('isDailyDomainLabel', () => {
  it.each(['getbalo', 'balo-staging-2', 'a', '123', '-', 'a-b-c'])('accepts %j', (label) => {
    expect(isDailyDomainLabel(label)).toBe(true);
  });

  it.each(['', 'GetBalo', 'get_balo', 'a.b', 'a/b', 'a b', 'é', 'a\n', '.daily.co'])(
    'rejects %j',
    (label) => {
      expect(isDailyDomainLabel(label)).toBe(false);
    }
  );
});
