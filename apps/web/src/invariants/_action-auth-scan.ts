import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { codeLinesOf, hasUseServerDirective, type ScannedFile } from './_source-scan';

/**
 * `_action-auth-scan` — **IMPORT-FOLLOWING** for the repo-wide Server Action auth scan (BAL-568).
 *
 * ⚠⚠ WHY THIS EXISTS AT ALL. `onboarding-mutation-gate.test.ts` scoped its own repo-wide ambition
 * down to `app/join/` and stated the prerequisite verbatim: a fixed helper-name list cannot see
 * through the PER-FEATURE WRAPPERS (`engagement-lifecycle-shared`, `milestone-action-shared`,
 * `_shared/require-request-staff-capability`, and friends) that dozens of correctly-authenticated
 * actions gate through, so a repo-wide name scan would flag every one of them as unauthenticated.
 * Measured in this worktree with the shipped `AUTH_HELPERS` list and NO following: **40** of 182
 * `'use server'` modules name no auth primitive at all. An allowlist of 40 is the one move that
 * must not happen. This module resolves the indirection instead, which is what makes a repo-wide
 * assertion — and a 12-entry allowlist (re-measured 2026-09-19 after merging `origin/main`;
 * `account-liveness-gate.test.ts` B7/B8 assert both counts) — honest.
 *
 * ⚠ IT BUILDS ON `_source-scan.ts` RATHER THAN ON A NEW PARSER. Same `indexOf`-only convention:
 * NO REGEX ANYWHERE (SonarCloud S5852 / `regexp/no-super-linear-move`).
 *
 * ⚠ SUBSTRING / LEXICAL, NOT A TYPE CHECKER. An aliased import (`import { requireUser as r }`)
 * evades it, exactly as every sibling invariant in this directory states of itself.
 *
 * ⚠ THIS FILE IS NOT A TEST and is deliberately not named like one — vitest collects only
 * `*.test.ts` / `*.spec.ts` under `src`, so a helper module here is imported, never run as a
 * suite. Same convention as `_source-scan.ts` and `_read-only-actions.ts`.
 */

/**
 * A seam that re-reads the **LIVE ROW** (after BAL-568) — not merely "reads the caller".
 *
 * ⚠⚠ `getSession` IS DELIBERATELY ABSENT, AND THAT ABSENCE IS THE POINT. It is the raw cookie
 * read; it re-reads nothing, and a seven-day-old cookie is exactly what this ticket exists to
 * stop trusting. It is on BAL-132's `AUTH_HELPERS` because that list answers a DIFFERENT question
 * ("does this module look at its caller at all?"). Keeping it out here is what forces the eleven
 * `lib/auth/actions/*` modules to either gain an explicit liveness gate or be named with a
 * written reason — which is the entire discipline of this ticket.
 *
 * ⚠ `resolveMeetingGuestSubject` IS A SEAM WITH NO `users` ROW BEHIND IT. A guest's liveness is
 * the token's own expiry + revocation, re-validated in the database on every request by that
 * resolver. An account-liveness gate is INAPPLICABLE there, not skipped.
 */
export const LIVE_CHECKED_SEAMS: readonly string[] = [
  'requireUser',
  'requireOnboardedUser',
  'withAuth',
  'getCurrentUser',
  // The explicit gate, for the bounded `getSession()`-only set that has no chokepoint to fold
  // into. BOTH entry points are listed: `assertAccountLive` throws (the chokepoints), while
  // `accountRefusalFor` returns the refusal so an action whose contract is "never throws to the
  // caller" — or which fails OPEN on a throw — can honour it without the gate being swallowed.
  'assertAccountLive',
  'accountRefusalFor',
  // Per-feature wrapper; calls `requireOnboardedUser` first.
  'authorizeCaseMutation',
  // A `meeting_guests` row, NOT a `users` row — see the note above.
  'resolveMeetingGuestSubject',
  // A Bearer hop: `apps/api`'s `requireAuth` live-checks on the other side of HTTP (BAL-568 §4).
  //
  // ⚠⚠ R9's "THE GATE SITS ABOVE THE PARSE" DOES **NOT** HOLD ON THIS SEAM, AND THAT IS A KNOWN,
  // ACCEPTED EXCEPTION (fix round 2, G4). An action reaching the API this way (e.g.
  // `openSessionAction`) validates its input LOCALLY first and only then makes the hop, so the
  // account check happens on the far side of HTTP — AFTER the parse. A refused caller can
  // therefore still learn whether their own input was well-formed.
  //
  // Why that is acceptable here, rather than a gap to close:
  //   · nothing is written on the web side before the hop — the parse is pure;
  //   · the leaked bit is about the CALLER'S OWN INPUT, not about the existence of any other
  //     record, which is the disclosure R9 exists to prevent;
  //   · closing it would mean a local liveness read in front of every api-client action purely to
  //     reorder an error message, i.e. a second read on the hot path for no security gain.
  //
  // It is written down because an undocumented exception to a stated ruling is how the next reader
  // concludes the ruling was never real.
  'callSessionApi',
];

