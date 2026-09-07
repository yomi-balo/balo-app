import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, occurrences, type ScannedFile } from './_source-scan';

/**
 * BAL-528 — structural invariant: destructive money actions refuse under an impersonated session,
 * and this is the ONLY mechanism that can stop a FUTURE money action shipping without the guard.
 *
 * `isImpersonating` is always `undefined` today (no impersonation entry point exists — see
 * `lib/auth/impersonation.ts`'s docblock), so every unit test in this file set proves only that the
 * code works IF the flag is ever set. Nothing else stops the next money action from being added
 * without the guard — a source scan is the only mechanism that expresses that, which is this
 * ticket's entire purpose.
 *
 * SEVEN assertions:
 *  · I1 — guards the guard (non-vacuity): the scan finds a real surface, `lib/credit/actions.ts`
 *    genuinely calls the guard, and (fix round 1, F3) the two names I3 pins itself against are
 *    still the real export names in `lib/auth/impersonation.ts` / `lib/actions/expert-checklist.ts`
 *    — not free-floating literals nobody checks.
 *  · I2 — `isImpersonating` is read in EXACTLY the two allowlisted modules (the predicate's own
 *    definition, and the session field declaration it reads). A third file — including a re-derived
 *    `user.isImpersonating === true` — fails, pointing at `isImpersonatedSession`.
 *  · I3 — the exported helper/constant names do not themselves contain the scanned identifier. If
 *    one ever did, every consumer would trip I2 and the "fix" would be to gut this invariant — the
 *    same near-miss the `AUTH_HELPERS`-substring test in `onboarding-mutation-gate.test.ts` pins.
 *    (Fix round 1, F3: asserted against `PREDICATE_FUNCTION` / `REFUSAL_CONSTANT`, which I1 ties to
 *    the real source — a rename that isn't mirrored into those consts now fails I1 first, so I3
 *    cannot go stale and pass vacuously.)
 *  · I4 — the READ exemption literal (`billing_read_permitted_under_impersonation`) lives in
 *    exactly two files: its type declaration, and the one gate that has reads.
 *  · I5 — the exemption occurs EXACTLY TWICE in `lib/credit/actions.ts` — the two documented READS,
 *    no more. A third occurrence means a mutation has quietly been excused.
 *  · I6 — every `'use server'` module under `app/(dashboard)/redeem/_actions/` references the
 *    guard, asserted as an exact set in BOTH directions, so a third redeem action cannot land
 *    ungated and a guarded entry cannot be silently pruned while the file still exists.
 *  · I7 — (fix round 1, F2/F5) every exported action in `lib/credit/actions.ts` either calls
 *    `requireBillingActor()` naming itself, or is named in `CHOKEPOINT_BYPASS` with a written
 *    reason — asserted as an exact set, both directions, over the file's own
 *    `export async function` names. Before this assertion existed, the ONLY thing I1 checked about
 *    `lib/credit/actions.ts` was that the guard function's NAME appeared somewhere in the file —
 *    true the moment ONE caller used it, so a tenth action copying `nudgeBillingAdminAction`'s
 *    documented-bypass shape (direct `requireOnboardedUser()`, no `requireBillingActor()`) shipped
 *    invisibly to every other assertion here. I7 closes that: it is the assertion that actually
 *    covers the chokepoint the docblock below claims to. (Fix round 2: the "every exported action"
 *    claim is true only because I7 also form-pins it — an `export ` occurrence count that must
 *    equal `export type ` plus the async-function exports the walk above already covers, so a third
 *    export form (e.g. `export const foo = async () => {}`), invisible to that walk, fails here
 *    instead of shipping ungated and unseen.)
 *
 * ⚠ A REPO-WIDE "every money action carries this guard" scan is DEFERRED, NOT IMPOSSIBLE. The
 * blocker is the same one `onboarding-mutation-gate.test.ts:217-238` documents: ~35 shipped actions
 * (the `engagements/[id]/_actions/*` and `projects/[requestId]/_actions/*` families, and others)
 * authenticate through PER-FEATURE WRAPPERS that a fixed name/literal scan cannot see through, so a
 * repo-wide version today would either miss them or require allowlisting all ~35 — a
 * "justification" nobody reads (the failure mode `_read-only-actions.ts` records). The prerequisite
 * for widening is resolving that indirection — import-following, or a wrapper-name list — not
 * growing an allowlist. **Growing an allowlist instead of resolving the indirection is the one move
 * that must not happen.** This invariant is therefore scoped to the two surfaces this ticket
 * actually touches: EVERY export of `lib/credit/actions.ts` (I7, exact set, not just "the guard
 * function's name appears somewhere"), and the two ungated redeem mutations (I6) — exactly like
 * `onboarding-mutation-gate.test.ts` scopes its anonymous-action half to `app/join/`. Neither I7 nor
 * I6 needs import-following: every gated action in both surfaces calls its gate directly, by name.
 *
 * NO REGEX ANYWHERE, per this directory's S5852 convention — `indexOf`/`includes`/`startsWith`
 * only.
 */

