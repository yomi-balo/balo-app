import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scanMentioningFiles, stripComments, type ScannedFile } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT — BAL-548 / ADR-1055's A-F7. `AdminAlertDetail.facts`
 * (`packages/shared/src/admin-alerts/detail.ts`) and `AdminAlertMoney.extra` are
 * PRODUCER-AUTHORED FREE TEXT, rendered VERBATIM to any `VIEW_PLATFORM_ADMIN` holder — neither
 * is fee-concealed the way `AdminAlertMoney.expert`/`.margin` are: `apps/web`'s `stripMoney`
 * (`admin-queue-view.ts`) strips exactly those three NAMED fields and nothing else, and it
 * strips `.extra` in NEITHER branch. Both are documented on their field docblocks as NOT
 * fee-concealed; this file is the CHEAPER alternative to threading concealment through free
 * text (chosen over the alternative of validating `facts` against a schema): no producer may
 * write an earnings/margin/markup/commission/fee STRING into `facts`, because every existing
 * producer already reaches for `facts` and would otherwise reintroduce the exact leak
 * `stripMoney` exists to close. Inert today — no shipped producer writes `detail.money` at
 * all — so this invariant exists to hold the line for the FIRST one that does.
 *
 * SCOPE: `apps/api/src` and `packages/db/src` only — `packages/shared` writes no `facts` (it
 * only types the shape), and `apps/web` is a READ-side consumer, never a producer of
 * `admin_alerts.detail`.
 *
 * MECHANICS: `@balo/shared/testing`'s shared `scanMentioningFiles` walker (extracted for THIS
 * invariant — see that module's docblock: a third inline copy of the walker
 * `admin-alert-kinds-have-exactly-one-writer.test.ts` already accepted duplicating from
 * `audit-trail-ordering.test.ts` pushed this repo's new-code duplication over SonarCloud's
 * gate), plus a local indexOf + depth-extraction for `facts:` array bodies — never a
 * backtracking regex over arbitrary source (SonarCloud S5852).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

const ADMIN_ALERT_MENTIONING_FILES: ScannedFile[] = scanMentioningFiles(
  { repoRoot: REPO_ROOT, rootNames: ['packages/db/src', 'apps/api/src'], selfPath: SELF_PATH },
  'adminalert',
  stripComments
);

// ── `facts:` array-literal extraction (balanced-bracket, never a regex) ─────────────────────

/** Balanced-bracket extraction of the array-literal body starting at `bracketStart` (the index
 *  of the `[`). Mirrors `objectLiteralBodyAfter` in the sibling invariant file, `[`/`]` instead
 *  of `{`/`}`. */
function arrayLiteralBodyAt(source: string, bracketStart: number): string | null {
  let depth = 1;
  for (let i = bracketStart + 1; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(bracketStart + 1, i);
    }
  }
  return null; // unterminated — fail closed
}

/** Every `facts: [ … ]` array-literal body in `source`, in source order. */
function extractFactsArrayBodies(source: string): string[] {
  const marker = 'facts:';
  const bodies: string[] = [];
  let markerIndex = source.indexOf(marker);
  while (markerIndex !== -1) {
    const bracketStart = source.indexOf('[', markerIndex);
    if (bracketStart !== -1) {
      const body = arrayLiteralBodyAt(source, bracketStart);
      if (body !== null) bodies.push(body);
    }
    markerIndex = source.indexOf(marker, markerIndex + marker.length);
  }
  return bodies;
}

// ── The banned vocabulary ────────────────────────────────────────────────────────────────

/** Case-insensitive substrings that indicate an EARNINGS/MARGIN/MARKUP figure — the exact
 *  numbers `stripMoney` exists to keep away from a non-`MANAGE_PLATFORM_FEES` holder. */
const BANNED_MONEY_VOCABULARY: readonly string[] = [
  'earning',
  'margin',
  'markup',
  'commission',
  'take rate',
  'balo fee',
  'platform fee',
];

function firstBannedTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const banned of BANNED_MONEY_VOCABULARY) {
    if (lower.includes(banned)) return banned;
  }
  return null;
}

interface Offender {
  readonly file: string;
  readonly term: string;
  readonly snippet: string;
}

describe('INVARIANT: BAL-548 admin_alerts facts never carry concealed-money vocabulary (A-F7)', () => {
  it('finds at least 5 producer files whose raw source mentions adminAlert (guards a broken pre-filter)', () => {
    expect(ADMIN_ALERT_MENTIONING_FILES.length).toBeGreaterThanOrEqual(5);
  });

  it('extracts at least 5 facts: array bodies across producer files (positive control — guards a broken extractor)', () => {
    const totalBodies = ADMIN_ALERT_MENTIONING_FILES.reduce(
      (sum, f) => sum + extractFactsArrayBodies(f.source).length,
      0
    );
    expect(
      totalBodies,
      'If this dropped near zero, extractFactsArrayBodies is broken and the check below is vacuous.'
    ).toBeGreaterThanOrEqual(5);
  });

  it('no facts: array in a producer file contains earnings/margin/markup/commission/fee vocabulary', () => {
    const offenders: Offender[] = [];
    for (const file of ADMIN_ALERT_MENTIONING_FILES) {
      for (const body of extractFactsArrayBodies(file.source)) {
        const term = firstBannedTerm(body);
        if (term !== null) {
          offenders.push({ file: file.displayPath, term, snippet: body.slice(0, 200) });
        }
      }
    }
    expect(
      offenders,
      `facts carries fee-concealed vocabulary — ${JSON.stringify(offenders)}. facts and ` +
        'money.extra are NOT fee-concealed (see AdminAlertDetail.facts / AdminAlertMoney.extra ' +
        "docblocks) — an earnings/margin/markup figure belongs in AdminAlertMoney's own named, " +
        'stripped fields, never in free text.'
    ).toEqual([]);
  });
});