/**
 * Modules that **DEFINE** a seam. Importing FROM one proves nothing, so following stops here.
 *
 * ⚠⚠ THIS IS A MEASURED FALSE-PASS FIX, NOT TIDINESS. `lib/auth/session.ts` exports `getSession`
 * and the `SessionUser` type alongside the seams, so following into it reclassified all eleven
 * `lib/auth/actions/*` modules — **including `sign-in.ts` and `logout.ts`** — as live-checked.
 * A module that genuinely USES a seam names it in its own source and is caught at depth 0, so the
 * exclusion costs nothing and closes the hole. A WRAPPER (a module that CALLS a seam and exists
 * to gate) is a different thing and is followed.
 *
 * The same exclusion is what keeps `app/join/_actions/claim-lobby-place.ts` and
 * `poll-guest-admission.ts` correctly UNRESOLVED: they import the PUBLIC hop `postLobbyClaim`
 * from `lib/meetings/join-api-client.ts`, a module whose MEMBER hop mentions `getSession`.
 * Without that, `PUBLIC_ACTION_ALLOWLIST`'s exact-set-equality assertion in
 * `onboarding-mutation-gate.test.ts` would break — i.e. BAL-132's property would be destroyed by
 * "fixing" BAL-568.
 *
 * ⚠⚠ THE BARREL IS THE SAME HOLE ONE LEVEL UP, AND IT WAS OPEN UNTIL FIX ROUND 3 (H1).
 * `lib/auth/index.ts` re-exports `getSession` ALONGSIDE `requireUser`, `requireOnboardedUser`,
 * `getCurrentUser` and `withAuth`, so a module importing ONLY `getSession` from `@/lib/auth` was
 * followed into the barrel, found the seam names sitting there, and classified as LIVE-CHECKED —
 * a FALSE PASS, the one direction a security scan must never be wrong in. Excluding the barrel
 * costs nothing for the same reason the `session.ts` entry does: a module that genuinely CALLS a
 * seam names it in its own source and is caught at depth 0. `account-liveness-gate.test.ts` B10
 * carries a barrel decoy so the entry cannot be deleted unnoticed.
 */
export const SEAM_DEFINITION_MODULES: readonly string[] = [
  'lib/auth/session.ts', // requireUser / requireOnboardedUser / getCurrentUser
  // The BARREL over `session.ts` + `with-auth.ts` — importing from it proves nothing, exactly as
  // for the two modules it re-exports (it also re-exports the raw `getSession`).
  'lib/auth/index.ts',
  'lib/auth/with-auth.ts', // withAuth
  'lib/auth/account-liveness.ts', // assertAccountLive / accountRefusalFor
  'lib/credit/api-client.ts', // callSessionApi
  'lib/meetings/resolve-meeting-guest.ts', // resolveMeetingGuestSubject
  'app/(dashboard)/cases/[engagementId]/_lib/authorize-case-mutation.ts', // authorizeCaseMutation
];

/** Whether `code` names any live-checked seam. Substring, same as every sibling invariant. */
export function namesLiveCheckedSeam(code: string): boolean {
  return LIVE_CHECKED_SEAMS.some((seam) => code.includes(seam));
}

