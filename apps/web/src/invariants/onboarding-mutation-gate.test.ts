import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_ACTION_ALLOWLIST, READ_ONLY_ALLOWLIST } from './_read-only-actions';
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

/**
 * BAL-132 — every primitive through which a Server Action can learn WHO IS CALLING.
 *
 * ⚠⚠ A MODULE MENTIONING **NONE** OF THESE NEVER LOOKS AT ITS CALLER AT ALL, AND THAT IS THE
 * CASE THE `bareRequireUser` SCAN CANNOT SEE. That scan asks "does this action use the WEAK
 * gate?"; a module using NO gate never enters its set, so it passes in silence. BAL-132 shipped
 * the platform's first two deliberately unauthenticated mutating actions, and nothing would
 * have stopped a THIRD, accidental one landing beside them.
 *
 * ⚠ THE LIST IS WIDER THAN THE THREE GATE HELPERS, AND IT HAS TO BE. A large, entirely
 * legitimate set of shipped actions authenticates via `getSession()` / `getCurrentUser()`
 * instead — the whole `lib/auth/actions/*` onboarding family, the credit readers, and others.
 * Scanning for the gate helpers alone would flag ~15 correctly-authenticated modules, and an
 * allowlist that large stops being a claim anybody reads. What this set actually asserts is
 * narrow and checkable: **this module reads its caller's identity SOMEWHERE.** Whether it reads
 * it through the RIGHT gate is the job of the `bareRequireUser` assertions above; the two
 * checks are complementary, not redundant.
 *
 * ⚠⚠ **`requireOnboardedUser` IS NOT REDUNDANT WITH `requireUser`, AND AN EARLIER VERSION OF
 * THIS COMMENT CLAIMED IT WAS.** The claim was that "`requireOnboardedUser` and
 * `requireExpertUser` both contain `requireUser`, so any of them counts". They do not:
 * `'requireOnboardedUser'.includes('requireUser')` is **false** — the name is
 * `require` + `Onboarded` + `User`, so the eleven characters `requireUser` never occur
 * contiguously. Same for `requireExpertUser`.
 *
 * This is not a pedantic correction. Acting on that comment and deleting the entry makes
 * `app/join/_actions/join-as-member.ts` — whose ONLY auth reference is `requireOnboardedUser()`
 * — register as UNAUTHENTICATED, and the join-surface assertion below fails demanding it be
 * added to `PUBLIC_ACTION_ALLOWLIST`. Which is to say: the invariant would have been "fixed" by
 * allowlisting a correctly-gated action as public. The failing test is the only reason that did
 * not ship, so the entry stays and the false rationale is what goes.
 *
 * ⚠ SUBSTRING MATCHING IS STILL THE MECHANISM (`source.includes(helper)`) — it is just not a
 * shortcut that lets one gate name stand in for another. **Every helper a module might use
 * must appear here in full.**
 *
 * ⚠⚠ `authorizeCaseMutation` IS THE FIRST **PER-FEATURE WRAPPER** ADMITTED TO THIS LIST, AND
 * THAT IS THE REMEDY THE NOTE BELOW PRESCRIBES BY NAME ("add the wrapper names to
 * `AUTH_HELPERS`"). BAL-421's three case-surface mutations (`resolve-case.ts`,
 * `request-resolution.ts`, `dismiss-resolution-request.ts`) authenticate ONLY through it — it
 * calls `requireOnboardedUser()` as its first statement and re-runs the full tenancy gate — so
 * without this entry all three registered as UNAUTHENTICATED and passed in silence, and
 * deleting their gate call would have shipped green.
 *
 * ⚠⚠ `performGuestInvite` (BAL-573) — the ONE gate for both guest-invite entry points. It calls
 * `requireOnboardedUser()` as its first statement; without this entry both `'use server'`
 * wrappers (`invite-meeting-guests.ts`, `invite-consultation-guests.ts`) register as
 * UNAUTHENTICATED and pass in silence, and deleting the gate call would ship green.
 */
/**
 * ⚠⚠ `resolveMeetingGuestSubject` (BAL-445) — the second entry added for a reason OTHER than
 * "a per-feature wrapper around `requireOnboardedUser()`". It resolves a presented credential
 * to a **persisted, revocable subject** and fails closed — the same shape as `getSession()` /
 * `getCurrentUser()` (both already above): a primitive through which an action learns *who is
 * calling*. The subject is a `meeting_guests` row a host can revoke, that expires, and that
 * the database re-validates on every single request. `PUBLIC_ACTION_ALLOWLIST` is for actions
 * that authenticate with **nothing at all** and forward the real gate elsewhere; the three
 * guest read actions authenticate HERE, so putting them there would silently reclassify an
 * authorized read as public — precisely the failure mode `_read-only-actions.ts` warns about.
 */
