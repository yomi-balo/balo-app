import { describe, it, expect } from 'vitest';
import { resolveStatementEntrySource } from './resolve-statement-source';

describe('resolveStatementEntrySource', () => {
  it('maps "money_block" through', () => {
    expect(resolveStatementEntrySource('money_block')).toBe('money_block');
  });

  it('maps undefined to "direct"', () => {
    expect(resolveStatementEntrySource(undefined)).toBe('direct');
  });

  it('maps any unrecognised value to "direct"', () => {
    expect(resolveStatementEntrySource('billing')).toBe('direct');
    expect(resolveStatementEntrySource('nope')).toBe('direct');
  });

  // ⚠ Adversarial — an object-literal index resolves inherited keys unless guarded.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'treats the adversarial key %s as "direct", never as an inherited Object member',
    (key) => {
      expect(resolveStatementEntrySource(key)).toBe('direct');
    }
  );
});
