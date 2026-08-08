/**
 * Remove `//` line comments and block comments from TypeScript source via an indexOf SCAN
 * (deliberately NOT a regex, so there is zero ReDoS surface and the SonarCloud S5852 gate
 * never sees a super-linear pattern).
 *
 * Used by the structural-invariant tests, which read a source file and assert what it does
 * or does not contain: a comment that MENTIONS a forbidden construct — often precisely to
 * explain why it is absent — must not trip the invariant.
 *
 * Lives here rather than as a local copy in each invariant suite so there is ONE
 * implementation (a second copy is both a Sonar new-code duplication finding and a copy
 * that keeps passing after the original's scanner is fixed).
 *
 * ⚠ WHY `@balo/shared` AND NOT `@balo/db` (BAL-413). It started in
 * `packages/db/src/test/helpers/`, which put it out of reach of every invariant suite
 * OUTSIDE `@balo/db` — `@balo/db` depends on `@balo/shared`, never the reverse — so
 * `packages/shared/src/authz/engagement.test.ts` grew a regex copy instead. That copy was
 * exactly the `/\/\*[\s\S]*?\*\//g` super-linear shape this docblock warns about
 * (`[\s\S]` does not exclude the terminator, so an unterminated `/*` backtracks O(n²)).
 * Living in the LOWEST package in the graph is what makes re-use possible in both
 * directions, so the second copy never has to be written.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break; // unterminated block comment — drop the remainder
      i = end + 2;
      continue;
    }
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i + 2);
      if (nl === -1) break; // trailing line comment — drop the remainder
      i = nl; // preserve the newline itself
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}
