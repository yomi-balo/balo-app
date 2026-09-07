import { describe, expect, it } from 'vitest';
import {
  resolveRouteDir,
  scanRouteSources,
  occurrences,
  hasUseServerDirective,
  type ScannedFile,
} from './_source-scan';

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
 *    exactly two FILES: its type declaration, and the one gate that has reads. (A file-level check
 *    only — I5 below is where the WITHIN-FILE location is pinned.)
 *  · I5 — (fix round 3, human pre-merge review) the exemption literal appears in the CALLER
 *    position ONLY inside the OWN body segments of `getTopUpCreditStatusAction` and
 *    `validatePromoAction` — BODY-SCOPED, not a bare whole-file occurrence count. The old version
 *    only asserted the literal occurred exactly twice SOMEWHERE in the file, so moving the
 *    exemption from one of the two documented READ callers onto a MUTATION (e.g.
 *    `saveBillingEmailAction`) left the count at 2 and this assertion green while a mutation was
 *    quietly excused from the refusal default. Naming the exact two callers closes that. The ONE
 *    other legitimate occurrence — the TYPE POSITION in `requireBillingActor`'s second overload
 *    signature (Item B, "belt-and-braces": `impersonationGuard: 'billing_read_permitted_under_
 *    impersonation'`) — lives in the file's PREAMBLE (before the first `export async function`,
 *    i.e. in no export's own body) and is pinned to exactly one occurrence there, so a second
 *    stray mention anywhere outside a segment still fails loudly.
 *  · I6 — every `'use server'` module under `app/(dashboard)/redeem/_actions/` references the
 *    guard, asserted as an exact set in BOTH directions, so a third redeem action cannot land
 *    ungated and a guarded entry cannot be silently pruned while the file still exists. (Fix round
 *    3: the directive detector is now `hasUseServerDirective` from `./_source-scan` — shared with
 *    `use-server-exports-only-async.test.ts`, its first consumer — rather than a bare
 *    `raw.includes("'use server'")`, which missed a double-quoted directive.)
 *  · I7 — (fix round 1, F2/F5; rebuilt fix round 3, human pre-merge review) every exported action in
 *    `lib/credit/actions.ts` either calls `requireBillingActor()` naming ITSELF from within its OWN
 *    body, or is named in `CHOKEPOINT_BYPASS` with a written reason — asserted as an exact,
 *    BODY-SCOPED walk, never a whole-file aggregate. Before fix round 1, the ONLY thing checked
 *    about `lib/credit/actions.ts` was that the guard function's NAME appeared somewhere in the
 *    file — true the moment ONE caller used it. Fix round 1's I7 closed that by comparing the SET
 *    of exported names against the SET of `requireBillingActor('<name>')` literals found ANYWHERE
 *    in the file — better, but still two whole-file aggregates, which leaves two gaps a human
 *    pre-merge review (fix round 3) found: (a) moving the exemption literal from
 *    `validatePromoAction`'s call to a MUTATION's call leaves both aggregate sets identical, so
 *    nothing fails for a newly-unguarded existing action; (b) one function's body calling
 *    `requireBillingActor` TWICE — naming itself AND a sibling — satisfies the aggregate set-
 *    membership check for that sibling even though the sibling's OWN body never calls the gate.
 *    Fix round 3 rebuilds I7 as a walk over PER-EXPORT body segments
 *    (`exportedAsyncFunctionSegmentsOf`): each export from its own `export async function` up to
 *    the next one (or EOF) is sliced out, and only THAT segment's own `requireBillingActor(...)`
 *    calls count toward gating IT. Neither gap above can pass this version.
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
 * actually touches: EVERY export of `lib/credit/actions.ts` (I7, exact BODY-SCOPED set, not just
 * "the guard function's name appears somewhere"), and the two ungated redeem mutations (I6) —
 * exactly like `onboarding-mutation-gate.test.ts` scopes its anonymous-action half to `app/join/`.
 * Neither I7 nor I6 needs import-following: every gated action in both surfaces calls its gate
 * directly, by name, from its own body.
 *
 * ⚠ (fix round 3, human pre-merge review) — `scanRouteSources` runs ONCE, hoisted to a module-scope
 * const (`ALL_FILES`, below), not re-invoked inside each `it` block. It walks ~1,271 files; the
 * previous version paid that cost in six of the seven tests here. Matches the module-scope-const
 * pattern this directory already uses elsewhere (e.g. `join-link-never-writes.test.ts`,
 * `review-link-never-writes.test.ts`, `request-file-no-lens-gate.test.ts`).
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
 * `lib/credit/actions.ts` that is neither gated (from its OWN body) nor named here is I7's failure
 * — a new bypass must be a deliberate, reviewed edit to this constant, never silent.
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

