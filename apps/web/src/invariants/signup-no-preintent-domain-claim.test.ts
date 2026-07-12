import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BAL-368 / ADR-1038 (S1) — structural invariant for "Organizations by Default".
 *
 * The epic's invariant is **type → instantiate → claim**. Signup only *types* the
 * domain (corporate vs freemail) and records it via analytics; it must NOT create an
 * org and must NOT claim a `party_domains` row. The typed org and its domain claim
 * are deferred to the onboarding **Intent** step (S2 / BAL-369).
 *
 * This test is a mechanical tripwire that the **web signup path** never (re-)introduces
 * a pre-Intent `party_domains` claim. It scans the four signup seams + their shared
 * post-commit helper and fails the moment any of them references a claim.
 *
 * Scan set (web signup path only):
 *   - `lib/domain-join/**`                — the post-commit helper + match resolvers
 *   - `lib/auth/actions/**`               — password sign-up / sign-in / OTP verify seams
 *   - `app/api/auth/callback/route.ts`    — the OAuth callback seam
 *
 * A `party_domains` READ (`partyDomainsRepository.findActiveByDomain(...)`, used by the
 * match engine and the onboarding company resolver) is explicitly ALLOWED — only a
 * *claim* (`.capture(` / `.claim(` / `insert(partyDomains`) is forbidden.
 *
 * Why the sanctioned BAL-344 capture does NOT trip this: the single, DB-layer capture
 * lives in `packages/db/src/repositories/users.ts::createWithWorkspace` (guarded by
 * DB-layer tests), which is OUTSIDE this web-layer scan set — intentionally so. It is
 * S2/BAL-369's job to relocate that capture to the Intent step (also outside this
 * scan set). This invariant governs only that the web signup **seams** stay claim-free.
 *
 * SCOPE — this asserts the WEB seams add no claim; it does NOT (and in S1 cannot)
 * assert the DB-layer `createWithWorkspace` is claim-free, because that capture is
 * still present-by-design in S1. The epic's full "signup writes no `party_domains`"
 * guarantee is two-layered: S2 must land the DB-layer counterpart (a standing invariant
 * that `createWithWorkspace` no longer captures) when it relocates the claim to Intent.
 *
 * If this test fails on a NEW claim in a scanned file: you added a pre-Intent domain
 * claim to the signup path. Move it to the onboarding Intent action (S2) instead —
 * signup classifies, Intent claims.
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

/** The web signup path: two directories walked recursively + one explicit seam file. */
const SCAN_DIRS: readonly string[] = ['lib/domain-join', 'lib/auth/actions'];
const SCAN_FILES: readonly string[] = ['app/api/auth/callback/route.ts'];

/** Recursively collect non-test .ts/.tsx files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** Strip block + line comments so claim mentions in JSDoc/comments don't count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * A `party_domains` CLAIM (write), whitespace-tolerant. Reads via `findActiveByDomain`
 * are deliberately NOT matched. All quantifiers are simple `\s*` over a char class —
 * no nested/overlapping quantifiers (SonarCloud S5852-safe).
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bpartyDomainsRepository\s*\.\s*capture\s*\(/,
  /\bpartyDomainsRepository\s*\.\s*claim\s*\(/,
  /\binsert\s*\(\s*partyDomains\b/,
];

interface ClaimScan {
  readonly scanned: string[];
  readonly claimers: string[];
}

function scanSignupPath(): ClaimScan {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(SRC_DIR, dir);
    if (existsSync(abs)) files.push(...collectSourceFiles(abs));
  }
  for (const file of SCAN_FILES) {
    const abs = path.join(SRC_DIR, file);
    if (existsSync(abs)) files.push(abs);
  }

  const scanned: string[] = [];
  const claimers: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    scanned.push(rel);
    const stripped = stripComments(readFileSync(file, 'utf8'));
    if (CLAIM_PATTERNS.some((re) => re.test(stripped))) {
      claimers.push(rel);
    }
  }
  return { scanned, claimers };
}

describe('web signup seams introduce no pre-Intent party_domains claim (BAL-368 / ADR-1038 S1)', () => {
  const { scanned, claimers } = scanSignupPath();

  // Non-vacuity guard: if the walk silently finds nothing (mis-resolved path), every
  // assertion below passes for the wrong reason. Pin the known seam files.
  const EXPECTED_SEAMS: readonly string[] = [
    'lib/domain-join/run-domain-join.ts',
    'lib/auth/actions/sign-up.ts',
    'lib/auth/actions/sign-in.ts',
    'lib/auth/actions/verify-email.ts',
    'app/api/auth/callback/route.ts',
  ];

  it('collects the known signup seam files (guards against a vacuous pass)', () => {
    for (const seam of EXPECTED_SEAMS) {
      expect(scanned).toContain(seam);
    }
  });

  it('no web signup-seam file claims a party_domains row (claim is deferred to the Intent step)', () => {
    expect(
      claimers,
      `These web signup-path files reference a party_domains CLAIM ` +
        `(.capture( / .claim( / insert(partyDomains), but the claim must be deferred to the ` +
        `onboarding Intent step (S2 / BAL-369). Signup only classifies. Move the claim out of ` +
        `the signup path:\n  ${claimers.join('\n  ')}`
    ).toEqual([]);
  });
});
