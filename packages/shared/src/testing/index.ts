/**
 * `@balo/shared/testing` — helpers for the STRUCTURAL-INVARIANT suites (the tests that
 * read a source file and assert what it does or does not contain).
 *
 * ⚠ This subpath is imported only from `*.test.ts` files. It is deliberately NOT
 * re-exported from `@balo/shared`'s root entry, so nothing in a production bundle can
 * reach it by accident.
 */
export { stripComments } from './strip-comments';