/** The extension candidates a bare specifier can resolve to, in resolution order. */
const RESOLUTION_SUFFIXES: readonly string[] = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * One `from '<specifier>'` clause found in a source file, plus whether it was a RE-EXPORT
 * (`export { x } from '…'`) rather than an ordinary import. The distinction is load-bearing at
 * depth 2 — see {@link classifyActionModule}.
 */
export interface SourceSpecifier {
  readonly specifier: string;
  readonly isReExport: boolean;
}

/**
 * Whether the `{ … }` clause preceding `fromIdx` belongs to an `export` statement rather than an
 * `import` one. Walks back to the nearest `{`, then back over whitespace to the preceding word.
 *
 * A clause with no `{` before it (`export * from '…'`, `import 'side-effect'`) reads as NOT a
 * re-export: `export *` is rare in this tree and treating it as an ordinary import is the
 * conservative direction (it can only make a module classify as unresolved, never as gated).
 *
 * ⚠⚠ THE STATEMENT-BOUNDARY CHECK IS A LATENT-WIDENING FIX, NOT A TIDY-UP (fix round 1, F8).
 * `lastIndexOf('{')` happily walks past the end of the current statement into a PRECEDING one, so
 * `"export { foo };\nimport * as bar from './c';"` found the *export's* brace and reported the
 * plain import as a re-export — measured. Depth 2 would then follow an ordinary import, which is
 * exactly the promiscuity the re-export-only rule exists to prevent (and which was measured to
 * reclassify the two `app/join/` PUBLIC actions). Requiring the brace to sit after the last `;`
 * before `fromIdx` confines the walk to one statement. Not reachable in today's tree; it is the
 * scan this ticket's whole invariant rests on, so it is closed anyway.
 */
function clauseIsReExport(source: string, fromIdx: number): boolean {
  const open = source.lastIndexOf('{', fromIdx);
  if (open === -1) return false;
  if (open < source.lastIndexOf(';', fromIdx)) return false; // brace belongs to an earlier statement
  let end = open;
  while (end > 0 && /* whitespace */ source.charAt(end - 1).trim() === '') end -= 1;
  return source.slice(0, end).endsWith('export');
}

/**
 * Every `from '<spec>'` / `from "<spec>"` clause in `source`, each tagged as an import or a
 * re-export. One `indexOf` walk per quote style — no regex.
 *
 * ⚠ RETURNED IN SOURCE ORDER, AND THAT NEEDS THE EXPLICIT SORT (fix round 1, F12). The quote-style
 * loop is the OUTER one, so without it every single-quoted clause preceded every double-quoted
 * one regardless of position — and `via`'s stability (pinned verbatim by the reclassification
 * proofs) rests on this ordering, because the first followable hop wins. Prettier normalises this
 * repo to single quotes, so the bug is currently unobservable; the ordering is still what the
 * contract says, so it is made true rather than documented away.
 */
export function specifiersOf(source: string): SourceSpecifier[] {
  const found: { specifier: string; isReExport: boolean; at: number }[] = [];
  for (const quote of ["'", '"']) {
    const marker = `from ${quote}`;
    let i = source.indexOf(marker);
    while (i !== -1) {
      const start = i + marker.length;
      const end = source.indexOf(quote, start);
      if (end === -1) break;
      const specifier = source.slice(start, end);
      if (specifier.length > 0) {
        found.push({ specifier, isReExport: clauseIsReExport(source, i), at: i });
      }
      i = source.indexOf(marker, end + 1);
    }
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ specifier, isReExport }) => ({ specifier, isReExport }));
}

/**
 * Resolve one module specifier to an absolute file on disk, or `null`.
 *
 * Only FIRST-PARTY specifiers are followable: relative (`./x`, `../x`) and the `@/` tsconfig
 * alias, which is the ONLY alias `apps/web` declares. `@balo/*`, `next/*` and bare packages
 * resolve to `null` and are never followed — they are outside the tree this invariant reasons
 * about.
 */
