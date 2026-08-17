import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CALENDAR_PROVIDERS,
  SYNC_CAPABILITY_MATRIX,
  SYNC_PATH_FILES,
  SYNC_STRATEGIES,
  resolveSyncStrategy,
} from '../services/calendar/sync-capability.js';

/**
 * BAL-447 / ADR-1021 (amendment 2026-08-15) — NOBODY MAY ASSUME SYNC-TOKEN PARITY, AND
 * NOBODY MAY DELTA-SYNC.
 *
 * The ruling this file guards:
 *
 * > Balo performs no calendar delta sync. For every provider, a calendar-change webhook is a
 * > bare trigger that enqueues a whole-window availability rebuild; availability is always
 * > recomputed from a windowed free/busy read via `vendorBusyProvider.listBusyBlocks`.
 * > `syncToken` / `nextSyncToken` is never read and never stored. There is no
 * > provider-conditional sync path.
 *
 * ⚠⚠ THE BAR THIS FILE IS WRITTEN TO: IT MUST FAIL WHEN SOMEONE WRITES DELTA-READ CODE, NOT
 * MERELY WHEN SOMEONE FLIPS A BOOLEAN. `expect(microsoft.supportsSyncToken).toBe(false)` on
 * its own is worthless — flipping the constant flips the test with it. So there are three
 * layers, and only one of them reads the matrix at all:
 *
 *   · Layer 1 (DATA)   — the observed Google/Microsoft DIVERGENCE is still recorded, anchored
 *                        by direction AND by evidence, so it cannot be "fixed" by inverting
 *                        both rows.
 *   · Layer 2 (RULING) — the strategy is CONSTANT and DECOUPLED from capability.
 *                        `resolveSyncStrategy` deliberately does not read `supportsSyncToken`,
 *                        which is what lets Layer 2 assert the parity assumption as a
 *                        PROPERTY: the provider that CAN delta-sync still re-reads.
 *   · Layer 3 (SOURCE) — nobody has WRITTEN delta-read code anywhere under `apps/api/src`.
 *
 * ⚠⚠ EVERY LAYER-3 SCAN DERIVES ITS SUBJECTS FROM A DIRECTORY WALK; NONE OF THEM PINS A FILE
 * LIST. `repositories-never-notify.test.ts` pins one — correct there, because its subjects are
 * shipped repositories. Here the code being guarded against DOES NOT EXIST YET (BAL-396 writes
 * the Apiroc adapter), and a pinned list would pass VACUOUSLY for exactly the future files that
 * matter. Scan A walks all of `apps/api/src`; Scan B walks `PROVIDER_SCAN_DIRS`; Scan E walks the
 * strictly wider `EVENT_CONTENT_SCAN_DIRS`. `SYNC_PATH_FILES` survives only as an asserted SUBSET
 * sanity check — it is no longer any scan's subject, because a pinned subject let BAL-396 opt out
 * by simply adding a NEW file (empirically reproduced during review: a fresh
 * `services/calendar/<name>.ts` containing `switch (provider)` passed every assertion in this
 * file). Deriving from the walk closes that BY CONSTRUCTION.
 *
 * ⚠⚠ SCAN B AND SCAN E DO **NOT** SHARE A BOUNDARY, AND THE ASYMMETRY IS THE DESIGN. Each scan
 * gets the WIDEST directory set it can carry with ZERO exemptions — because the moment a boundary
 * needs an allowlist it starts growing one, and this file forbids that elsewhere.
 *   · Scan B (provider names / branch forms) is the NARROWER of the two, and narrower ONLY
 *     because three existing files under `routes/calendar/` legitimately name both providers:
 *     `auth.ts` (the `z.enum(['google','microsoft'])` connect surface), `api.ts` (the
 *     `office365` ↔ `microsoft` translation), and `types.ts` (the frontend-facing
 *     `CalendarProvider` union). Scanning that directory for provider names would flag exactly
 *     the code that is fine, and a three-file exemption is the allowlist this file forbids. So
 *     Scan B narrows the DIRECTORY instead and carries `routes/calendar/webhook.ts` as a pinned
 *     addition.
 *   · Scan E (event-content reads) carries `routes/calendar/` IN FULL, with no exemption list,
 *     because none is needed: `events.list` / `updatedAfter` / `expandRecurrences` appear
 *     NOWHERE under that directory today — it is Cronofy-era code — and nothing there ever
 *     should read event content. Reusing Scan B's narrower set here would have been a
 *     coincidence of implementation, not a boundary anyone argued for.
 *   Scan E's wider boundary is DELIBERATELY AIMED AT BAL-396: `routes/calendar/` is exactly where
 *   the Apiroc/Svix webhook receiver will land, and a new route file there doing
 *   `events.list(acct, cal, { updatedAfter: lastSyncedAt })` is the single most likely form of the
 *   option ADR-1021's 2026-08-15 amendment rejected. Under the old shared boundary that file
 *   evaded Scan E entirely. It no longer does.
 *
 * ⚠⚠ WHAT THIS GUARD DOES **NOT** CATCH — stated plainly, because a guard whose limits are
 * unwritten gets read as total:
 *   1. PROVIDER CONDITIONALITY IN A NEW FILE UNDER `routes/calendar/`. That directory is outside
 *      `PROVIDER_SCAN_DIRS` for the reason given in the asymmetry note above — three existing
 *      files there legitimately name both providers, and the fix for a directory that trips a
 *      legitimate file is NARROW THE DIRECTORY, never weaken the matcher or grow an exemption
 *      list. `routes/calendar/webhook.ts` is carried as a pinned addition, but a NEW file there
 *      (BAL-396's webhook receiver) is unscanned by Scan B and could branch on the provider.
 *      ⚠ THE RESIDUE IS NARROWER THAN IT LOOKS: such a file is still fully covered by Scan A
 *      (no sync token, tree-wide) and by Scan E (no event content — `routes/calendar/` IS inside
 *      `EVENT_CONTENT_SCAN_DIRS`). What escapes is provider CONDITIONALITY alone, on a path that
 *      can neither read a cursor nor read event content.
 *   2. DELTA CODE OUTSIDE `apps/api/src` — `apps/web`, `packages/db`, a worker in another
 *      package. The walk root is `apps/api/src` and nothing here reaches past it.
 *   3. A DELTA READ SPELLED IN VOCABULARY NO MARKER SET NAMES. The scans are keyword scans over
 *      source text; a vendor SDK that calls its cursor something else entirely slips through.
 *   4. SOMEONE DELETING THIS FILE. No test guards its own existence.
 * Layers 1 and 2 are unaffected by all four — they are property assertions over the matrix.
 *
 * ⚠ SCAN A IS VACUOUSLY TRUE ON MERGE, AND THAT IS INTENDED — said plainly here rather than
 * implied away, in the register of `../notifications/web-schedulable-policy.test.ts:25-29`.
 * `syncToken` / `sync_token` appears NOWHERE in the repo today outside the matrix module and
 * the `apiroc` skill's prose: the delta path was specified and never built, so the scan
 * currently catches nothing. It exists to become a LIVE TRIPWIRE the moment BAL-396 writes its
 * first `events.list({ syncToken })` — precisely the moment the mistake would be made, long
 * after the reasoning above has left anyone's head. A guard that implies it caught something
 * it did not is worse than no guard.
 *
 * ⚠ EVERY SCAN CARRIES A POSITIVE CONTROL. A walk that silently returns `[]`, a read that
 * resolves to the wrong directory, or a classifier that quietly became a no-op would make every
 * absence assertion below pass for the wrong reason (`_source-scan.ts:18-21`). Each scan
 * therefore proves its matcher fires on content that IS genuinely present — on real repo content
 * where such content exists, and on a synthetic string where the whole point is that the shape
 * exists nowhere (writing a probe FILE into the tree to serve as a control would leave the very
 * thing the guard forbids sitting in the repo).
 *
 * ⚠⚠ MARKERS ARE MATCHED AGAINST **RAW** SOURCE, LINE-CLASSIFIED — NOT AGAINST A
 * COMMENT-STRIPPED COPY. This file previously ran `@balo/shared/testing`'s `stripComments` first
 * and scanned the result. That is FAIL-OPEN and was empirically reproduced during review: the
 * stripper is not string-literal aware, so it truncates any line at the first `//` INCLUDING one
 * inside a string. A file containing
 *
 *     return fetch('https://api.onecal.com/events', { headers: { syncToken: t } });
 *
 * strips to `return fetch('https:` and passes every scan below — which lands exactly on the
 * idiomatic raw-fetch shape, against a vendor whose field is literally named `syncToken`.
 * So instead: a marker counts as an offender unless EVERY raw line containing it is a comment
 * line (`isCommentLine`). That errs toward FALSE ALARMS — a trailing `const x = 1; // syncToken`
 * or a block-comment body line not starting with `*` will trip it — and that direction is the
 * correct one to be wrong in for a fail-closed invariant. It is NOT a tokenizer and does not
 * claim to be.
 *
 * ⚠ NOTE / FOLLOW-UP FOR `packages/shared` (deliberately NOT fixed here). `stripComments` in
 * `packages/shared/src/testing/strip-comments.ts` has the string-literal bug described above.
 * Fixing it repo-wide is out of BAL-447's scope: every structural-invariant suite consumes it,
 * and `packages/shared/src/testing/strip-comments.test.ts` currently PINS the buggy behaviour, so
 * a fix has to re-pin that suite too. Raise it separately. Until then no invariant should assume
 * comment-stripping is string-safe.
 *
 * ⚠ NO REGEX ANYWHERE IN HERE, deliberately: these functions read source text, and a regex
 * over it is the SonarCloud S5852 / `regexp/no-super-linear-move` shape. `indexOf`/`includes`/
 * `split` only — including the Scan D union PARSER, which extracts quoted literals by splitting
 * on the quote character rather than matching a pattern.
 *
 * ⚠ PATHS COME FROM `import.meta.url`, NOT `process.cwd()`. CI runs vitest from the REPO ROOT
 * while developers run it from `apps/api`, so a cwd-relative read resolves to nothing in one of
 * the two and ENOENTs in CI only (memory `reference_web_server_disk_asset_cwd`). `apps/api`'s
 * vitest environment is `node`, so `import.meta.url` is a real `file://` URL here — the same
 * mechanism `services/meetings/authorize-engagement-host.test.ts:322` already relies on.
 * (It is NOT usable in `apps/web`'s jsdom suites, which is why those use a candidate list.)
 *
 * IF THIS TEST FAILS, THE REMEDY IS A DECISION, NOT A TEST EDIT: amend ADR-1021 first.
 */

