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