const GUARD_FUNCTION = 'refuseMoneyActionUnderImpersonation';
const IMPERSONATION_FIELD = 'isImpersonating';
const READ_EXEMPTION_LITERAL = 'billing_read_permitted_under_impersonation';
// F3 (fix round 1) — tethered to reality by I1's `export function ${PREDICATE_FUNCTION}` /
// `export const ${REFUSAL_CONSTANT}` checks, so a rename that forgets to update these two consts
// fails I1 loudly instead of leaving I3 asserting a stale literal.
const PREDICATE_FUNCTION = 'isImpersonatedSession';
const REFUSAL_CONSTANT = 'IMPERSONATION_REFUSAL_MESSAGE';

const IMPERSONATION_MODULE = 'lib/auth/impersonation.ts';
const SESSION_MODULE = 'lib/auth/session.ts';
const ACTIONS_FILE = 'lib/credit/actions.ts';
const EXPERT_CHECKLIST_FILE = 'lib/actions/expert-checklist.ts';
const REDEEM_ACTIONS_DIR = 'app/(dashboard)/redeem/_actions';

/**
 * The one export in `lib/credit/actions.ts` deliberately NOT routed through `requireBillingActor()`
 * — `nudgeBillingAdminAction` publishes a notification to the company's own billing holders; it
 * moves no money and changes no payment instrument (see that action's own comment, `actions.ts`
 * immediately above its `requireOnboardedUser()` call). Any OTHER export appearing in
 * `lib/credit/actions.ts` that is neither gated nor named here is I7's failure — a new bypass must
 * be a deliberate, reviewed edit to this constant, never silent.
 */
const CHOKEPOINT_BYPASS: readonly string[] = ['nudgeBillingAdminAction'];

/** A source-text identifier character — ASCII letters, digits, underscore. No regex (S5852). */
function isNameChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}

/** Blank/newline/tab — the characters this file's indexOf walks skip between a call's `(` and its first argument. */
function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/**
 * Every `<name>` in `export async function <name>(` — an indexOf walk, no regex. Matches ONLY a
 * function DECLARATION (the marker requires the literal `function` keyword), so it cannot pick up
 * a call site like `requireBillingActor(...)`.
 */
function exportedAsyncFunctionNamesOf(code: string): string[] {
  const marker = 'export async function ';
  const names: string[] = [];
  let i = code.indexOf(marker);
  while (i !== -1) {
    const start = i + marker.length;
    let end = start;
    while (end < code.length && isNameChar(code.charAt(end))) end += 1;
    names.push(code.slice(start, end));
    i = code.indexOf(marker, end);
  }
  return names;
}

/**
 * Every `<name>` passed as the first, string-literal argument to a `requireBillingActor(` CALL —
 * never the function's own declaration (`async function requireBillingActor(caller: …`, whose
 * first non-blank character after the paren is an identifier, not a quote). Tolerates both this
 * file's single-line calls (`requireBillingActor('startPurchaseAction')`) and its
 * prettier-wrapped multi-line ones (`requireBillingActor(\n  'getTopUpCreditStatusAction',\n  …`).
 */
function requireBillingActorCallerNamesOf(code: string): string[] {
  const marker = 'requireBillingActor(';
  const names: string[] = [];
  let i = code.indexOf(marker);
  while (i !== -1) {
    let j = i + marker.length;
    while (j < code.length && isBlank(code.charAt(j))) j += 1;
    if (code.charAt(j) === "'") {
      const start = j + 1;
      const end = code.indexOf("'", start);
      if (end !== -1) names.push(code.slice(start, end));
    }
    i = code.indexOf(marker, i + marker.length);
  }
  return names;
}

