import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BAL-371 / S3 — structural invariant for "signup detects, the wizard writes".
 *
 * The domain-join engine is now DETECT-ONLY: signup may look up + classify a
 * domain match, but it must NEVER write a membership or file a join request. Those
 * durable writes happen ONLY when the joiner consents in the onboarding JOIN
 * interstitial (`joinMatchedCompanyAction` / `requestJoinCompanyAction`).
 *
 * This is a mechanical tripwire that the four signup seams + the shared detect
 * engine never (re-)introduce a signup-time membership/request write. It scans ONLY
 * the pinned seam+engine files — NOT the whole `lib/auth/actions` directory, because
 * the wizard consent actions legitimately write and must not be flagged.
 *
 * Scan set (pinned):
 *   - `lib/domain-join/run-domain-join.ts`   — the detect engine + post-commit helper
 *   - `lib/auth/actions/sign-up.ts`          — password sign-up seam
 *   - `lib/auth/actions/sign-in.ts`          — password sign-in seam
 *   - `lib/auth/actions/verify-email.ts`     — OTP verify seam
 *   - `app/api/auth/callback/route.ts`       — the OAuth callback seam
 *
 * A `party_domains` READ (`findActiveByDomain`) and a join-settings READ are
 * ALLOWED — only the WRITES (`findOrCreateDomainMembership` / `findOrCreatePending`)
 * are forbidden in this pinned set.
 *
 * If this test fails: a signup-path change re-introduced a membership/request write.
 * Move it to the onboarding consent action (`joinMatchedCompanyAction` /
 * `requestJoinCompanyAction`) instead — signup detects, the wizard writes.
 */

/**
 * `apps/web/src`. vitest runs with cwd at the package root (`apps/web`); the
 * root-cwd fallback keeps this working if the suite is launched from the monorepo
 * root. The non-vacuity assertion below fails loudly if this ever resolves wrong.
 */
function resolveSrcDir(): string {
  const fromPackage = path.resolve(process.cwd(), 'src');
  if (existsSync(path.join(fromPackage, 'invariants'))) return fromPackage;
  const fromRoot = path.resolve(process.cwd(), 'apps', 'web', 'src');
  if (existsSync(path.join(fromRoot, 'invariants'))) return fromRoot;
  return fromPackage;
}

const SRC_DIR = resolveSrcDir();

/** The pinned signup path: the four seams + the shared detect engine. */
const PINNED_FILES: readonly string[] = [
  'lib/domain-join/run-domain-join.ts',
  'lib/auth/actions/sign-up.ts',
  'lib/auth/actions/sign-in.ts',
  'lib/auth/actions/verify-email.ts',
  'app/api/auth/callback/route.ts',
];

/** Strip block + line comments so mentions in JSDoc/comments don't count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * A membership/request WRITE, whitespace-tolerant. Reads (`findActiveByDomain`,
 * `getPartyJoinSettings`) are deliberately NOT matched. All quantifiers are simple
 * `\s*` over a char class — no nested/overlapping quantifiers (SonarCloud S5852-safe).
 */
const WRITE_PATTERNS: readonly RegExp[] = [
  /\bpartyMembershipsRepository\s*\.\s*findOrCreateDomainMembership\s*\(/,
  /\bpartyJoinRequestsRepository\s*\.\s*findOrCreatePending\s*\(/,
];

interface WriteScan {
  readonly scanned: string[];
  readonly writers: string[];
}

function scanSignupPath(): WriteScan {
  const scanned: string[] = [];
  const writers: string[] = [];
  for (const rel of PINNED_FILES) {
    const abs = path.join(SRC_DIR, rel);
    if (!existsSync(abs)) continue;
    scanned.push(rel);
    const stripped = stripComments(readFileSync(abs, 'utf8'));
    if (WRITE_PATTERNS.some((re) => re.test(stripped))) {
      writers.push(rel);
    }
  }
  return { scanned, writers };
}

describe('signup path detects but never writes a membership/request (BAL-371 / S3)', () => {
  const { scanned, writers } = scanSignupPath();

  // Non-vacuity guard: if the walk silently finds nothing (mis-resolved path or a
  // moved seam), every assertion below passes for the wrong reason. Pin the seams.
  it('collects the known signup seam files (guards against a vacuous pass)', () => {
    for (const seam of PINNED_FILES) {
      expect(scanned).toContain(seam);
    }
  });

  it('no signup-seam / engine file writes a membership or files a join request', () => {
    expect(
      writers,
      `These signup-path files reference a domain membership/request WRITE ` +
        `(findOrCreateDomainMembership / findOrCreatePending), but the signup engine is ` +
        `DETECT-ONLY (BAL-371). Move the write to the onboarding consent action ` +
        `(joinMatchedCompanyAction / requestJoinCompanyAction):\n  ${writers.join('\n  ')}`
    ).toEqual([]);
  });
});