/** `apps/api/src`. */
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/** RAW source text of `apps/api/src/<rel>` — comments are NOT stripped. See the ⚠⚠ above. */
function readRaw(rel: string): string {
  return readFileSync(path.join(SRC_DIR, rel), 'utf8');
}

/**
 * Whether a line is a comment line. Conservative on purpose: `//` line comments, and the `*` /
 * `/*` opening forms of a block comment. Anything else — including a line whose comment starts
 * mid-line — counts as CODE, so a marker hidden after a trailing `//` still trips the scan.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * `raw` with its comment LINES removed, the remaining lines rejoined.
 *
 * This is the classifier, not a stripper: it never edits a line's contents, so a string literal
 * containing `//` survives intact (which is the whole point — see the ⚠⚠ docblock note).
 */
function codeLines(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

/** Which of `markers` appear on at least one NON-comment line of `raw`. */
function markersInCode(raw: string, markers: readonly string[]): string[] {
  const code = codeLines(raw);
  return markers.filter((marker) => code.includes(marker));
}

/** Non-overlapping occurrences of `needle` in `haystack`. No regex (S5852). */
function occurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Every non-test, non-`.d.ts` TypeScript file under `apps/api/src`, as paths relative to it.
 *
 * Test files are excluded because a test may legitimately NAME a forbidden construct while
 * proving it absent — this file being the obvious example.
 */
function collectSourceFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSourceFiles(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    out.push(rel);
  }
  return out;
}

