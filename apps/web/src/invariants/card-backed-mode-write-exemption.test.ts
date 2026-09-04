import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-524 — structural invariant: THE `'card_is_established_by_this_same_operation'` WRITE-GUARD
 * EXEMPTION IS SINGULAR.
 *
 * `creditWalletsRepository.updateConfig`'s card-backed-mode guard defaults ON
 * (`'require_card_on_file'`) precisely so a forgetful future caller is fail-closed — see
 * `packages/shared/src/credit/settlement.ts`. The ONE legitimate exemption is
 * `startPurchaseAction` (`apps/web/src/lib/credit/actions.ts`), which persists the config before
 * the PaymentIntent that establishes the card in the same operation. That exemption is expressed
 * as a named string literal rather than a boolean specifically so it is greppable — this test is
 * the automated version of that grep, run on every CI build rather than by hand.
 *
 * FIX ROUND (F4) — SCANS apps/web/src, apps/api/src AND packages/db/src, NOT apps/web ALONE.
 * `updateConfig` is exported via `@balo/db`, so a second legitimate-looking call site could live
 * in `apps/api` (which imports `@balo/db` directly) or even inside `packages/db` itself — and a
 * web-only scan would stay green while this docblock kept calling itself "the automated version
 * of that grep" over a grep it was no longer actually running. All three trees are combined into
 * ONE assertion below, so a second call site ANYWHERE in the monorepo's application code trips it.
 *
 * ⚠ `packages/db/src/repositories/credit-wallets.ts` legitimately contains the literal in its
 * DOCBLOCK (the guard's own contract, naming the exemption it recognises), and
 * `packages/shared/src/credit/settlement.ts` contains it as a TYPE MEMBER
 * (`CardBackedModeWriteGuard`'s second variant). Neither is a call site. `codeLinesOf` (this
 * directory's shared comment-stripper) drops the docblock hit; the type member is prose, not a
 * call, and is asserted NOT to trip this test below — a passing suite here proves both are inert
 * for this invariant's purposes, not merely assumed to be.
 *
 * ⚠ `packages/shared` is DELIBERATELY NOT a fourth scan root. The literal's HOME definition
 * (`export type CardBackedModeWriteGuard = … | 'card_is_established_by_this_same_operation'`)
 * lives there, so scanning it would make this test find its own type declaration and have to
 * special-case it forever — a different, and permanent, kind of noise from a genuine second call
 * site. `packages/shared` exports the literal; it never calls anything with it.
 *
 * If a second call site starts passing this literal, the guard has been silently widened: either
 * that caller genuinely establishes the card in the same operation (amend this test's expected
 * file list AND say why in the same commit), or it is copying the exemption instead of taking the
 * default — in which case DROP THE ARGUMENT. Never copy the literal to "make a test pass".
 *
 * NO REGEX ANYWHERE, per this directory's S5852 convention — `indexOf` loops only.
 */

const EXEMPTION_LITERAL = 'card_is_established_by_this_same_operation';

/** One source tree this invariant polices, plus the label its found files are reported under. */
interface ScanRoot {
  readonly label: string;
  readonly dir: string;
}

// `resolveRouteDir` covers BOTH cwds this suite can run from (memory `web_server_disk_asset_cwd`):
// a developer's `apps/web` (the first candidate of each pair) and CI's repo root (the second).
const SCAN_ROOTS: readonly ScanRoot[] = [
  { label: 'web', dir: resolveRouteDir(['src', 'apps/web/src']) },
  { label: 'api', dir: resolveRouteDir(['../api/src', 'apps/api/src']) },
  { label: 'db', dir: resolveRouteDir(['../../packages/db/src', 'packages/db/src']) },
];

const WEB_ACTIONS_FILE = 'web:lib/credit/actions.ts';

/** How many times `needle` occurs in `haystack`, non-overlapping — an `indexOf` loop, no regex. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * Every scanned file across all three roots, `rel` prefixed `${label}:` so files from different
 * trees can never collide in the combined report (e.g. a hypothetical `api:lib/credit/actions.ts`
 * is reported distinctly from `web:lib/credit/actions.ts`).
 */
function scanAllRoots(): ScannedFile[] {
  return SCAN_ROOTS.flatMap(({ label, dir }) =>
    scanRouteSources(dir, '', ['node_modules', '.next', '__snapshots__']).map((file) => ({
      ...file,
      rel: `${label}:${file.rel}`,
    }))
  );
}

describe('BAL-524 — the card-backed-mode write-guard exemption is singular', () => {
  it('guards the guard: every scan root resolves, apps/web finds lib/credit/actions.ts, and it genuinely carries the exemption literal (non-vacuity)', () => {
    for (const root of SCAN_ROOTS) {
      expect(root.dir).not.toBe('');
    }

    const files = scanAllRoots();
    expect(files.length).toBeGreaterThan(100);

    const actionsFile = files.find((f) => f.rel === WEB_ACTIONS_FILE);
    expect(actionsFile).toBeDefined();
    expect(actionsFile?.code.includes(EXEMPTION_LITERAL)).toBe(true);
  });

  it('the exemption literal appears in EXACTLY ONE file across apps/web, apps/api and packages/db: lib/credit/actions.ts', () => {
    const files = scanAllRoots().filter((f) => f.code.includes(EXEMPTION_LITERAL));
    expect(files.map((f) => f.rel)).toEqual([WEB_ACTIONS_FILE]);
  });

  it('the exemption literal occurs EXACTLY ONCE in that file (one call site, not several)', () => {
    const files = scanAllRoots();
    const actionsFile = files.find((f) => f.rel === WEB_ACTIONS_FILE);
    if (actionsFile === undefined) {
      throw new Error('lib/credit/actions.ts not found by the scan — see the non-vacuity test');
    }
    expect(occurrences(actionsFile.code, EXEMPTION_LITERAL)).toBe(1);
  });

  it('the two known non-call-site mentions (a docblock in @balo/db, a type member in @balo/shared) do not trip this invariant', () => {
    // `packages/db/src/repositories/credit-wallets.ts`'s docblock mention is COMMENT text —
    // `codeLinesOf` strips it, so the file must NOT appear in the comment-stripped `code` scan
    // even though the literal is genuinely present in the file's `raw` source.
    const dbFiles = scanRouteSources(
      resolveRouteDir(['../../packages/db/src', 'packages/db/src']),
      '',
      ['node_modules', '.next', '__snapshots__']
    );
    const creditWalletsFile = dbFiles.find((f) => f.rel === 'repositories/credit-wallets.ts');
    expect(creditWalletsFile).toBeDefined();
    expect(creditWalletsFile?.raw.includes(EXEMPTION_LITERAL)).toBe(true);
    expect(creditWalletsFile?.code.includes(EXEMPTION_LITERAL)).toBe(false);

    // `packages/shared` is not a scan root at all (see the docblock above) — its type member
    // never enters `scanAllRoots()`'s combined result in the first place.
    const sharedInResults = scanAllRoots().some((f) => f.rel.startsWith('shared:'));
    expect(sharedInResults).toBe(false);
  });
});
