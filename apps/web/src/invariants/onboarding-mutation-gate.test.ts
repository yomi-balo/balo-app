import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BAL-365 — structural invariant for the Server-Action onboarding gate.
 *
 * The nav-boundary gate (BAL-361) is not an authorization boundary; privileged
 * mutations must fail closed on `onboardingCompleted` at the Server-Action layer.
 * That is enforced by two guards:
 *   - `withAuth(fn)`            — gates by default (opt out only for onboarding-flow
 *                                 actions via `{ allowUnonboarded: true }`)
 *   - `requireOnboardedUser()`  — the fail-closed sibling of `requireUser()` for
 *                                 actions that read the session directly
 *
 * `requireUser()` itself is NOT fail-closed (reads/layouts legitimately run
 * pre-onboarding), so a Server Action that authenticates via bare `requireUser()`
 * is a hole: an un-onboarded session can mutate through it. This test mechanically
 * proves NO `'use server'` module calls bare `requireUser()` except the explicitly
 * allowlisted READ-ONLY actions below — which doubles as the completeness proof for
 * the migration sweep and fails CI the moment a new action reopens the gap.
 *
 * If this test fails on a NEW action:
 *   - it performs a WRITE / side-effect  → migrate it to `requireOnboardedUser()`
 *     (or wrap it in `withAuth` without the opt-out).
 *   - it is genuinely READ-ONLY and safe to run pre-onboarding → add it to
 *     READ_ONLY_ALLOWLIST below with a one-line justification.
 * "reads don't gate; privileged mutations do" is the durable rule this encodes.
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

/**
 * Server Actions that read the session via bare `requireUser()` and are allowed to,
 * because they perform NO writes/side-effects and stay IDOR-guarded independently of
 * onboarding. Paths are relative to `apps/web/src`, POSIX separators.
 */
const READ_ONLY_ALLOWLIST: readonly string[] = [
  // Lists conversation messages/files — pure read.
  'app/(dashboard)/projects/[requestId]/_actions/fetch-thread.ts',
  // Mints a short-lived presigned GET URL for a conversation file — no mutation.
  'app/(dashboard)/projects/[requestId]/_actions/get-conversation-file-download.ts',
  // Mints a short-lived presigned GET URL for a proposal document — no mutation.
  'app/(dashboard)/projects/[requestId]/_actions/get-proposal-document-download.ts',
];

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

/** Strip block + line comments so `requireUser()` mentions in JSDoc/comments don't count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const USE_SERVER = /^\s*['"]use server['"]/;
// Matches a real call to `requireUser(` — the `\b` boundary excludes
// `requireOnboardedUser(` / `requireExpertUser(` / `getCurrentUser(` (none contain
// the substring "requireUser") and method calls are excluded by the boundary too.
const BARE_REQUIRE_USER_CALL = /\brequireUser\s*\(/;

interface ServerActionScan {
  readonly scanned: string[];
  readonly bareRequireUser: string[];
}

function scanServerActions(): ServerActionScan {
  const scanned: string[] = [];
  const bareRequireUser: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const raw = readFileSync(file, 'utf8');
    if (!USE_SERVER.test(raw)) continue;
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    scanned.push(rel);
    if (BARE_REQUIRE_USER_CALL.test(stripComments(raw))) {
      bareRequireUser.push(rel);
    }
  }
  return { scanned, bareRequireUser };
}

describe('onboarding mutation gate (BAL-365)', () => {
  const { scanned, bareRequireUser } = scanServerActions();

  // Non-vacuity guard: if the walk silently finds nothing, every assertion below
  // passes for the wrong reason. The app has ~96 'use server' modules.
  it('scans the full Server-Action surface (guards against a vacuous pass)', () => {
    expect(scanned.length).toBeGreaterThan(80);
  });

  // Detection guard: the regex/comment-stripping must actually find the known
  // real callers. If this breaks, the invariant below could false-green.
  it('detects real bare requireUser() calls (guards against a dead matcher)', () => {
    for (const allowed of READ_ONLY_ALLOWLIST) {
      expect(bareRequireUser).toContain(allowed);
    }
  });

  it('no privileged mutation authenticates via bare requireUser()', () => {
    const violations = bareRequireUser.filter((f) => !READ_ONLY_ALLOWLIST.includes(f));
    expect(
      violations,
      `These 'use server' actions call bare requireUser(), leaving them ungated for ` +
        `un-onboarded sessions. Migrate each to requireOnboardedUser() (or withAuth ` +
        `without allowUnonboarded), or — if genuinely read-only and safe pre-onboarding ` +
        `— add it to READ_ONLY_ALLOWLIST with justification:\n  ${violations.join('\n  ')}`
    ).toEqual([]);
  });

  it('the read-only allowlist has no stale entries', () => {
    const stale = READ_ONLY_ALLOWLIST.filter((f) => !bareRequireUser.includes(f));
    expect(
      stale,
      `These allowlisted files no longer call bare requireUser() (migrated or removed). ` +
        `Prune them from READ_ONLY_ALLOWLIST:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });
});