const ALL_SOURCE_FILES = collectSourceFiles(SRC_DIR, '');

// ── Layer 1 — DATA: the observed divergence is still recorded ────────────────────────────

describe('Layer 1 — the vendor divergence is recorded, not smoothed away', () => {
  it('records a REAL vendor divergence — google and microsoft differ on supportsSyncToken', () => {
    expect(SYNC_CAPABILITY_MATRIX.google.supportsSyncToken).not.toBe(
      SYNC_CAPABILITY_MATRIX.microsoft.supportsSyncToken
    );
    // Anchored by DIRECTION and by EVIDENCE, so the pair cannot be "fixed" by inverting both.
    expect(SYNC_CAPABILITY_MATRIX.microsoft.supportsSyncToken).toBe(false);
    expect(SYNC_CAPABILITY_MATRIX.microsoft.evidence).toContain('§M2');
    expect(SYNC_CAPABILITY_MATRIX.google.evidence).toContain('§P3');
  });

  it('every provider carries evidence — an unevidenced row is a guess', () => {
    for (const provider of CALENDAR_PROVIDERS) {
      expect(SYNC_CAPABILITY_MATRIX[provider].evidence).toContain('BAL-393');
    }
  });

  it('microsoft has NO delta mechanism, and google has one Balo declines to use', () => {
    expect(SYNC_CAPABILITY_MATRIX.microsoft.deltaMechanism).toBe('none');
    expect(SYNC_CAPABILITY_MATRIX.google.deltaMechanism).toBe('events_list_sync_token');
  });
});

// ── Layer 2 — RULING: strategy is constant, and decoupled from capability ────────────────