const AUTH_HELPERS = [
  'requireUser',
  'requireOnboardedUser',
  'withAuth',
  'getSession',
  'getCurrentUser',
  'authorizeCaseMutation',
  'resolveMeetingGuestSubject',
  'performGuestInvite',
] as const;

interface ServerActionScan {
  readonly scanned: string[];
  readonly bareRequireUser: string[];
  /** `'use server'` modules that reference NO auth helper whatsoever. */
  readonly unauthenticated: string[];
}

function scanServerActions(): ServerActionScan {
  const scanned: string[] = [];
  const bareRequireUser: string[] = [];
  const unauthenticated: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const raw = readFileSync(file, 'utf8');
    if (!USE_SERVER.test(raw)) continue;
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    scanned.push(rel);
    const source = stripComments(raw);
    if (BARE_REQUIRE_USER_CALL.test(source)) {
      bareRequireUser.push(rel);
    }
    // ⚠ COMMENT-STRIPPED, like the scan above — every one of these modules DISCUSSES the gate
    // at length in its docblock, so an un-stripped search would find all of them and the
    // invariant would be vacuous in the most misleading possible way.
    if (!AUTH_HELPERS.some((helper) => source.includes(helper))) {
      unauthenticated.push(rel);
    }
  }
  return { scanned, bareRequireUser, unauthenticated };
}