export function resolveSpecifier(
  srcDir: string,
  fromAbsFile: string,
  specifier: string
): string | null {
  let base: string;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = path.resolve(path.dirname(fromAbsFile), specifier);
  } else if (specifier.startsWith('@/')) {
    base = path.join(srcDir, specifier.slice(2));
  } else {
    return null;
  }
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** A resolved target module: its absolute path, its comment-stripped code, its specifiers. */
export interface TargetModule {
  readonly abs: string;
  readonly code: string;
  readonly specifiers: readonly SourceSpecifier[];
}

/**
 * The per-walk memo of already-read target modules. Exported so a caller (and the guards-the-guard
 * test) can classify one module at a time without re-reading the tree, and without reaching for a
 * type assertion to conjure a cache.
 */
export type ClassificationCache = Map<string, TargetModule>;

/** A fresh, empty {@link ClassificationCache}. */
export function createClassificationCache(): ClassificationCache {
  return new Map<string, TargetModule>();
}

/** Read + parse one resolved target, memoised for the whole walk. */
function loadTarget(abs: string, cache: ClassificationCache): TargetModule {
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  // ⚠ COMMENT-STRIPPED FOR BOTH VIEWS. A commented-out import must not be followed, and a
  // docblock that NAMES a seam while explaining that it is never called must not classify the
  // module as gated — the same reasoning `_source-scan.ts` gives for `codeLinesOf`.
  const code = codeLinesOf(readFileSync(abs, 'utf8'));
  const loaded: TargetModule = { abs, code, specifiers: specifiersOf(code) };
  cache.set(abs, loaded);
  return loaded;
}

/** `true` when this resolved target is one of the {@link SEAM_DEFINITION_MODULES}. */
function isSeamDefinitionModule(srcDir: string, abs: string): boolean {
  const rel = path.relative(srcDir, abs).split(path.sep).join('/');
  return SEAM_DEFINITION_MODULES.includes(rel);
}

/**
 * A target is FOLLOWABLE when it names a seam AND is not a seam DEFINITION module — i.e. it is a
 * wrapper that CALLS the seam, not the module that declares it.
 */
function isFollowable(srcDir: string, target: TargetModule): boolean {
  return namesLiveCheckedSeam(target.code) && !isSeamDefinitionModule(srcDir, target.abs);
}

/** A resolved target's path relative to `srcDir`, POSIX-separated — what `via` carries. */
function relOf(srcDir: string, target: TargetModule): string {
  return path.relative(srcDir, target.abs).split(path.sep).join('/');
}

/**
 * Whether `source` takes at least one **VALUE** binding from `specifier` — i.e. it actually calls
 * into that module at runtime, rather than merely borrowing a type from it.
 *
 * ⚠⚠ THIS IS F9(a)'s HARDENING, AND IT CLOSES A REAL (IF UNEXPLOITED) WIDENING. Before it, a hop
 * counted purely because the module named its path: any specifier resolving to one of the 203
 * "followable" files classified the importer as gated, INCLUDING a pure
 * `import type { Workspace } from '@/lib/workspaces/get-workspaces'`. A brand-new ungated Server
 * Action could have passed the invariant by importing a TYPE. Following is still symbol-blind in
 * the weaker sense documented on {@link classifyActionModule} — we do not check that the imported
 * value IS the seam — but it can no longer be satisfied by something erased at compile time.
 *
 * Built on `namedImportsFrom` (which R1 pointed at) for the brace parsing, plus a statement-level
 * `import type` check that helper deliberately normalises away. No regex, per this directory's
 * convention.
 */
function clauseTakesValueBinding(source: string, fromIdx: number): boolean {
  const stmtStart = source.lastIndexOf(';', fromIdx) + 1;
  // A statement-level `import type { … } from '…'` erases entirely — never a value edge.
  if (source.slice(stmtStart, fromIdx).trimStart().startsWith('import type')) return false;
  const open = source.lastIndexOf('{', fromIdx);
  if (open === -1 || open < stmtStart) return false;
  const close = source.indexOf('}', open);
  if (close === -1 || close >= fromIdx) return false;
  // At least one binding inside the braces that is NOT itself `type X`.
  return source
    .slice(open + 1, close)
    .split(',')
    .some((binding) => {
      const trimmed = binding.trim();
      return trimmed.length > 0 && !trimmed.startsWith('type ');
    });
}

