import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  listSourceFiles,
  scanMentioningFiles,
  stripComments,
  type ScannedFile,
} from '@balo/shared/testing';
import { ADMIN_ALERT_KIND_KEYS, ADMIN_ALERT_KINDS } from '@balo/shared/admin-alerts';

/**
 * ⚠⚠ INVARIANT — BAL-548 / ADR-1055's XOR CONTRACT: every registry kind has a finder XOR
 * exactly one `raise()` call site, and no approve/pay/repair action may write `admin_alerts`
 * as a side effect (the "no-eager-close" rule, D3).
 *
 * WHY THIS FILE, AND WHY HERE (plan §B.2.6). The claim spans THREE trees — the registry
 * (`packages/shared`), the finder implementations (`apps/api`), and the raise sites
 * (`apps/api`, and in principle `apps/web`) — and `packages/db/src/invariants/
 * audit-trail-ordering.test.ts` already walks all three from one cwd-independent root. This
 * file copies that walker rather than inventing a fourth scanner. `@balo/db` already depends
 * on `@balo/shared`, so `ADMIN_ALERT_KINDS` is VALUE-imported here, never re-parsed.
 *
 * FOUR MATCHERS:
 *
 *  (A) Every kind's quoted kind-literal is counted only across RAISE-CAPABLE files (a file
 *      whose non-comment source contains `adminAlertsRepository.raise(` or
 *      `raiseAdminAlert(`) — NEVER across every file that merely MENTIONS the kind. Counting
 *      over all mentions is what let a purely presentational map (`alert-row.tsx`'s
 *      `KIND_ICONS`, which names every kind for its icon/copy) collide with the real raise
 *      site and fail the invariant (A-F1 — RED on the merged tree, 5 kinds failing this way).
 *      An EVENT-DRIVEN kind (`finder === null` — the four `raise()`-only kinds PLUS
 *      `sweep.failed`, which is also `finder: null`) must appear EXACTLY ONCE across
 *      raise-capable files, in a file that raises. A FINDER kind must appear ZERO times there
 *      (TR-7: the old matcher iterated only event-driven kinds, so a finder kind wrongly ALSO
 *      raised inline anywhere would have satisfied every matcher — this now runs over every
 *      kind, so that double-write is caught too).
 *
 *  (B)/(C) Every FINDER kind's implementation is uniquely resolvable.
 *      ⚠⚠ DELIBERATE DEVIATION FROM THE PLAN'S LITERAL WORDING, RECORDED HONESTLY. §B.10 asks
 *      for "every finder kind's [KIND] literal appears on exactly one line, [...] inside
 *      admin-alert-finders.ts". That does not fit the shape B1 already shipped and which this
 *      file must not alter: `AdminAlertFinding` (`packages/db/src/repositories/
 *      admin-alerts.ts`) carries `entityType` / `entityId` / `detail` and NO `kind` field —
 *      the persisted `kind` for a finder tick comes from the SWEEP's own loop over
 *      `adminAlertKindsForCadence(cadence)` (registry data), never from a literal string
 *      anywhere in `apps/api`. A finder-kind STRING (e.g. `'expert.application_pending'`)
 *      therefore never appears in non-comment `apps/api` source at all by construction —
 *      manufacturing one just to satisfy a text scan would be a fabricated signal, not a real
 *      one. The equivalent, REAL fence given the actual data flow is by FINDER NAME (the
 *      thing `admin-alert-finders.ts` genuinely keys on): the finder NAMES named in the
 *      registry and the keys of `ADMIN_ALERT_FINDERS` (source-scanned from that one file) are
 *      EQUAL SETS, both directions, AND that object is defined in exactly that one file.
 *
 *  (D) THE NO-EAGER-CLOSE FENCE. Every call site of `adminAlertsRepository.close(` or
 *      `.reconcileKind(` across the three trees resolves to an ALLOWED file, compared by FULL
 *      PATH, not basename (A-F6 — a basename match would let a new same-named file ANYWHERE in
 *      the three trees resolve rows): `close-admin-alert.ts` for `.close(`,
 *      `admin-alert-sweep.ts` for `.reconcileKind(`. PLUS a third matcher (A-F6): no file
 *      outside `packages/db` may call `db.update(adminAlerts)` directly, since that bypasses
 *      both `.close(` and `.reconcileKind(` — and so both allowlist checks — entirely.
 *
 * MECHANICS: `@balo/shared/testing`'s shared `listSourceFiles`/`scanMentioningFiles` walker
 * (extracted FROM this file's own former inline copy — see that module's docblock: this file
 * used to state "copies [`audit-trail-ordering.test.ts`'s] walker rather than inventing a
 * fourth scanner", and a THIRD copy for A-F7 pushed that accepted duplication over
 * SonarCloud's new-code gate), plus a local indexOf + depth extraction for everything specific
 * to THIS invariant — NEVER a backtracking regex over arbitrary source (SonarCloud S5852).
 */