/** One `export async function <name>` declaration, sliced into its OWN body segment. */
interface ExportedFunctionSegment {
  readonly name: string;
  readonly body: string;
}

/**
 * Every `export async function <name>` declaration in `code`, sliced into its OWN body segment —
 * from that declaration's `export` keyword up to (not including) the START of the next
 * `export async function`, or EOF for the last one. An indexOf walk, no regex.
 *
 * ⚠⚠ (fix round 3, human pre-merge review) — REPLACES the whole-file aggregate scan I7 used to
 * run. The aggregate scan asked two SEPARATE questions over the WHOLE FILE — "which names are
 * exported" and "which names appear as a `requireBillingActor('<name>')` literal anywhere" — and
 * then compared the two SETS. A `requireBillingActor('<name>')` call satisfied that check for
 * `<name>` no matter WHERE in the file it appeared — including from inside a DIFFERENT export's
 * body. So one function calling `requireBillingActor` twice, naming itself and a sibling, satisfied
 * the old I7 with the sibling completely ungated. Body-scoping closes that: each export's OWN gate
 * call must be found inside ITS OWN segment, produced here.
 */
function exportedAsyncFunctionSegmentsOf(code: string): ExportedFunctionSegment[] {
  const marker = 'export async function ';
  const starts: { name: string; index: number }[] = [];
  let i = code.indexOf(marker);
  while (i !== -1) {
    const nameStart = i + marker.length;
    let nameEnd = nameStart;
    while (nameEnd < code.length && isNameChar(code.charAt(nameEnd))) nameEnd += 1;
    starts.push({ name: code.slice(nameStart, nameEnd), index: i });
    i = code.indexOf(marker, nameEnd);
  }

  const segments: ExportedFunctionSegment[] = [];
  for (let idx = 0; idx < starts.length; idx += 1) {
    const current = starts[idx];
    if (current === undefined) continue; // noUncheckedIndexedAccess guard; unreachable in-bounds.
    const next = starts[idx + 1];
    const end = next === undefined ? code.length : next.index;
    segments.push({ name: current.name, body: code.slice(current.index, end) });
  }
  return segments;
}