// `resolveRouteDir` covers BOTH cwds this suite can run from (memory `web_server_disk_asset_cwd`):
// a developer's `apps/web` (the first candidate) and CI's repo root (the second).
const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);

function scanAll(): ScannedFile[] {
  return scanRouteSources(SRC_DIR, '', ['node_modules', '.next', '__snapshots__']);
}

describe('BAL-528 — destructive money actions refuse under an impersonated session', () => {
  it('I1 — guards the guard: the scan root resolves, finds a real surface, and lib/credit/actions.ts genuinely calls the guard (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');

    const files = scanAll();
    // apps/web/src holds ~1271 non-test .ts/.tsx files today — a real floor, not a token one.
    expect(files.length).toBeGreaterThan(500);

    const actionsFile = files.find((f) => f.rel === ACTIONS_FILE);
    expect(actionsFile).toBeDefined();
    expect(actionsFile?.code.includes(GUARD_FUNCTION)).toBe(true);

    // F3 (fix round 1) — I3's literals are useless unless something ties them to the real source.
    // If `isImpersonatedSession` or `IMPERSONATION_REFUSAL_MESSAGE` is ever renamed without
    // updating PREDICATE_FUNCTION / REFUSAL_CONSTANT here, THIS assertion fails first — before I3
    // gets a chance to keep passing against a name nothing exports any more.
    const impersonationModule = files.find((f) => f.rel === IMPERSONATION_MODULE);
    expect(impersonationModule).toBeDefined();
    expect(impersonationModule?.code.includes(`export function ${PREDICATE_FUNCTION}`)).toBe(true);
    expect(impersonationModule?.code.includes(`export const ${REFUSAL_CONSTANT}`)).toBe(true);

    const expertChecklistFile = files.find((f) => f.rel === EXPERT_CHECKLIST_FILE);
    expect(expertChecklistFile).toBeDefined();
    expect(expertChecklistFile?.code.includes(PREDICATE_FUNCTION)).toBe(true);
  });

  it('I2 — isImpersonating is read in EXACTLY the two allowlisted modules', () => {
    const rels = scanAll()
      .filter((f) => f.code.includes(IMPERSONATION_FIELD))
      .map((f) => f.rel)
      .sort();

    expect(
      rels,
      `A file outside [${IMPERSONATION_MODULE}, ${SESSION_MODULE}] reads "${IMPERSONATION_FIELD}" ` +
        `directly. Route it through isImpersonatedSession() in ${IMPERSONATION_MODULE} instead — ` +
        `that module's docblock is "THE ONE DEFINITION of impersonated", and re-deriving the check ` +
        `elsewhere (e.g. \`user.isImpersonating === true\`) is exactly what this invariant exists ` +
        `to catch:\n  ${rels.join('\n  ')}`
    ).toEqual([IMPERSONATION_MODULE, SESSION_MODULE].sort());
  });

  it('I3 — ⚠ the exported names do not themselves contain the scanned identifier — load-bearing, not decoration', () => {
    // If any of these ever contained "isImpersonating", every consumer of it would trip I2, and
    // the "fix" would be to gut this invariant instead of the near-miss it caught. Same class of
    // trap the `AUTH_HELPERS`-substring test in `onboarding-mutation-gate.test.ts` pins.
    //
    // F3 (fix round 1) — asserted against PREDICATE_FUNCTION / REFUSAL_CONSTANT, not bare
    // literals: I1 already proved those consts equal the REAL exported names, so a rename that
    // updates the source but not these consts fails I1 first, and this assertion can never go
    // vacuous the way two bare string literals could.
    expect(PREDICATE_FUNCTION.includes(IMPERSONATION_FIELD)).toBe(false);
    expect(GUARD_FUNCTION.includes(IMPERSONATION_FIELD)).toBe(false);
    expect(REFUSAL_CONSTANT.includes(IMPERSONATION_FIELD)).toBe(false);
  });

  it('I4 — the READ exemption literal lives in exactly two files: its type declaration and the one gate that has reads', () => {
    const rels = scanAll()
      .filter((f) => f.code.includes(READ_EXEMPTION_LITERAL))
      .map((f) => f.rel)
      .sort();

    expect(rels).toEqual([IMPERSONATION_MODULE, ACTIONS_FILE].sort());
  });

  it('I5 — the exemption occurs EXACTLY TWICE in lib/credit/actions.ts — the two documented READS, no more', () => {
    const actionsFile = scanAll().find((f) => f.rel === ACTIONS_FILE);
    if (actionsFile === undefined) {
      throw new Error(`${ACTIONS_FILE} not found by the scan — see the I1 non-vacuity test`);
    }
    expect(
      occurrences(actionsFile.code, READ_EXEMPTION_LITERAL),
      'A third occurrence means a mutation has quietly been excused from the refusal default.'
    ).toBe(2);
  });

  it('I6 — every use-server module under redeem/_actions/ references the guard, in BOTH directions', () => {
    const redeemFiles = scanAll().filter((f) => f.rel.startsWith(`${REDEEM_ACTIONS_DIR}/`));
    // Non-vacuity: redeem-promo.ts and start-continue-to-mandate.ts, at minimum.
    expect(redeemFiles.length).toBeGreaterThanOrEqual(2);

    const serverActionFiles = redeemFiles.filter((f) => f.raw.includes("'use server'"));
    expect(serverActionFiles.length).toBeGreaterThanOrEqual(2);

    const unguarded = serverActionFiles
      .filter((f) => !f.code.includes(GUARD_FUNCTION))
      .map((f) => f.rel);
    expect(
      unguarded,
      `These 'use server' modules under ${REDEEM_ACTIONS_DIR}/ never call ${GUARD_FUNCTION} — a ` +
        `redeem money action can land ungated:\n  ${unguarded.join('\n  ')}`
    ).toEqual([]);

    const guardedButNotExpected = serverActionFiles
      .filter((f) => f.code.includes(GUARD_FUNCTION))
      .map((f) => f.rel.slice(REDEEM_ACTIONS_DIR.length + 1))
      .filter((rel) => rel !== 'redeem-promo.ts' && rel !== 'start-continue-to-mandate.ts');
    expect(
      guardedButNotExpected,
      "A new guarded redeem action appeared — update this invariant's expected file list " +
        'deliberately rather than letting it grow silently.'
    ).toEqual([]);
  });

  it('I7 — every exported action in lib/credit/actions.ts either calls requireBillingActor() by name or is named in CHOKEPOINT_BYPASS', () => {
    const actionsFile = scanAll().find((f) => f.rel === ACTIONS_FILE);
    if (actionsFile === undefined) {
      throw new Error(`${ACTIONS_FILE} not found by the scan — see the I1 non-vacuity test`);
    }

    const exported = exportedAsyncFunctionNamesOf(actionsFile.code).sort();
    const gated = requireBillingActorCallerNamesOf(actionsFile.code);
    // Non-vacuity: today's file has 8 gated callers, not 0 — a broken walk that found none would
    // make `expected` collapse to just CHOKEPOINT_BYPASS and this assertion would still (rightly)
    // fail against the real 9 exports, but pin the walk itself so a silent regression is loud here.
    expect(gated.length).toBeGreaterThan(0);
    const expected = [...gated, ...CHOKEPOINT_BYPASS].sort();

    // Form-pin: I7's coverage claim ("every exported action") holds only because every export in
    // this file today is either `export type ` or `export async function ` — the only form
    // exportedAsyncFunctionNamesOf() can see. If a THIRD export form ever lands (e.g. `export const
    // foo = async () => {}`), it is invisible to `exported` above and could ship with no
    // impersonation guard, undetected by the assertion below. This fails the moment `export `
    // occurrences stop being fully accounted for by `export type ` plus the async-function exports
    // this test already walks.
    expect(
      occurrences(actionsFile.code, 'export '),
      'actions.ts grew an export that is neither `export type` nor `export async function` — ' +
        'widen exportedAsyncFunctionNamesOf() first, or I7 cannot see it.'
    ).toBe(occurrences(actionsFile.code, 'export type ') + exported.length);

    expect(
      exported,
      `lib/credit/actions.ts exports an action that neither calls requireBillingActor() by name ` +
        `nor is named in CHOKEPOINT_BYPASS — it can ship with NO impersonation guard at all. ` +
        `Route it through requireBillingActor(), or add it to CHOKEPOINT_BYPASS with a written ` +
        `reason (it must move no money and change no payment instrument).\n` +
        `  exported: [${exported.join(', ')}]\n` +
        `  expected (gated + bypass): [${expected.join(', ')}]`
    ).toEqual(expected);
  });
});
