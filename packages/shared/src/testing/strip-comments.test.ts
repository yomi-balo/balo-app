import { describe, it, expect } from 'vitest';
import { stripComments } from './strip-comments';

/**
 * `stripComments` is the shared scanner behind every structural-invariant suite in the
 * repo (`packages/db/src/invariants/**`, `packages/shared/src/authz/engagement.test.ts`).
 * Those suites assert that a production source does NOT contain some construct — so a
 * BUG HERE FAILS OPEN: under-stripping makes an invariant fail on the prose that explains
 * an absence, and over-stripping makes it pass while the forbidden construct is still
 * there. It is worth its own tests for that reason alone.
 *
 * It moved from `packages/db/src/test/helpers/` to `@balo/shared/testing` in BAL-413 so
 * suites outside `@balo/db` can reach it (the dependency only runs db → shared).
 */
describe('stripComments', () => {
  it('removes a block comment and keeps the code around it', () => {
    expect(stripComments('const a = 1; /* note */ const b = 2;')).toBe(
      'const a = 1;  const b = 2;'
    );
  });

  it('removes a line comment but PRESERVES the newline that terminated it', () => {
    // The newline must survive, or two statements on consecutive lines would be joined
    // into one and a line-anchored assertion in a caller would silently change meaning.
    expect(stripComments('const a = 1; // note\nconst b = 2;')).toBe('const a = 1; \nconst b = 2;');
  });

  it('removes a multi-line docblock, including the constructs it mentions', () => {
    // The load-bearing case: a docblock naming a forbidden import in order to explain
    // that it is absent must not trip the invariant that forbids it.
    const source = [
      '/**',
      " * Never import 'server-only' here.",
      ' */',
      'export const x = 1;',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).not.toContain('server-only');
    expect(stripped).toContain('export const x = 1;');
  });

  it('drops the remainder after an UNTERMINATED block comment', () => {
    // Fail-closed on malformed input: everything after the opener is discarded rather
    // than emitted raw, so an unterminated comment can never leak text into the scan.
    expect(stripComments('const a = 1; /* never closed')).toBe('const a = 1; ');
  });

  it('drops a trailing line comment that has no newline after it', () => {
    expect(stripComments('const a = 1; // eof comment')).toBe('const a = 1; ');
  });

  it('leaves source with no comments byte-identical', () => {
    const source = 'export function f(): number {\n  return 1;\n}\n';
    expect(stripComments(source)).toBe(source);
  });

  it('returns an empty string for empty input', () => {
    expect(stripComments('')).toBe('');
  });

  it('strips a comment-shaped sequence inside a string literal too — a known, accepted limit', () => {
    // Documented rather than fixed: the scanner is not a lexer and does not track string
    // state. Every caller feeds it TypeScript source and asserts on identifiers, where a
    // `/*` inside a literal does not occur. Stated here so the limit is a known one.
    expect(stripComments('const s = "a /* b */ c";')).toBe('const s = "a  c";');
  });

  it('runs in linear time on a long unterminated-comment input (no ReDoS shape)', () => {
    // The regex this replaced (`/\/\*[\s\S]*?\*\//g`) backtracks O(n²) on exactly this
    // input class. The scanner breaks out of the loop at the opener instead.
    const hostile = `${'a'.repeat(50_000)}/*${'b'.repeat(50_000)}`;
    expect(stripComments(hostile)).toBe('a'.repeat(50_000));
  });
});
