import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/helpers/strip-comments';

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