describe('Layer 2 — the sync strategy is uniform and provider-agnostic', () => {
  it('exactly ONE sync strategy exists — a second means provider conditionality', () => {
    expect(SYNC_STRATEGIES).toEqual(['full_window_reread']);
  });

  it('resolves the SAME strategy for every provider', () => {
    const resolved = CALENDAR_PROVIDERS.map(resolveSyncStrategy);
    expect(new Set(resolved).size).toBe(1);
    expect(resolved).toEqual(['full_window_reread', 'full_window_reread']);
  });

  /**
   * THE SHARPEST ASSERTION IN THE FILE: the sync-token-parity assumption stated as a property.
   * It is meaningful ONLY because `resolveSyncStrategy` does not read `supportsSyncToken` —
   * that decoupling is a design choice made specifically to give this test teeth. Flipping the
   * boolean cannot make this pass or fail; only rewriting the resolver can.
   */
  it('⚠ strategy is DECOUPLED from capability — google CAN delta-sync and still re-reads', () => {
    expect(SYNC_CAPABILITY_MATRIX.google.supportsSyncToken).toBe(true);
    expect(resolveSyncStrategy('google')).toBe('full_window_reread');
    expect(resolveSyncStrategy('google')).toBe(resolveSyncStrategy('microsoft'));
  });

  it('covers every provider in the union (guards a vacuous pass)', () => {
    expect(Object.keys(SYNC_CAPABILITY_MATRIX).sort()).toEqual([...CALENDAR_PROVIDERS].sort());
    expect(CALENDAR_PROVIDERS.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Layer 3 — SOURCE ─────────────────────────────────────────────────────────────────────

/**
 * ⚠ `changes_since` IS NOT A MARKER HERE, AND CANNOT BE: `routes/calendar/webhook.ts:14`
 * DECLARES it on the Cronofy payload type. Scan C is its correct home, where
 * *declared-but-never-read* is asserted — a sharper property than a ban would have been.
 */
const SYNC_TOKEN_MARKERS = ['syncToken', 'SyncToken', 'sync_token'] as const;

const MATRIX_REL = 'services/calendar/sync-capability.ts';

/**
 * The two paths exempt from Scan A.
 *
 * ⚠ THE EXEMPTION LIST IS CLOSED. If a future non-calendar feature legitimately needs an
 * unrelated `syncToken`, NARROW THE SCAN ROOT (to `services/`, `jobs/`, `routes/`) rather than
 * growing this list — an allowlist that grows is an invariant that stops being read
 * (`apps/web/src/invariants/_read-only-actions.ts` records that failure from BAL-424).
 */
const SCAN_A_EXEMPT = [
  // The matrix itself: it names the markers in prose and in `supportsSyncToken`.
  MATRIX_REL,
  // This directory — the guard files that must name what they forbid.
  'invariants/',
] as const;

function isExemptFromScanA(rel: string): boolean {
  return SCAN_A_EXEMPT.some((exempt) => rel.startsWith(exempt));
}

describe('Layer 3 / Scan A — no module under apps/api reads or stores a sync token', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isExemptFromScanA(rel));

  it('scans the full apps/api source surface (guards a vacuous pass)', () => {
    // 164 non-test, non-`.d.ts` .ts files today. A walk that resolved the wrong directory,
    // or silently returned [], would pass every absence assertion below for the wrong reason.
    // The floor is deliberately loose — this asserts "the walk ran", not a file census.
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(120);
    expect(ALL_SOURCE_FILES).toContain('routes/calendar/webhook.ts');
    expect(ALL_SOURCE_FILES).toContain('services/availability/vendor-busy.ts');
    expect(ALL_SOURCE_FILES).toContain(MATRIX_REL);
  });

  it('the exemption removed the matrix, and removed only what it claims to', () => {
    // ⚠ NOT `toBe(ALL_SOURCE_FILES.length - 1)`. That hardcodes "exactly one exempt file" while
    // SCAN_A_EXEMPT exempts the whole `invariants/` DIRECTORY, so adding any innocent helper in
    // here failed with a bare arithmetic mismatch and no explanation. The line below carries the
    // actual meaning; the count assertion only proves the filter is not a no-op.
    expect(scanned).not.toContain(MATRIX_REL);
    expect(
      ALL_SOURCE_FILES.length - scanned.length,
      'Scan A exempted nothing — `isExemptFromScanA` has become a no-op, so the "the matcher ' +
        'fires on real repo content" control below is the only thing still proving the scan works.'
    ).toBeGreaterThanOrEqual(1);
  });

  it('the matcher fires on real repo content (guards a dead scan)', () => {
    // The matrix module is the POSITIVE CONTROL: it is the only file under `apps/api/src`
    // that contains the string at all, which makes it a perfect live probe. No fixture needed.
    expect(markersInCode(readRaw(MATRIX_REL), SYNC_TOKEN_MARKERS).length).toBeGreaterThan(0);
  });

  it('the comment classifier really runs (guards every absence assertion below)', () => {
    // If `codeLines` ever silently became a no-op — or, worse, dropped everything — absence
    // scans would still pass while proving nothing. Pinned on comment SYNTAX and on a
    // declaration name, not on any sentence, so prose edits cannot rot it.
    const raw = readRaw(MATRIX_REL);
    expect(raw).toContain('/**');
    expect(codeLines(raw)).not.toContain('/**');
    expect(codeLines(raw)).toContain('export const SYNC_CAPABILITY_MATRIX');
  });

  it('⚠ a marker inside a STRING on a code line is caught, and a comment-only one is not', () => {
    // REGRESSION CONTROL for the fail-open reproduced in review: a comment-STRIPPING scan
    // truncated the line below at `//` inside the URL and passed. Asserted against a synthetic
    // string, never a probe file — writing this shape into the tree would leave the forbidden
    // construct sitting in the repo.
    const rawFetchShape = [
      'export async function fetchEvents(t: string) {',
      "  return fetch('https://api.onecal.com/events', { headers: { syncToken: t } });",
      '}',
    ].join('\n');
    expect(markersInCode(rawFetchShape, SYNC_TOKEN_MARKERS)).toContain('syncToken');

    // And the reason the classifier exists at all still holds: prose that NAMES the forbidden
    // construct — usually to explain its absence — must not trip the invariant.
    expect(
      markersInCode('// syncToken is never read here\nconst x = 1;\n', SYNC_TOKEN_MARKERS)
    ).toEqual([]);
    expect(
      markersInCode(' * `syncToken` is never stored (ADR-1021).\n', SYNC_TOKEN_MARKERS)
    ).toEqual([]);
  });

  it('no module under apps/api reads or stores a calendar sync token', () => {
    const offenders = scanned.filter(
      (rel) => markersInCode(readRaw(rel), SYNC_TOKEN_MARKERS).length > 0
    );

    expect(
      offenders,
      `These files reference a calendar sync token. ADR-1021 (amendment 2026-08-15) rules that ` +
        `Balo performs NO delta sync on ANY provider — the webhook is a bare trigger and ` +
        `availability is recomputed from a windowed free/busy read via ` +
        `vendorBusyProvider.listBusyBlocks. If you believe delta sync is now correct, AMEND THE ` +
        `ADR FIRST; do not allowlist:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * ⚠⚠ NEVER USE A BARE `provider` MARKER. Four of the five files `SYNC_PATH_FILES` names contain
 * `vendorBusyProvider` / `VendorBusyProvider` — THE PORT ITSELF, the abstraction the ruling
 * depends on — and `routes/calendar/webhook.ts` logs the prose `'disconnected by provider'`.
 * A bare marker would flag exactly the code that makes the invariant true. If widening
 * `PROVIDER_SCAN_DIRS` ever trips a legitimate file, NARROW THE DIRECTORY SET — never these two
 * lists.
 */
const PROVIDER_NAMES = ['google', 'microsoft', 'apple', 'icloud'] as const;
const PROVIDER_BRANCH_FORMS = ['provider ===', 'switch (provider'] as const;

/** Which known provider names a source's CODE lines name, case-insensitively. */
function providerNamesIn(raw: string): string[] {
  const lower = codeLines(raw).toLowerCase();
  return PROVIDER_NAMES.filter((name) => lower.includes(name));
}

/**
 * ⚠ EVENT-CONTENT MARKERS — a SECOND ban, for the harm the sync-token ban does not cover.
 *
 * Reason (2) of the ruling is the apiroc skill's Constraint 4 privacy posture: availability is
 * sourced from free/busy (busy slots, no titles), never from event bodies. Banning the CURSOR
 * does not ban that harm. An adapter written as
 *
 *     events.list(acct, cal, { updatedAfter: connection.lastSyncedAt })
 *
 * ships EXACTLY the option ADR-1021's 2026-08-15 amendment rejected — a full event-content read,
 * differenced by timestamp instead of by cursor — while containing none of `SYNC_TOKEN_MARKERS`.
 * It is not hypothetical: `calendar_connections.lastSyncedAt` already exists and is already
 * written on every change webhook by `handleChange`, so the ingredients are on the shelf.
 *
 * ⚠ SCOPED TO `EVENT_CONTENT_SCAN_DIRS`, NOT THE TREE. Constraint 4's second sentence explicitly
 * sanctions full event reads for Balo's OWN tagged consultation events (write / delete /
 * reconcile). Those live outside the sync path and a tree-wide ban would flag them.
 */
const EVENT_CONTENT_MARKERS = ['events.list', 'updatedAfter', 'expandRecurrences'] as const;

/**
 * SCAN B's directory boundary, relative to `apps/api/src` — where a PROVIDER LITERAL is banned.
 *
 * ⚠ THIS IS THE BOUNDARY `services/calendar/sync-capability.ts` ALREADY ARGUES IS THE CHECKABLE
 * ONE: inside the sync path a provider literal has no legitimate business. `routes/calendar/` is
 * deliberately absent — three files there legitimately name both providers, so including it would
 * need the three-file exemption list this guard forbids. See the asymmetry note and limitation (1)
 * in the file docblock. `services/calendar/` IS present and is where the reproduced opt-out landed.
 */
const PROVIDER_SCAN_DIRS = ['jobs/', 'services/availability/', 'services/calendar/'] as const;

/**
 * SCAN E's directory boundary — where an EVENT-CONTENT READ is banned. STRICTLY WIDER than
 * `PROVIDER_SCAN_DIRS`, and wider with ZERO exemptions.
 *
 * ⚠ `routes/calendar/` IS INCLUDED, AND THAT IS THE POINT OF THIS SPLIT. Nothing under it contains
 * any of `EVENT_CONTENT_MARKERS` — it is Cronofy-era code — so no exemption is required, and
 * nothing there ever should read event content. It is also exactly where BAL-396's Apiroc/Svix
 * webhook receiver will land, which is the most likely home for the rejected
 * `events.list(acct, cal, { updatedAfter: lastSyncedAt })` shape. Sharing Scan B's narrower set
 * would have left that file unscanned by this ban.
 */
const EVENT_CONTENT_SCAN_DIRS = [...PROVIDER_SCAN_DIRS, 'routes/calendar/'] as const;

/** Exempt from Scans B and E: the matrix declares the vocabulary it would otherwise be flagged for. */
const SCAN_B_EXEMPT: readonly string[] = [MATRIX_REL];

function isUnderDirs(rel: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => rel.startsWith(dir));
}

/**
 * A scan subject list — DERIVED FROM THE WALK, so a new file cannot opt out.
 *
 * `SYNC_PATH_FILES` contributes only the entries that fall outside `dirs`, and is otherwise
 * demoted to the subset sanity check below. For Scan B that pinned addition is
 * `routes/calendar/webhook.ts`; for Scan E there is none left to add, because
 * `EVENT_CONTENT_SCAN_DIRS` already covers `routes/calendar/` — the union is written the same way
 * for both so that neither can silently lose a declared sync-path file.
 */
function scanSubjectsFor(dirs: readonly string[]): readonly string[] {
  return [
    ...ALL_SOURCE_FILES.filter((rel) => isUnderDirs(rel, dirs) && !SCAN_B_EXEMPT.includes(rel)),
    ...SYNC_PATH_FILES.filter((rel) => !isUnderDirs(rel, dirs)),
  ].sort((a, b) => a.localeCompare(b));
}

/** Scan B's subjects: the provider-literal ban. */
const PROVIDER_SCAN_FILES: readonly string[] = scanSubjectsFor(PROVIDER_SCAN_DIRS);

/** Scan E's subjects: the event-content ban. A strict SUPERSET of `PROVIDER_SCAN_FILES`. */
const EVENT_CONTENT_SCAN_FILES: readonly string[] = scanSubjectsFor(EVENT_CONTENT_SCAN_DIRS);

describe('Layer 3 / Scan B — the sync path names no provider', () => {
  it('derives its subjects from the walk, and SYNC_PATH_FILES is a SUBSET of them', () => {
    for (const rel of SYNC_PATH_FILES) {
      expect(ALL_SOURCE_FILES, `SYNC_PATH_FILES names ${rel}, which no longer exists`).toContain(
        rel
      );
      expect(
        PROVIDER_SCAN_FILES,
        `${rel} is a declared sync-path file but falls outside PROVIDER_SCAN_DIRS and is not ` +
          `carried as a pinned addition — it would be scanned by nothing.`
      ).toContain(rel);
    }
    // The walk really contributed more than the pinned list — otherwise the derivation is a
    // no-op and the opt-out this fix closes is back.
    expect(
      PROVIDER_SCAN_FILES.length,
      'The derived scan set is no larger than SYNC_PATH_FILES — the directory walk contributed ' +
        'nothing, so a new file under PROVIDER_SCAN_DIRS would again go unscanned.'
    ).toBeGreaterThan(SYNC_PATH_FILES.length);
    // A concrete file the walk found and no list ever pinned.
    expect(PROVIDER_SCAN_FILES).toContain('jobs/worker.ts');
    // And the matrix, which names every provider by design, is out.
    expect(PROVIDER_SCAN_FILES).not.toContain(MATRIX_REL);
  });

  it('reads every subject, and no read is empty (guards a dead scan)', () => {
    for (const rel of PROVIDER_SCAN_FILES) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(200);
    }
  });

  it('the provider matcher fires on a file that DOES name providers (positive control)', () => {
    // `routes/calendar/auth.ts` carries `z.enum(['google', 'microsoft'])`. If the matcher
    // silently stopped matching, the absence assertions below would prove nothing.
    expect(providerNamesIn(readRaw('routes/calendar/auth.ts'))).toEqual(['google', 'microsoft']);
  });

  it.each([...PROVIDER_SCAN_FILES])('%s names no calendar provider', (rel) => {
    expect(
      providerNamesIn(readRaw(rel)),
      `${rel} names a calendar provider. The sync path is provider-AGNOSTIC by ADR-1021 ` +
        `(amendment 2026-08-15): one strategy for every provider. A vendor lands inside ` +
        `vendorBusyProvider.listBusyBlocks and nowhere else. AMEND THE ADR FIRST.`
    ).toEqual([]);
  });

  it.each([...PROVIDER_SCAN_FILES])('%s branches on no provider', (rel) => {
    const code = codeLines(readRaw(rel));
    for (const form of PROVIDER_BRANCH_FORMS) {
      expect(
        code,
        `${rel} branches on the provider — that is the conditionality the ruling forbids`
      ).not.toContain(form);
    }
  });
});

describe('Layer 3 / Scan E — the sync path reads free/busy, never event content', () => {
  /**
   * ⚠ THE ASYMMETRY IS ASSERTED, NOT MERELY DOCUMENTED. Scan E's boundary is wider than Scan B's
   * on purpose (see the file docblock), and the widening exists for ONE reason: `routes/calendar/`
   * is where BAL-396's Apiroc/Svix webhook receiver lands. If someone "tidies" the two sets back
   * into one, this fails — rather than silently reopening the hole the split closed.
   */
  it('⚠ scans a STRICTLY WIDER set than Scan B — routes/calendar/ is inside this ban', () => {
    for (const rel of PROVIDER_SCAN_FILES) {
      expect(
        EVENT_CONTENT_SCAN_FILES,
        `${rel} is scanned by Scan B but not by Scan E. Scan E's boundary must remain a SUPERSET ` +
          `of Scan B's — it is the wider ban, not a different one.`
      ).toContain(rel);
    }
    // The concrete files only the wider boundary brings in. `routes/calendar/` needs NO exemption
    // list: none of EVENT_CONTENT_MARKERS appears anywhere under it, and none ever should.
    for (const rel of [
      'routes/calendar/api.ts',
      'routes/calendar/auth.ts',
      'routes/calendar/types.ts',
    ]) {
      expect(
        EVENT_CONTENT_SCAN_FILES,
        `${rel} is not scanned for event content. routes/calendar/ is inside ` +
          `EVENT_CONTENT_SCAN_DIRS precisely so BAL-396's future webhook route cannot land an ` +
          `events.list({ updatedAfter }) there unscanned.`
      ).toContain(rel);
    }
    expect(
      EVENT_CONTENT_SCAN_FILES.length,
      'Scan E is no wider than Scan B — routes/calendar/ has been dropped from ' +
        'EVENT_CONTENT_SCAN_DIRS and BAL-396 can again add an unscanned route file.'
    ).toBeGreaterThan(PROVIDER_SCAN_FILES.length);
  });

  it('reads every subject, and no read is empty (guards a dead scan)', () => {
    for (const rel of EVENT_CONTENT_SCAN_FILES) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(200);
    }
  });

  it('the event-content matcher fires on the rejected shape (positive control)', () => {
    // Synthetic, not a probe file: this shape exists nowhere in the repo, which is the point.
    const rejectedShape = [
      'export async function pullChanges(acct: string, cal: string, since: Date) {',
      '  return client.events.list(acct, cal, { updatedAfter: since, expandRecurrences: true });',
      '}',
    ].join('\n');
    expect(markersInCode(rejectedShape, EVENT_CONTENT_MARKERS)).toEqual([
      'events.list',
      'updatedAfter',
      'expandRecurrences',
    ]);
  });

  it.each([...EVENT_CONTENT_SCAN_FILES])('%s reads no event content', (rel) => {
    expect(
      markersInCode(readRaw(rel), EVENT_CONTENT_MARKERS),
      `${rel} reads calendar EVENT CONTENT on the availability path. Availability must reach a ` +
        `vendor only through vendorBusyProvider.listBusyBlocks, which is a windowed free/busy ` +
        `read — busy slots, no titles (apiroc skill, Constraint 4). A timestamp-differenced ` +
        `events.list({ updatedAfter }) is the option ADR-1021's 2026-08-15 amendment REJECTED: ` +
        `it is a full event read AND it is blind to deletions, so a cancelled meeting never ` +
        `leaves the cache. Full event reads are sanctioned only for Balo's OWN tagged ` +
        `consultation events, which do not live here. AMEND THE ADR FIRST.`
    ).toEqual([]);
  });
});

describe('Layer 3 / Scan C — the webhook stays a bare trigger', () => {
  const webhookCode = codeLines(readRaw('routes/calendar/webhook.ts'));

  it('the webhook still RECEIVES a delta cursor (positive control)', () => {
    expect(webhookCode).toContain('changes_since');
  });

  /**
   * ⚠ COUNTED, NOT FORM-MATCHED. The previous pair of assertions banned two spellings
   * (`notification.changes_since`, `changes_since:`) and `const { changes_since } = notification;`
   * evaded both — and `webhook.ts:99` ALREADY destructures `notification`, so that is the natural
   * shape someone would reach for. Occurrence-counting is spelling-independent: the cursor is
   * DECLARED exactly once, on the payload type at `webhook.ts:14`, and any read at all is a
   * second occurrence.
   */
  it('⚠ and never READS it — the cursor is declared once and referenced nowhere else', () => {
    expect(
      occurrenceCount(webhookCode, 'changes_since'),
      `routes/calendar/webhook.ts mentions changes_since more than once. It is DECLARED on the ` +
        `Cronofy payload type and must never be READ: ADR-1021 (amendment 2026-08-15) makes the ` +
        `webhook a bare trigger that enqueues a whole-window rebuild. AMEND THE ADR FIRST.`
    ).toBe(1);
  });

  it('a change notification enqueues a WHOLE-WINDOW rebuild', () => {
    expect(webhookCode).toContain('enqueueAvailabilityCacheRebuild');
  });
});

/**
 * SCAN D DEFENDS THIS GUARD'S OWN VALIDITY — that is why it is in scope, not because it
 * happens to close an existing gap.
 *
 * `CalendarProvider` is declared by hand in `routes/calendar/types.ts`, repeated as a Zod enum
 * in `routes/calendar/auth.ts`, mirrored again in `apps/web`, and sits over a bare
 * `text('provider')` column with no pgEnum and no CHECK. If the route union grows a provider
 * the matrix never learns about, `CALENDAR_PROVIDERS` silently stops covering the real provider
 * set — and Layers 1 and 2 keep passing while guarding LESS than they claim.
 *
 * ⚠ IT PARSES THE UNION; IT DOES NOT PROBE A FIXED LIST. `providerNamesIn` only sees names
 * `PROVIDER_NAMES` already knows, so a union that grew `'outlook'` / `'exchange'` / `'caldav'`
 * would have passed while `CALENDAR_PROVIDERS` under-covered — exactly the drift this scan
 * exists to catch. Reading the literals out of the declaration itself is closed-vocabulary-free.
 * Parsing is by `split`, never a regex (S5852).
 *
 * ⚠ ONE RECONCILIATION SITE PER DECLARATION, DELIBERATELY. This is not the place to grow a
 * general vocabulary-drift guard; `apps/web`'s mirror is out of scope (the sync path is
 * `apps/api` by construction — see limitation (2) in the file docblock).
 */
interface ProviderUnionSite {
  readonly rel: string;
  /** The exact declaration prefix. Asserted to occur exactly once, so it cannot silently match twice. */
  readonly open: string;
  /** The first character after the literal list. */
  readonly close: string;
}

const PROVIDER_UNION_SITES: readonly ProviderUnionSite[] = [
  { rel: 'routes/calendar/types.ts', open: 'export type CalendarProvider =', close: ';' },
  { rel: 'routes/calendar/auth.ts', open: 'provider: z.enum([', close: ']' },
];

/** The single-quoted literals inside `segment`. Split on the quote char — no regex. */
function singleQuotedLiteralsIn(segment: string): string[] {
  const parts = segment.split("'");
  const out: string[] = [];
  // Odd indices are the insides of quote pairs.
  for (let i = 1; i < parts.length; i += 2) {
    const literal = parts[i];
    if (literal !== undefined) out.push(literal);
  }
  return out;
}

function providerUnionAt(site: ProviderUnionSite): string[] {
  const code = codeLines(readRaw(site.rel));
  expect(
    occurrenceCount(code, site.open),
    `${site.rel}: expected exactly one \`${site.open}\` declaration. If it was renamed or moved, ` +
      `update PROVIDER_UNION_SITES — a parser that finds nothing would make Scan D vacuous.`
  ).toBe(1);
  const start = code.indexOf(site.open) + site.open.length;
  const end = code.indexOf(site.close, start);
  expect(
    end,
    `${site.rel}: the declaration is not terminated by \`${site.close}\``
  ).toBeGreaterThan(start);
  return singleQuotedLiteralsIn(code.slice(start, end));
}

describe('Layer 3 / Scan D — the provider vocabulary has not drifted past the matrix', () => {
  it.each([...PROVIDER_UNION_SITES])(
    '$rel declares exactly the providers in the matrix',
    (site: ProviderUnionSite) => {
      const declared = providerUnionAt(site);
      expect(
        declared.length,
        `${site.rel}: parsed no literals — the parser is dead`
      ).toBeGreaterThan(0);
      expect(
        [...declared].sort((a, b) => a.localeCompare(b)),
        `${site.rel} and CALENDAR_PROVIDERS disagree. Add the provider to ` +
          `services/calendar/sync-capability.ts WITH ITS EVIDENCE — a provider the matrix does ` +
          `not know about is a provider this guard silently stops covering.`
      ).toEqual([...CALENDAR_PROVIDERS].sort((a, b) => a.localeCompare(b)));
    }
  );
});