// ── Walk ──────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const WALK_ROOT_NAMES: readonly string[] = ['packages/db/src', 'apps/api/src', 'apps/web/src'];

/** This invariant's own absolute path — excluded from the walk. */
const SELF_PATH = fileURLToPath(import.meta.url);

const WALK_INPUT = { repoRoot: REPO_ROOT, rootNames: WALK_ROOT_NAMES, selfPath: SELF_PATH };

const ALL_SOURCE_FILES: string[] = listSourceFiles(WALK_INPUT);

/** Cheap pre-filter (case-insensitive on the RAW source), then the expensive strip. */
const ADMIN_ALERT_MENTIONING_FILES: ScannedFile[] = scanMentioningFiles(
  WALK_INPUT,
  'adminalert',
  stripComments
);

// ── Occurrence counting (indexOf scan, never a regex — S5852) ───────────

/** Every occurrence of `'literal'` or `"literal"` in `source`, quotes included in the match. */
function countQuotedLiteral(source: string, literal: string): number {
  const forms = [`'${literal}'`, `"${literal}"`];
  let count = 0;
  for (const form of forms) {
    let i = source.indexOf(form);
    while (i !== -1) {
      count += 1;
      i = source.indexOf(form, i + form.length);
    }
  }
  return count;
}

/** Every occurrence of `needle` in `source` (a bare substring, not quoted). */
function countSubstring(source: string, needle: string): number {
  let count = 0;
  let i = source.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = source.indexOf(needle, i + needle.length);
  }
  return count;
}

/** Balanced-brace extraction of the object-literal body following `marker` (an `export const
 *  NAME = {` prefix, up to and including the opening brace). Mirrors `onConflictArguments` in
 *  `calendar-connection-cardinality.test.ts` — indexOf + depth counting, never a regex. */
function objectLiteralBodyAfter(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = source.indexOf('{', markerIndex);
  if (braceStart === -1) return null;
  let depth = 1;
  for (let i = braceStart + 1; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  return null; // unterminated — fail closed
}

/** Top-level `identifier` / `identifier:` keys of an object-literal body (depth-0 only, so a
 *  nested object's keys are never mistaken for top-level ones). indexOf + depth counting. */
function topLevelObjectKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const char = body.charAt(i);
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (depth === 0) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
      if (match !== null) {
        const rest = body.slice(i + match[0].length).trimStart();
        if (rest.startsWith(':') || rest.startsWith(',') || rest.startsWith('}')) {
          keys.push(match[0]);
          i += match[0].length;
          continue;
        }
      }
    }
    i += 1;
  }
  return keys;
}

// ── Registry-derived subjects ────────────────────────────────────────────

const EVENT_DRIVEN_KINDS = ADMIN_ALERT_KIND_KEYS.filter(
  (k) => ADMIN_ALERT_KINDS[k].finder === null
);
const FINDER_KIND_ENTRIES = ADMIN_ALERT_KIND_KEYS.filter(
  (k) => ADMIN_ALERT_KINDS[k].finder !== null
).map((k) => ({ kind: k, finderName: ADMIN_ALERT_KINDS[k].finder as string }));

const FINDERS_FILE_DISPLAY_PATH = 'apps/api/src/jobs/admin-alert-finders.ts';
const SWEEP_FILE_DISPLAY_PATH = 'apps/api/src/jobs/admin-alert-sweep.ts';
/** Full path, not basename (A-F6) — a basename match would let a new file ANYWHERE in the
 *  three trees that happens to share this name resolve rows. */
const CLOSE_ACTION_DISPLAY_PATH =
  'apps/web/src/app/(dashboard)/admin/_actions/close-admin-alert.ts';