/**
 * Every `<name>` passed as the first, string-literal argument to a `requireBillingActor(` CALL —
 * never the function's own declaration (`async function requireBillingActor(caller: …`, whose
 * first non-blank character after the paren is an identifier, not a quote). Tolerates both this
 * file's single-line calls (`requireBillingActor('startPurchaseAction')`) and its
 * prettier-wrapped multi-line ones (`requireBillingActor(\n  'getTopUpCreditStatusAction',\n  …`).
 *
 * Body-scoped callers (I7) pass a single export's `body` slice here rather than the whole file, so
 * the names returned are only the calls made FROM WITHIN that export's own declaration.
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

describe('BAL-528 — destructive money actions refuse under an impersonated session', () => {
  // (fix round 3, human pre-merge review) — hoisted to run the ~1,271-file walk ONCE for the whole
  // suite, matching this directory's established module-scope-const pattern, rather than
  // re-walking it inside six of the seven `it` blocks below.
  const ALL_FILES: ScannedFile[] = scanRouteSources(SRC_DIR, '', [
    'node_modules',
    '.next',
    '__snapshots__',
  ]);

  it('I1 — guards the guard: the scan root resolves, finds a real surface, and lib/credit/actions.ts genuinely calls the guard (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');

    // apps/web/src holds ~1271 non-test .ts/.tsx files today — a real floor, not a token one.
    expect(ALL_FILES.length).toBeGreaterThan(500);

    const actionsFile = ALL_FILES.find((f) => f.rel === ACTIONS_FILE);
    expect(actionsFile).toBeDefined();
    expect(actionsFile?.code.includes(GUARD_FUNCTION)).toBe(true);

    // F3 (fix round 1) — I3's literals are useless unless something ties them to the real source.
    // If `isImpersonatedSession` or `IMPERSONATION_REFUSAL_MESSAGE` is ever renamed without
    // updating PREDICATE_FUNCTION / REFUSAL_CONSTANT here, THIS assertion fails first — before I3
    // gets a chance to keep passing against a name nothing exports any more.
    const impersonationModule = ALL_FILES.find((f) => f.rel === IMPERSONATION_MODULE);
    expect(impersonationModule).toBeDefined();
    expect(impersonationModule?.code.includes(`export function ${PREDICATE_FUNCTION}`)).toBe(true);
    expect(impersonationModule?.code.includes(`export const ${REFUSAL_CONSTANT}`)).toBe(true);

    const expertChecklistFile = ALL_FILES.find((f) => f.rel === EXPERT_CHECKLIST_FILE);
    expect(expertChecklistFile).toBeDefined();
    expect(expertChecklistFile?.code.includes(PREDICATE_FUNCTION)).toBe(true);
  });

  it('I2 — isImpersonating is read in EXACTLY the two allowlisted modules', () => {
    const rels = ALL_FILES.filter((f) => f.code.includes(IMPERSONATION_FIELD))
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
    const rels = ALL_FILES.filter((f) => f.code.includes(READ_EXEMPTION_LITERAL))
      .map((f) => f.rel)
      .sort();

    expect(rels).toEqual([IMPERSONATION_MODULE, ACTIONS_FILE].sort());
  });

  it('I5 — the READ exemption literal lives ONLY in the bodies of the two documented READ callers (plus the ONE compiler-bound overload signature), and nowhere else in lib/credit/actions.ts', () => {
    const actionsFile = ALL_FILES.find((f) => f.rel === ACTIONS_FILE);
    if (actionsFile === undefined) {
      throw new Error(`${ACTIONS_FILE} not found by the scan — see the I1 non-vacuity test`);
    }

    const segments = exportedAsyncFunctionSegmentsOf(actionsFile.code);
    const segmentsCarryingExemption = segments
      .filter((s) => s.body.includes(READ_EXEMPTION_LITERAL))
      .map((s) => s.name)
      .sort();

    expect(
      segmentsCarryingExemption,
      'The READ exemption literal must live in exactly getTopUpCreditStatusAction and ' +
        'validatePromoAction — a THIRD caller (or the exemption having MOVED onto a different ' +
        'caller entirely, with the aggregate count unchanged) means a mutation has quietly been ' +
        `excused from the refusal default:\n  ${segmentsCarryingExemption.join('\n  ')}`
    ).toEqual(['getTopUpCreditStatusAction', 'validatePromoAction'].sort());

    // The PREAMBLE — everything before the first `export async function` — is where
    // `requireBillingActor`'s own declaration (implementation + Item B's overload signatures)
    // lives. Item B's second overload names the literal in TYPE position
    // (`impersonationGuard: 'billing_read_permitted_under_impersonation'`) so only a
    // `BillingReadCaller` can pass it — that is a legitimate, EXPECTED occurrence, pinned to
    // exactly one, and it is not a call site.
    const firstExportMarker = actionsFile.code.indexOf('export async function ');
    const preamble =
      firstExportMarker === -1 ? actionsFile.code : actionsFile.code.slice(0, firstExportMarker);
    const preambleOccurrences = occurrences(preamble, READ_EXEMPTION_LITERAL);
    expect(
      preambleOccurrences,
      "the exemption literal's shape changed in requireBillingActor's overload signature " +
        '(Item B) — update this pin if that was a deliberate, reviewed edit'
    ).toBe(1);

    const totalInsideSegments = segments.reduce(
      (sum, segment) => sum + occurrences(segment.body, READ_EXEMPTION_LITERAL),
      0
    );
    expect(
      totalInsideSegments,
      'a THIRD occurrence inside an export body means a mutation has quietly been excused from ' +
        'the refusal default'
    ).toBe(2);

    // "Nowhere else in the file": every occurrence in the whole scanned `code` view must be
    // accounted for by the preamble's one pinned overload occurrence PLUS occurrences found
    // strictly INSIDE the per-export body segments above — a stray occurrence sitting anywhere
    // else (a private helper between two exports, a docblock the comment-stripper missed) would
    // otherwise be invisible to the checks above.
    const totalInFile = occurrences(actionsFile.code, READ_EXEMPTION_LITERAL);
    expect(
      totalInFile,
      'the exemption literal appears somewhere that is neither the pinned overload signature ' +
        "nor an export's own body segment"
    ).toBe(preambleOccurrences + totalInsideSegments);
  });

  it('I6 — every use-server module under redeem/_actions/ references the guard, in BOTH directions', () => {
    const redeemFiles = ALL_FILES.filter((f) => f.rel.startsWith(`${REDEEM_ACTIONS_DIR}/`));
    // Non-vacuity: redeem-promo.ts and start-continue-to-mandate.ts, at minimum.
    expect(redeemFiles.length).toBeGreaterThanOrEqual(2);

    // (fix round 3, human pre-merge review) — `hasUseServerDirective` (shared with
    // `use-server-exports-only-async.test.ts` via `./_source-scan`) recognises BOTH quote styles.
    // The previous `f.raw.includes("'use server'")` here only ever matched the single-quoted
    // form.
    const serverActionFiles = redeemFiles.filter((f) => hasUseServerDirective(f.raw));
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

  it('I7 — every exported action in lib/credit/actions.ts calls requireBillingActor() naming ITSELF from within its OWN body, or is named in CHOKEPOINT_BYPASS', () => {
    const actionsFile = ALL_FILES.find((f) => f.rel === ACTIONS_FILE);
    if (actionsFile === undefined) {
      throw new Error(`${ACTIONS_FILE} not found by the scan — see the I1 non-vacuity test`);
    }

    const segments = exportedAsyncFunctionSegmentsOf(actionsFile.code);
    // Non-vacuity: today's file has 9 exported async functions (8 gated + 1 documented bypass) —
    // a broken walk that found none would make the assertions below fail for the wrong reason
    // rather than catching a real regression.
    expect(segments.length).toBeGreaterThan(0);

    // Form-pin (unchanged from fix round 1): I7's "every exported action" claim holds only
    // because every export in this file today is `export type ` or `export async function `. If
    // a THIRD export form ever lands (e.g. `export const foo = async () => {}`), it is invisible
    // to exportedAsyncFunctionSegmentsOf() and could ship with no impersonation guard, undetected
    // by the assertion below.
    expect(
      occurrences(actionsFile.code, 'export '),
      'actions.ts grew an export that is neither `export type` nor `export async function` — ' +
        'widen exportedAsyncFunctionSegmentsOf() first, or I7 cannot see it.'
    ).toBe(occurrences(actionsFile.code, 'export type ') + segments.length);

    // Every name CHOKEPOINT_BYPASS excuses must be a REAL export — a stale/typo'd bypass entry
    // would otherwise silently excuse nothing while still LOOKING like coverage.
    const exportedNames = segments.map((s) => s.name);
    const staleBypassEntries = CHOKEPOINT_BYPASS.filter((name) => !exportedNames.includes(name));
    expect(
      staleBypassEntries,
      'CHOKEPOINT_BYPASS names something that is not an actual export of lib/credit/actions.ts'
    ).toEqual([]);

    // BODY-SCOPED (fix round 3, human pre-merge review — closes the two gaps a whole-file
    // aggregate scan left open, see the top docblock's I7 entry): each non-bypass export's OWN
    // body segment must call requireBillingActor() naming ITSELF. Neither (a) a sibling
    // function's body naming this export, nor (b) the exemption literal having simply moved to a
    // different caller while the aggregate sets stay equal, can satisfy this.
    const misgated = segments
      .filter((s) => !CHOKEPOINT_BYPASS.includes(s.name))
      .filter((s) => !requireBillingActorCallerNamesOf(s.body).includes(s.name))
      .map((s) => s.name);

    expect(
      misgated,
      `These exports in lib/credit/actions.ts do not call requireBillingActor('<their own name>') ` +
        `from within THEIR OWN body — they can ship with NO impersonation guard at all, even if a ` +
        `SIBLING function's body happens to call requireBillingActor with this name. Route each ` +
        `through requireBillingActor() from its own body, or add it to CHOKEPOINT_BYPASS with a ` +
        `written reason (it must move no money and change no payment instrument).\n` +
        `  misgated: [${misgated.join(', ')}]`
    ).toEqual([]);
  });
});
