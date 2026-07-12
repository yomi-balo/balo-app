import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * BAL-369 / ADR-1038 structural invariant (DB-scoped mechanical tripwire).
 *
 * The corporate-domain CLAIM must live at the onboarding Intent step
 * (`companiesRepository.promoteToOrganization`), NEVER at signup. This test reads
 * `repositories/users.ts` — the signup-time `createWithWorkspace` seam — strips its
 * comments, and asserts the source performs no domain claim of any kind. Mirrors the
 * S1 web-layer invariant (`apps/web/src/invariants/…`), but scoped to the DB layer.
 *
 * Scoped to `users.ts` ONLY on purpose: a blanket repo scan would false-positive on
 * `party-domains.ts` (defines `capture`) and `agencies.ts` (a legitimate `capture(`
 * at the expert-axis Continue step).
 */

/**
 * Remove `//` line comments and block comments via an indexOf scan (NOT a regex) so
 * there is zero ReDoS surface — a comment mentioning a claim call must not trip the
 * invariant, and the SonarCloud S5852 gate never sees a super-linear pattern here.
 */
function stripComments(src: string): string {
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

// Claim-detection patterns — deliberately simple (single `\s*` only, no nested
// quantifiers) so they are SonarCloud S5852-safe.
const CLAIM_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'partyDomainsRepository.capture(',
    pattern: /partyDomainsRepository\s*\.\s*capture\s*\(/,
  },
  { label: '.claim(', pattern: /\.\s*claim\s*\(/ },
  { label: 'insert(partyDomains', pattern: /insert\s*\(\s*partyDomains\b/ },
];

describe('invariant: createWithWorkspace performs no domain claim (BAL-369)', () => {
  const usersRepoPath = fileURLToPath(new URL('../repositories/users.ts', import.meta.url));
  const raw = readFileSync(usersRepoPath, 'utf8');
  const source = stripComments(raw);

  it('resolves users.ts and it still defines createWithWorkspace (non-vacuity guard)', () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(source).toContain('createWithWorkspace');
  });

  it.each(CLAIM_PATTERNS)('does not match a domain-claim call: $label', ({ pattern }) => {
    expect(pattern.test(source)).toBe(false);
  });
});