describe('onboarding mutation gate (BAL-365)', () => {
  const { scanned, bareRequireUser, unauthenticated } = scanServerActions();

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

  /**
   * ── ⚠⚠ BAL-132 — THE OTHER HALF OF THE INVARIANT, SCOPED TO THE JOIN SURFACE ────────────
   *
   * Everything above asks "does this action use the WEAK gate?", which makes it **structurally
   * blind to an action using NO gate**: such a module never enters the `bareRequireUser` set,
   * so it passes in silence. BAL-132 shipped the platform's first two deliberately
   * unauthenticated mutating Server Actions, and their docblocks correctly noted they passed
   * the invariant — but passing it was not evidence of anything, and nothing stopped a THIRD,
   * accidentally unauthenticated action landing beside them and passing just as quietly.
   *
   * ── ⚠⚠ BAL-568 — THE PREREQUISITE THIS NOTE DEFERRED IS **DONE**, AND THE REPO-WIDE
   *    PROPERTY NOW SHIPS IN ITS OWN FILE ────────────────────────────────────────────────────
   *
   * This note used to say a repo-wide version was DEFERRED because shipped actions authenticate
   * through PER-FEATURE WRAPPERS (`engagement-lifecycle-shared`, `milestone-action-shared`,
   * `_shared/require-request-staff-capability`, and friends) that a fixed helper-name list cannot
   * see through — and it named the prerequisite: resolve the wrapper indirection by FOLLOWING
   * IMPORTS. BAL-568 did exactly that. `_action-auth-scan.ts` resolves relative and `@/`-aliased
   * specifiers on disk and classifies each `'use server'` module at depth 0 (own source), 1 (one
   * import hop) or 2 (one further RE-EXPORT hop); `account-liveness-gate.test.ts` asserts the
   * resulting property REPO-WIDE, against a 12-entry allowlist rather than the ~35 this note
   * warned about — so the forbidden move was avoided, not taken.
   *
   * Re-measured 2026-09-19 after merging `origin/main`, superseding this note's estimate: **184**
   * `'use server'` modules — 141 resolve at depth 0, **26 at one import hop**, **5 at two** (the
   * `accept-project.ts` → `engagement-lifecycle-shared.ts` → `milestone-action-shared.ts` chain,
   * which is what makes one level provably insufficient), 12 unresolved and allowlisted. That
   * property is STRICTLY STRONGER than this file's: it asserts each module reaches a seam that
   * re-reads the LIVE ROW, which a fortiori reads the caller at all.
   *
   * ⚠ WHAT THE REPO-WIDE ASSERTION ACTUALLY DID WHEN BAL-442 LANDED — corrected 2026-09-19 (fix
   * round 3, H5), because the previous wording here credited it with something THIS file did.
   * BAL-442 added `app/join/_actions/request-lobby-reentry-link.ts`, a third deliberately
   * unauthenticated join action, and wrote its entry and reason onto `PUBLIC_ACTION_ALLOWLIST` in
   * the same PR — it had to, because the exact set equality BELOW already demanded one for any new
   * `app/join/` action. So the written reason was never in question: what went red in CI on the
   * merge commit was `account-liveness-gate.test.ts` B7's PINNED COUNT of 11, which had to be
   * re-measured to 12. The reason-enforcing property is this file's, over `app/join/`; the
   * repo-wide file extends the same shape past that surface, and its count is what noticed the
   * arrival.
   *
   * ── ⚠ WHY THIS ASSERTION STAYS, AND STAYS SCOPED TO `app/join/` ─────────────────────────
   *
   * It answers the NARROWER BAL-132 question over the one surface that actually has an anonymous
   * arm, and it is what keeps `PUBLIC_ACTION_ALLOWLIST` honest — that list is REUSED (never
   * duplicated) by the repo-wide invariant, which asserts the two allowlists are disjoint and
   * that their union equals the unresolved set exactly. **Deleting the scope filter here and
   * growing this list is still the one move that must not happen.**
   *
   * It asserts EXACT SET EQUALITY in both directions, so the anonymous surface can only grow by
   * a deliberate edit to `PUBLIC_ACTION_ALLOWLIST`, which carries the written justification.
   */
  const JOIN_SURFACE = 'app/join/';
  const joinActions = scanned.filter((f) => f.startsWith(JOIN_SURFACE));
  const unauthenticatedJoinActions = unauthenticated.filter((f) => f.startsWith(JOIN_SURFACE));

  it('scans the join surface (guards against a vacuous pass)', () => {
    // `claim-lobby-place`, `poll-guest-admission`, `join-as-member` — at minimum.
    expect(joinActions.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⚠⚠ NO ENTRY IN `AUTH_HELPERS` IS COVERED BY ANOTHER — pinned, because a comment claiming
   * otherwise nearly cost a real gate.
   *
   * That comment said `requireOnboardedUser` "contains `requireUser`, so any of them counts",
   * and two independent reviews repeated it. It is false: the name is `require` + `Onboarded` +
   * `User`, so the eleven characters `requireUser` never occur contiguously. Deleting the entry
   * on that reasoning makes `join-as-member.ts` — correctly gated, and gated with nothing else
   * — look UNAUTHENTICATED, and the natural "fix" is to allowlist it as public.
   *
   * This asserts the property the comment got wrong, so the next person to reach for the same
   * simplification is told by a test rather than by a comment.
   */
  it('⚠ every AUTH_HELPERS entry is load-bearing — none is a substring of another', () => {
    for (const helper of AUTH_HELPERS) {
      const covered = AUTH_HELPERS.filter((other) => other !== helper && other.includes(helper));
      expect(covered, `${helper} is a substring of ${covered.join(', ')}`).toEqual([]);
    }
    // Non-vacuity, and the specific pair that was wrongly claimed to be redundant.
    // `not.toContain` rather than `.includes(…)).toBe(false)`: on failure the dedicated
    // matcher reports WHICH string contained WHAT, instead of "expected true to be false".
    expect('requireOnboardedUser').not.toContain('requireUser');
    expect(AUTH_HELPERS).toContain('requireOnboardedUser');
  });

  it('⚠ only the ALLOWLISTED join actions are unauthenticated', () => {
    const unexpected = unauthenticatedJoinActions.filter(
      (f) => !PUBLIC_ACTION_ALLOWLIST.includes(f)
    );
    expect(
      unexpected,
      `These 'use server' actions under ${JOIN_SURFACE} reference NO auth or session helper at ` +
        `all, so they are callable by anyone on the internet. Gate each with ` +
        `requireOnboardedUser() — or, if it is genuinely meant to be public, add it to ` +
        `PUBLIC_ACTION_ALLOWLIST naming where the real server-side authorization lives and ` +
        `what bounds abuse:\n  ${unexpected.join('\n  ')}`
    ).toEqual([]);
  });

  it('the public-action allowlist has no stale entries', () => {
    const stale = PUBLIC_ACTION_ALLOWLIST.filter((f) => !unauthenticated.includes(f));
    expect(
      stale,
      `These allowlisted files are no longer unauthenticated (gated, or removed). Prune them ` +
        `from PUBLIC_ACTION_ALLOWLIST:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });
});
