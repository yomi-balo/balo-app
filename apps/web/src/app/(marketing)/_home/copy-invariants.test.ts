import { describe, expect, it } from 'vitest';
import { render } from '@/test/utils';
import { resolveRouteDir, scanRouteSources } from '@/invariants/_source-scan';
import { PRICE_POINTS } from './copy';
import { ExpertBandSection } from './expert-band-section';

/**
 * BAL-493 AC-8 — no fee/margin/commission language anywhere on the marketing home, except the
 * one sanctioned string "Service fee included" (`copy.ts`'s `PRICE_POINTS[0].title`).
 *
 * A pure source scan (no rendering) over every `.ts`/`.tsx` file directly under `_home/`
 * (`scanRouteSources` already excludes `.test.` files, so this file and its siblings never
 * self-scan) — reading the COMMENT-STRIPPED `.code` view (`_source-scan.ts`'s `codeLinesOf`),
 * because this file's OWN docblocks, and `copy.ts`'s, deliberately NAME every forbidden word
 * while explaining the rule — a raw-text scan would trip on the documentation of the invariant
 * it enforces.
 *
 * ⚠⚠ DELIBERATE SCOPING DECISION — `%` is excluded from this scan, unlike the plan's literal
 * word list. The shipped, reviewed copy legitimately renders "Top 1%" FOUR times — the
 * proof-band stat (`copy.ts`'s `METRICS`), the hero lede, the experts-section heading, and
 * (materially) `PERKS[3].title` = "Only the top 1% get in", which renders INSIDE the
 * `for-experts` band itself. All four describe Balo's APPLICANT ACCEPTANCE rate — a quality/
 * vetting signal, not a commission or margin percentage — and a bare `%` ban would fail this
 * test against that legitimate, deliberately-shipped copy. `copy.ts`'s OWN docblock for the
 * for-experts band's stricter scan (`PERKS` — "NO fee/margin/cut/commission/earnings/payout
 * language anywhere in this array") already omits `%` for the identical reason; this file's
 * word list mirrors that precedent instead of the plan's more literal shorthand.
 */
const HOME_DIR = resolveRouteDir([
  'src/app/(marketing)/_home',
  'apps/web/src/app/(marketing)/_home',
]);
const files = scanRouteSources(HOME_DIR, '', []);

const GLOBAL_FORBIDDEN = [
  'margin',
  'commission',
  'take rate',
  'our cut',
  'platform fee',
  'earnings',
  'payout',
] as const;

/** `margin: 0` (a CSS-in-JS declaration, `testimonials-section.tsx`) and `marginTop`/
 * `marginBottom`/… (camelCase CSS properties) are NOT the English word "margin" — both are
 * excluded by checking the character immediately following the match. No regex (S5852). */
function isCssMarginProperty(code: string, matchIndex: number): boolean {
  const after = code.charAt(matchIndex + 'margin'.length);
  return after === ':' || (after >= 'A' && after <= 'Z');
}

/** Every start index of `term` (case-insensitive) in `code`, minus the `margin`-as-CSS-property
 * false positives. A plain `indexOf` walk — no regex. */
function findForbidden(code: string, term: string): number[] {
  const lowered = code.toLowerCase();
  const needle = term.toLowerCase();
  const hits: number[] = [];
  let i = lowered.indexOf(needle);
  while (i !== -1) {
    if (needle !== 'margin' || !isCssMarginProperty(code, i)) {
      hits.push(i);
    }
    i = lowered.indexOf(needle, i + needle.length);
  }
  return hits;
}

describe('copy-invariants — source files were found (guard)', () => {
  it('resolved the _home directory and scanned a non-trivial amount of source', () => {
    expect(HOME_DIR).not.toBe('');
    expect(files.length).toBeGreaterThan(5);
    const totalCodeLength = files.reduce((sum, f) => sum + f.code.length, 0);
    expect(totalCodeLength).toBeGreaterThan(1000);
  });
});

describe('copy-invariants — no fee/margin/commission language anywhere on the page (AC-8)', () => {
  it.each(GLOBAL_FORBIDDEN)('forbids "%s" in every _home source file', (term) => {
    for (const file of files) {
      const hits = findForbidden(file.code, term);
      expect(hits, `found forbidden term "${term}" in ${file.rel}`).toEqual([]);
    }
  });
});

describe('copy-invariants — the one sanctioned fee string is pinned exactly', () => {
  it('PRICE_POINTS[0].title is exactly "Service fee included", not a paraphrase', () => {
    const [first] = PRICE_POINTS;
    if (!first) throw new Error('PRICE_POINTS is empty');
    expect(first.title).toBe('Service fee included');
  });
});

describe('copy-invariants — the for-experts band carries ZERO fee/margin language (stricter, no exceptions)', () => {
  // Mirrors `copy.ts`'s own docblock for `PERKS` exactly (deliberately narrower than the global
  // list above: no "%", no "take rate"/"our cut"/"platform fee" as phrases — bare "cut"/"fee"
  // already cover them, and "%" is excluded for the "Only the top 1% get in" reason above).
  const FOR_EXPERTS_FORBIDDEN = [
    'fee',
    'margin',
    'cut',
    'commission',
    'earnings',
    'payout',
  ] as const;

  it("renders none of the forbidden words in the for-experts band's visible text", () => {
    const { container } = render(ExpertBandSection());
    const text = (container.textContent ?? '').toLowerCase();

    expect(text.length).toBeGreaterThan(50);
    for (const term of FOR_EXPERTS_FORBIDDEN) {
      expect(text.includes(term), `for-experts rendered text contains "${term}"`).toBe(false);
    }
  });
});