/** @see clauseTakesValueBinding — extracted only to keep this under SonarCloud's complexity cap. */
function takesValueImportFrom(source: string, specifier: string): boolean {
  for (const quote of ["'", '"']) {
    const marker = `from ${quote}${specifier}${quote}`;
    let fromIdx = source.indexOf(marker);
    while (fromIdx !== -1) {
      if (clauseTakesValueBinding(source, fromIdx)) return true;
      fromIdx = source.indexOf(marker, fromIdx + marker.length);
    }
  }
  return false;
}

/**
 * Every first-party specifier of `specifiers` resolved to a loaded module, in source order,
 * keeping only hops the importer takes a VALUE from (F9(a) — see {@link takesValueImportFrom}).
 * `reExportsOnly` restricts the walk to `export { … } from '…'` clauses — the depth-2 rule.
 *
 * ⚠ EXTRACTED TO SHED COGNITIVE COMPLEXITY (SonarCloud caps `classifyActionModule` at 15; the
 * fully inlined version scored 18). Resolution order, skip-on-unresolvable and the memo are
 * unchanged from the inlined loops.
 */
function resolveHops(
  srcDir: string,
  fromAbs: string,
  fromCode: string,
  specifiers: readonly SourceSpecifier[],
  cache: ClassificationCache,
  reExportsOnly: boolean
): TargetModule[] {
  const hops: TargetModule[] = [];
  for (const { specifier, isReExport } of specifiers) {
    if (reExportsOnly && !isReExport) continue;
    if (!takesValueImportFrom(fromCode, specifier)) continue;
    const resolved = resolveSpecifier(srcDir, fromAbs, specifier);
    if (resolved === null) continue;
    hops.push(loadTarget(resolved, cache));
  }
  return hops;
}

/** How a module reached a live-checked seam. */
export interface ActionAuthClassification {
  readonly rel: string;
  /** `0` own source, `1` one import hop, `2` one further RE-EXPORT hop, `null` unresolved. */
  readonly depth: 0 | 1 | 2 | null;
  /**
   * The chain of module paths (relative to `srcDir`) that carried the resolution, `[]` at depth 0
   * and when unresolved. ⚠ Pinned VERBATIM by the reclassification proofs: if following ever
   * silently stops working, those are the only assertions that would notice.
   */
  readonly via: readonly string[];
}

/**
 * Classify one `'use server'` module against {@link LIVE_CHECKED_SEAMS}, following imports.
 *
 * | Depth | Rule                                                                              |
 * | ----- | --------------------------------------------------------------------------------- |
 * | 0     | M's own code names a seam.                                                         |
 * | 1     | Any first-party specifier of M (import OR re-export) resolves to a followable T.   |
 * | 2     | Any **RE-EXPORT** specifier of such a T resolves to a followable T2.               |
 * | null  | Otherwise UNRESOLVED — it must be named in an allowlist with a written reason.     |
 *
 * ⚠⚠ THE BOUND IS TWO, NOT ONE, AND DEPTH 2 FOLLOWS RE-EXPORTS ONLY. Measured: with one level,
 * FIVE correctly-gated engagement-lifecycle actions are unresolved, all through the same real
 * chain —
 *   `accept-project.ts` → `engagement-lifecycle-shared.ts`
 *     (`export { requireExpertUser as requireSignedInUser } from './milestone-action-shared'`)
 *   → `milestone-action-shared.ts` (`import { requireOnboardedUser } from '@/lib/auth/session'`)
 * — so one level is provably insufficient. Restricting depth 2 to RE-EXPORTS is what keeps it
 * from going promiscuous: an unrestricted depth-2 walk over ALL imports reclassified the two
 * `app/join/` PUBLIC actions and `sign-up.ts` through unrelated library modules (measured), which
 * would have destroyed BAL-132's property. **DEPTH 3 IS NOT IMPLEMENTED**; if a future chain needs
 * it, widen the bound deliberately and re-measure — never absorb the miss into the allowlist.
 *
 * ── ⚠⚠ TWO LIMITATIONS THAT ARE REAL, MEASURED, AND DELIBERATELY NOT SOLVED HERE (F9) ────────
 *
 * Both were found by the security gate re-implementing this classifier standalone — it reproduced
 * the depth histogram exactly, so these describe the real behaviour, not a guess. Neither is
 * exploitable in today's tree (every depth-1/2 `via` target is a genuine auth wrapper), but a
 * future reader must not mistake this scan for more than it is.
 *
 * **(a) FOLLOWING IS SYMBOL-BLIND.** A hop counts when the importer takes *a value* from a module
 * that *names a seam somewhere*. It does NOT check that the imported symbol is the seam, or that
 * the seam runs on the path the imported symbol takes. `takesValueImportFrom` narrows this — a
 * type-only import no longer counts, which was the cheap half and is now closed — but a module
 * importing any unrelated runtime helper from a followable file still classifies as gated.
 * Tightening it properly means resolving each imported symbol to its declaration, which is a type
 * checker, not an `indexOf` scan.
 *
 * **(b) CLASSIFICATION IS PER-MODULE, NOT PER-EXPORT.** A file with two exported actions is
 * classified once, so one gated export covers an ungated sibling. Live in-tree instance:
 * `lib/auth/actions/impersonation.ts` classifies depth 0 because `startImpersonationAction` gates,
 * while `stopImpersonationAction` uses a bare `getSession()` and does not. **That outcome is
 * correct here and is worth stating so nobody "fixes" it**: gating STOP would trap a staff member
 * inside an impersonated session whose target was suspended mid-session — the one case where the
 * escape hatch must stay open. It is correct by accident of module granularity, though, not
 * because this scan reasoned about it.
 *
 * ⚠ Both compound the aliased-import caveat at the top of this file. This is a LEXICAL scan; it
 * raises the floor, it does not prove the property.
 */
