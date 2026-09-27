import { describe, expect, it } from 'vitest';
import * as anonError from './error';
import * as marketingError from '../(marketing)/error';

/**
 * BAL-504 — `(marketing-anon)/error.tsx` re-exports `(marketing)/error.tsx` verbatim (same
 * reasoning as the opengraph-image re-export, pinned in `anon/page.test.tsx`). This test only
 * pins the re-export identity; `(marketing)/error.tsx`'s own render behaviour is out of scope
 * here.
 */
describe('(marketing-anon)/error — re-exports (marketing)/error verbatim', () => {
  it('re-exports the same default component', () => {
    expect(anonError.default).toBe(marketingError.default);
  });
});