describe('INVARIANT: BAL-548 admin_alerts kinds have exactly one writer (finder XOR raise)', () => {
  // ── Vacuity guards ───────────────────────────────────────────────────

  it('walks more than 500 source files (guards a broken/empty walk root)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(500);
  });

  it('finds at least 6 files whose raw source mentions adminAlert (guards a broken pre-filter)', () => {
    expect(
      ADMIN_ALERT_MENTIONING_FILES.length,
      `Only ${ADMIN_ALERT_MENTIONING_FILES.length} files mention "adminAlert". If this dropped ` +
        'near zero, the pre-filter or the walk roots are broken.'
    ).toBeGreaterThanOrEqual(6);
  });

  it('registers at least 7 finder kinds and 5 event-driven kinds (positive control on the fixture)', () => {
    expect(FINDER_KIND_ENTRIES.length).toBeGreaterThanOrEqual(7);
    expect(EVENT_DRIVEN_KINDS.length).toBeGreaterThanOrEqual(5);
  });

  it('resolves apps/api/src/jobs/admin-alert-finders.ts (positive control for matcher B/C)', () => {
    const file = ADMIN_ALERT_MENTIONING_FILES.find(
      (f) => f.displayPath === FINDERS_FILE_DISPLAY_PATH
    );
    expect(
      file,
      `${FINDERS_FILE_DISPLAY_PATH} did not resolve or does not mention adminAlert`
    ).toBeDefined();
    expect(file?.source).toContain('ADMIN_ALERT_FINDERS');
  });

  it('resolves apps/api/src/jobs/admin-alert-sweep.ts and it calls reconcileKind( (positive control for matcher D)', () => {
    const file = ADMIN_ALERT_MENTIONING_FILES.find(
      (f) => f.displayPath === SWEEP_FILE_DISPLAY_PATH
    );
    expect(
      file,
      `${SWEEP_FILE_DISPLAY_PATH} did not resolve or does not mention adminAlert`
    ).toBeDefined();
    expect(file?.source).toContain('.reconcileKind(');
  });

  // ── (A) Every kind: its literal, counted only across raise-CAPABLE files ──────────────

  /** Files that can legally WRITE a row via `raise` — the property in (A) is measured only
   *  over this set, never over every file that merely mentions a kind (a presentational
   *  icon/copy map is not a writer and must not be able to fail this invariant — A-F1). */
  const RAISE_SITES: ScannedFile[] = ADMIN_ALERT_MENTIONING_FILES.filter(
    (f) =>
      f.source.includes('adminAlertsRepository.raise(') || f.source.includes('raiseAdminAlert(')
  );

  it('finds at least 4 raise-capable files (guards a broken raise-site filter)', () => {
    expect(
      RAISE_SITES.length,
      `Only ${RAISE_SITES.length} raise-capable files found. If this dropped near zero, the ` +
        'raise-site filter is broken and matcher (A) is vacuous.'
    ).toBeGreaterThanOrEqual(4);
  });

  describe.each(ADMIN_ALERT_KIND_KEYS)('kind %s', (kind) => {
    const isEventDriven = ADMIN_ALERT_KINDS[kind].finder === null;
    const expectedOccurrences = isEventDriven ? 1 : 0;

    it(`has its quoted literal appear exactly ${expectedOccurrences} time(s) across raise-capable files`, () => {
      const hits = RAISE_SITES.filter((f) => countQuotedLiteral(f.source, kind) > 0);
      const totalOccurrences = RAISE_SITES.reduce(
        (sum, f) => sum + countQuotedLiteral(f.source, kind),
        0
      );
      expect(
        totalOccurrences,
        `"${kind}" appears ${totalOccurrences} times across raise-capable files ` +
          `[${hits.map((h) => h.displayPath).join(', ')}] — expected exactly ${expectedOccurrences} ` +
          `(${isEventDriven ? 'one raise site' : 'a finder kind must never ALSO be raised inline'}).`
      ).toBe(expectedOccurrences);

      if (!isEventDriven) return;

      const [onlyHit] = hits;
      expect(onlyHit).toBeDefined();
      if (onlyHit === undefined) return;
      const raises =
        onlyHit.source.includes('adminAlertsRepository.raise(') ||
        onlyHit.source.includes('raiseAdminAlert(');
      expect(
        raises,
        `${onlyHit.displayPath} names "${kind}" but calls neither adminAlertsRepository.raise( nor raiseAdminAlert(.`
      ).toBe(true);
    });
  });

  // ── (B)/(C) Finder identity: names, not kind literals ──────────────────

  it('ADMIN_ALERT_FINDERS is DEFINED in exactly one file: admin-alert-finders.ts', () => {
    // ⚠ `.includes('ADMIN_ALERT_FINDERS')` alone would also match the SWEEP's `import {
    // ADMIN_ALERT_FINDERS } from './admin-alert-finders.js'` — a consumer, not a definer.
    // The definition site is the exported const declaration specifically.
    const definers = ADMIN_ALERT_MENTIONING_FILES.filter((f) =>
      f.source.includes('export const ADMIN_ALERT_FINDERS')
    );
    expect(definers.map((f) => f.displayPath)).toEqual([FINDERS_FILE_DISPLAY_PATH]);
  });

  it('the keys of ADMIN_ALERT_FINDERS equal the registry finder names, both directions', () => {
    const findersFile = ADMIN_ALERT_MENTIONING_FILES.find(
      (f) => f.displayPath === FINDERS_FILE_DISPLAY_PATH
    );
    expect(findersFile).toBeDefined();
    if (findersFile === undefined) return;

    const body = objectLiteralBodyAfter(findersFile.source, 'export const ADMIN_ALERT_FINDERS');
    expect(body, 'Could not extract the ADMIN_ALERT_FINDERS object literal body').not.toBeNull();
    if (body === null) return;

    const implementedNames = new Set(topLevelObjectKeys(body));
    const registryNames = new Set(FINDER_KIND_ENTRIES.map((e) => e.finderName));

    const missingFromImpl = [...registryNames].filter((n) => !implementedNames.has(n));
    const orphanedInImpl = [...implementedNames].filter((n) => !registryNames.has(n));

    expect(
      missingFromImpl,
      `Registry finder(s) with no ADMIN_ALERT_FINDERS implementation: ${missingFromImpl.join(', ')}`
    ).toEqual([]);
    expect(
      orphanedInImpl,
      `ADMIN_ALERT_FINDERS key(s) with no registry kind naming them: ${orphanedInImpl.join(', ')}`
    ).toEqual([]);
  });

  // ── (D) No-eager-close fence ────────────────────────────────────────

  it('every adminAlertsRepository.close( call site is in close-admin-alert.ts', () => {
    const offenders = ADMIN_ALERT_MENTIONING_FILES.filter(
      (f) =>
        countSubstring(f.source, 'adminAlertsRepository.close(') > 0 &&
        f.displayPath !== CLOSE_ACTION_DISPLAY_PATH
    );
    expect(
      offenders.map((f) => f.displayPath),
      'A file outside close-admin-alert.ts calls adminAlertsRepository.close( — this is the ' +
        'no-eager-close fence: no approve / pay / repair action may resolve an admin_alerts row.'
    ).toEqual([]);
  });

  it('every adminAlertsRepository.reconcileKind( call site is in admin-alert-sweep.ts', () => {
    const offenders = ADMIN_ALERT_MENTIONING_FILES.filter(
      (f) =>
        countSubstring(f.source, 'adminAlertsRepository.reconcileKind(') > 0 &&
        f.displayPath !== SWEEP_FILE_DISPLAY_PATH
    );
    expect(
      offenders.map((f) => f.displayPath),
      'A file outside admin-alert-sweep.ts calls adminAlertsRepository.reconcileKind( — only ' +
        'the sweep may resolve a finder-kind row.'
    ).toEqual([]);
  });

  it('no file outside packages/db writes admin_alerts directly via db.update(adminAlerts) (A-F6)', () => {
    // ⚠ A direct `db.update(adminAlerts).set({ resolvedAt })` bypasses BOTH `.close(` and
    // `.reconcileKind(` — and so bypasses the two allowlist checks above entirely. This
    // matcher closes that gap. `packages/db` itself legitimately contains this call (the
    // repository's own implementation, and its integration tests, which the walk already
    // excludes as test files).
    const offenders = ADMIN_ALERT_MENTIONING_FILES.filter(
      (f) =>
        countSubstring(f.source, 'db.update(adminAlerts)') > 0 &&
        !f.displayPath.startsWith('packages/db/')
    );
    expect(
      offenders.map((f) => f.displayPath),
      'A file outside packages/db writes admin_alerts directly via db.update(adminAlerts) — ' +
        'this bypasses the repository and the no-eager-close fence entirely.'
    ).toEqual([]);
  });
});