export function classifyActionModule(
  srcDir: string,
  file: ScannedFile,
  cache: ClassificationCache
): ActionAuthClassification {
  if (namesLiveCheckedSeam(file.code)) {
    return { rel: file.rel, depth: 0, via: [] };
  }

  const abs = path.join(srcDir, file.rel);
  const firstHops = resolveHops(srcDir, abs, file.code, specifiersOf(file.code), cache, false);

  const direct = firstHops.find((target) => isFollowable(srcDir, target));
  if (direct !== undefined) {
    return { rel: file.rel, depth: 1, via: [relOf(srcDir, direct)] };
  }

  for (const hop of firstHops) {
    // ⚠ RE-EXPORTS ONLY at depth 2 — see the docblock above for the measurement that shows an
    // unrestricted second hop destroys BAL-132's property.
    const second = resolveHops(srcDir, hop.abs, hop.code, hop.specifiers, cache, true).find(
      (target) => isFollowable(srcDir, target)
    );
    if (second !== undefined) {
      return { rel: file.rel, depth: 2, via: [relOf(srcDir, hop), relOf(srcDir, second)] };
    }
  }

  return { rel: file.rel, depth: null, via: [] };
}

/**
 * Classify EVERY `'use server'` module under `srcDir`, from an already-collected, UNFILTERED walk.
 *
 * ⚠ THE WALK IS UNFILTERED AND THE ALLOWLIST IS COMPARED, NEVER USED TO FILTER (the BAL-404
 * lesson: a set-equality assertion against a pre-filtered walk is vacuous, because the collected
 * set can never contain an unexpected file).
 */
export function classifyActionModules(
  srcDir: string,
  scanned: readonly ScannedFile[]
): ActionAuthClassification[] {
  const cache = createClassificationCache();
  return scanned
    .filter((file) => hasUseServerDirective(file.raw))
    .map((file) => classifyActionModule(srcDir, file, cache));
}

/** How many distinct first-party specifiers the walk actually resolved — the non-vacuity probe. */
export function countResolvedSpecifiers(srcDir: string, scanned: readonly ScannedFile[]): number {
  const resolved = new Set<string>();
  for (const file of scanned) {
    const abs = path.join(srcDir, file.rel);
    for (const { specifier } of specifiersOf(file.code)) {
      const target = resolveSpecifier(srcDir, abs, specifier);
      if (target !== null) resolved.add(target);
    }
  }
  return resolved.size;
}
