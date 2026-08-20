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
 * BAL-447 / ADR-1021 (amendment 2026-08-15, amended again 18 Aug 2026 for BAL-396) — NOBODY
 * MAY ASSUME SYNC-TOKEN PARITY, AND NOBODY MAY DELTA-SYNC.
 *
 * The ruling this file guards:
 *
 * > Balo performs no calendar delta sync. For every provider, a calendar-change webhook is a
 * > bare trigger that enqueues a whole-window availability rebuild; availability is always
 * > recomputed from a windowed free/busy read via `vendorBusyProvider.listBusyBlocks`.
 * > `syncToken` / `nextSyncToken` is never read and never stored. There is no
 * > provider-conditional sync path, and no code outside the vendor boundary reads calendar
 * > EVENT CONTENT on the availability path.
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
 * shipped repositories. Here new files are exactly the risk (BAL-396 wrote the whole Apiroc
 * adapter after this file first shipped), and a pinned list would pass VACUOUSLY for exactly
 * the future files that matter. Scans A, B and E all walk `ALL_SOURCE_FILES` — the full
 * `apps/api/src` tree — and subtract only their own NAMED exemptions.
 * `SYNC_PATH_FILES` survives only as an asserted SUBSET sanity check — it is no scan's subject
 * list, because a pinned subject let a new file opt out by simply not being listed (empirically
 * reproduced during BAL-447's review: a fresh `services/calendar/<name>.ts` containing
 * `switch (provider)` passed every assertion in this file). Deriving from the walk closes that
 * BY CONSTRUCTION.
 *
 * ⚠⚠ ADR-1021's 18 Aug 2026 (BAL-396) AMENDMENT §1/§2 WIDENED SCANS B AND E FROM A
 * THREE-/FOUR-DIRECTORY ALLOWLIST TO TREE-WIDE, EACH WITH ONLY NAMED EXEMPTIONS:
 *   · Scan B (provider literals) now walks ALL of `apps/api/src`, exempting exactly
 *     `lib/apiroc/` (the vendor boundary — the SDK's uppercase `ProviderType` and the display
 *     labels it drives) and `routes/calendar/` (the connect surface — the `z.enum(['google',
 *     'microsoft'])` and the `office365` translation). Nowhere else may a provider name or a
 *     provider branch appear — this is now genuinely wider than the old boundary:
 *     `services/meetings/`, `services/consultation-events/`, `services/auth/`, all of `lib/`
 *     except `lib/apiroc/`, all of `routes/` except `routes/calendar/`, and `notifications/`
 *     are newly covered.
 *   · Scan E (event-content reads) now walks ALL of `apps/api/src`, exempting exactly
 *     `services/consultation-events/` — the one directory ADR-1021 §2 sanctions for a full
 *     event-content read (Balo's OWN tagged consultation events; write / delete / reconcile).
 *     It ALSO carries a SHAPE GATE unique to that exemption: an `events.list` inside it must
 *     ALSO carry `metadataFilters` AND `nextPageToken` — tag-filtered AND paginated to
 *     exhaustion, never a bare listing. `updatedAfter` / `expandRecurrences` stay banned
 *     TREE-WIDE, including inside that one exemption — there is no reading list content by
 *     timestamp-diff anywhere, ever.
 *   · The two exemption sets are DISJOINT, and that disjointness is itself asserted (Scan E's
 *     final property): `services/consultation-events/` is scanned by Scan B (it may name no
 *     provider), and `lib/apiroc/` + `routes/calendar/` are scanned by Scan E (they may read
 *     no event content). No directory is exempt from both.
 *   · Scan C, scoped to the now-deleted `routes/calendar/webhook.ts` (Cronofy's bare-trigger
 *     receiver), is RETIRED — its subject no longer exists, and the property it guarded
 *     (`changes_since` declared but never read) is structurally unrepresentable once the
 *     Cronofy payload type is gone. It is REPLACED by a sharper assertion that the live
 *     Apiroc free/busy port (`services/availability/vendor-busy.ts`) makes a genuine
 *     `freeBusy.get` call, reads no event content, and is the ONLY thing either availability
 *     consumer calls into a vendor through.
 *
 * ⚠⚠ FIX ROUND 2 (BAL-396, Finding 3) — THE WALK PREVIOUSLY SAW NO `.tsx` FILE AT ALL. Scans B
 * and E's "tree-wide" claim above was true only of `.ts` files: `collectSourceFiles` filtered on
 * `entry.name.endsWith('.ts')`, which is false for every `.tsx` file. All 51 files under
 * `notifications/channels/templates/` — including this ticket's own new
 * `calendar-reconnect-required.tsx` — were silently unscanned. The docblock's own anti-vacuity
 * witness for that directory (`templates/index.ts`) made the coverage LOOK proven: it is the
 * ONE `.ts` file there, so it said nothing about the other 50. Fixed by widening the walk to
 * `.ts` AND `.tsx` — same shape as this repo's existing precedent,
 * `notifications/channels/templates/review-emails.test.ts`'s
 * `entry.endsWith('.ts') || entry.endsWith('.tsx')` scan — and by re-pointing the anti-vacuity
 * witnesses at a genuine `.tsx` file so the claim is honest going forward.
 *
 * Widening surfaced a REAL false positive, fixed alongside it: `templates/shared.tsx` and
 * `templates/review-email-shared.tsx` both carry a CSS font stack containing
 * `fonts.googleapis.com` and `-apple-system` — ordinary English/CSS words that are substrings
 * of the provider names `google` / `apple`, with zero connection to a calendar provider.
 * `PROVIDER_NAMES` matching is a bare substring scan, so it cannot tell "font stack" from
 * "provider literal" by the word alone. Rather than exempt the two files outright (which would
 * also blind Scan B to a REAL provider literal added to them later), `providerNamesIn` now
 * strips exactly those two idioms before matching — narrower than a file exemption, and itself
 * covered by a positive/negative regression control below.
 *
 * ⚠⚠ WHAT THIS GUARD DOES **NOT** CATCH — stated plainly, because a guard whose limits are
 * unwritten gets read as total:
 *   1. DELTA CODE OUTSIDE `apps/api/src` — `apps/web`, `packages/db`, a worker in another
 *      package. The walk root is `apps/api/src` and nothing here reaches past it.
 *   2. A DELTA READ SPELLED IN VOCABULARY NO MARKER SET NAMES. The scans are keyword scans over
 *      source text; a vendor SDK that calls its cursor something else entirely slips through.
 *   3. SOMEONE DELETING THIS FILE. No test guards its own existence.
 *   4. PROVIDER CONDITIONALITY OR EVENT-CONTENT READS INSIDE `lib/apiroc/` OR
 *      `routes/calendar/` (Scan B's exemptions) OR INSIDE `services/consultation-events/`
 *      (Scan E's exemption) — each is scanned by the OTHER ban (Scan E / Scan B respectively,
 *      per the disjointness property), never by both.
 * Layers 1 and 2 are unaffected by all four — they are property assertions over the matrix.
 *
 * ⚠ SCAN A IS VACUOUSLY TRUE ON MERGE, AND THAT IS INTENDED — said plainly here rather than
 * implied away, in the register of `../notifications/web-schedulable-policy.test.ts:25-29`.
 * `syncToken` / `sync_token` appears NOWHERE in the repo today outside the matrix module and
 * the `apiroc` skill's prose: the delta path was specified and never built, so the scan
 * currently catches nothing. It exists to become a LIVE TRIPWIRE the moment anyone writes a
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
 * claim to be. THIS IS ALSO WHY A REQUIRED marker (the Scan E shape gate) is checked the SAME
 * way: a comment claiming pagination happens is not evidence that it does.
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

/**
 * Every non-test, non-`.d.ts` TypeScript file under `apps/api/src` — `.ts` AND `.tsx`
 * (BAL-396 fix round 2, Finding 3: a `.ts`-only filter left every `.tsx` file, all 51 of them
 * under `notifications/channels/templates/`, unscanned) — as paths relative to it.
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
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    out.push(rel);
  }
  return out;
}

const ALL_SOURCE_FILES = collectSourceFiles(SRC_DIR, '');

/** True when `rel` equals, or falls under, one of `dirsOrFiles`. No regex (S5852). */
function isUnderAny(rel: string, dirsOrFiles: readonly string[]): boolean {
  return dirsOrFiles.some((entry) => rel === entry || rel.startsWith(entry));
}

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

describe('Layer 3 / Scan A — no module under apps/api reads or stores a sync token', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_A_EXEMPT));

  it('scans the full apps/api source surface (guards a vacuous pass)', () => {
    // 240+ non-test, non-`.d.ts` `.ts`/`.tsx` files today (190+ `.ts`, 51 `.tsx` — BAL-396 fix
    // round 2, Finding 3 widened the walk to include `.tsx`). A walk that resolved the wrong
    // directory, or silently returned [], would pass every absence assertion below for the
    // wrong reason. The floor is deliberately loose — this asserts "the walk ran", not a file
    // census.
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(200);
    expect(ALL_SOURCE_FILES).toContain('services/availability/vendor-busy.ts');
    expect(ALL_SOURCE_FILES).toContain(MATRIX_REL);
    // A genuine `.tsx` file — proves the walk really does pick up that extension now.
    expect(ALL_SOURCE_FILES).toContain(
      'notifications/channels/templates/calendar-reconnect-required.tsx'
    );
  });

  it('the exemption removed the matrix, and removed only what it claims to', () => {
    // ⚠ NOT `toBe(ALL_SOURCE_FILES.length - 1)`. That hardcodes "exactly one exempt file" while
    // SCAN_A_EXEMPT exempts the whole `invariants/` DIRECTORY, so adding any innocent helper in
    // here failed with a bare arithmetic mismatch and no explanation. The line below carries the
    // actual meaning; the count assertion only proves the filter is not a no-op.
    expect(scanned).not.toContain(MATRIX_REL);
    expect(
      ALL_SOURCE_FILES.length - scanned.length,
      'Scan A exempted nothing — `isUnderAny` has become a no-op, so the "the matcher fires on ' +
        'real repo content" control below is the only thing still proving the scan works.'
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
 * ⚠⚠ NEVER USE A BARE `provider` MARKER. Several sync-path files contain `vendorBusyProvider` /
 * `VendorBusyProvider` — THE PORT ITSELF, the abstraction the ruling depends on. A bare marker
 * would flag exactly the code that makes the invariant true.
 */
const PROVIDER_NAMES = ['google', 'microsoft', 'apple', 'icloud'] as const;
const PROVIDER_BRANCH_FORMS = ['provider ===', 'switch (provider'] as const;

/**
 * BAL-396 fix round 2, Finding 3 — the two idioms `PROVIDER_NAMES`' bare substring scan cannot
 * tell apart from a real provider literal: `templates/shared.tsx` and
 * `templates/review-email-shared.tsx`'s CSS font stack contains `fonts.googleapis.com`
 * (substring `google`) and `-apple-system` (substring `apple`), neither with any connection to
 * a calendar provider. Stripped before matching so Scan B keeps catching an actual `google` /
 * `apple` literal anywhere else, including elsewhere in these same two files — see the file
 * docblock for why this is narrower, and safer, than exempting the files outright.
 */
const KNOWN_SAFE_PROVIDER_SUBSTRINGS = ['googleapis', '-apple-system'] as const;

/** `text` with every occurrence of a known-safe substring removed. `split`/`join`, not regex
 *  (S5852) — exact substring removal, nothing pattern-based. */
function withoutKnownSafeProviderSubstrings(text: string): string {
  let out = text;
  for (const safe of KNOWN_SAFE_PROVIDER_SUBSTRINGS) {
    out = out.split(safe).join('');
  }
  return out;
}

/** Which known provider names a source's CODE lines name, case-insensitively — after removing
 *  the known-safe non-provider idioms above. */
function providerNamesIn(raw: string): string[] {
  const lower = withoutKnownSafeProviderSubstrings(codeLines(raw).toLowerCase());
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
 */
const EVENT_CONTENT_MARKERS = ['events.list', 'updatedAfter', 'expandRecurrences'] as const;

/** The two markers that are banned TREE-WIDE with NO exemption whatsoever — not even inside
 *  `CONSULTATION_EVENT_DIR`. There is no legitimate reason to differ an event read by
 *  timestamp or to expand recurrences anywhere in this codebase. */
const DELTA_SHAPE_MARKERS = ['updatedAfter', 'expandRecurrences'] as const;

/** The one directory ADR-1021 §2 sanctions for a full event-content read: Balo's OWN tagged
 *  consultation events (write / delete / reconcile-by-tag). Availability must never take this
 *  path — that is Scan C's job to keep true. */
const CONSULTATION_EVENT_DIR = 'services/consultation-events/';

/**
 * SCAN B's exemption set — where a PROVIDER LITERAL may legitimately appear.
 *
 * ⚠⚠ TREE-WIDE AS OF ADR-1021's 18 Aug 2026 (BAL-396) amendment §1, replacing the former
 * three-directory boundary. Provider conditionality now has EXACTLY TWO homes outside the
 * matrix and this directory, and is banned everywhere else under `apps/api/src`.
 */
const PROVIDER_SCAN_EXEMPT: readonly string[] = [
  MATRIX_REL, // the matrix declares the vocabulary it would be flagged for
  'invariants/', // guards must name what they forbid
  'lib/apiroc/', // THE VENDOR BOUNDARY — the SDK's uppercase ProviderType, and display labels
  'routes/calendar/', // THE CONNECT SURFACE — z.enum + the office365 translation
];

/**
 * SCAN E's exemption set — where a full EVENT-CONTENT READ may legitimately appear.
 *
 * ⚠ EXACTLY ONE ENTRY, AND IT IS DISJOINT FROM `PROVIDER_SCAN_EXEMPT` (asserted below). Growing
 * this list, or letting it overlap Scan B's, is exactly the hole this amendment closes — see
 * the file docblock's "two exemption sets are DISJOINT" note.
 */
const EVENT_CONTENT_SCAN_EXEMPT: readonly string[] = [CONSULTATION_EVENT_DIR];

const PROVIDER_SCAN_FILES: readonly string[] = ALL_SOURCE_FILES.filter(
  (rel) => !isUnderAny(rel, PROVIDER_SCAN_EXEMPT)
);

const EVENT_CONTENT_SCAN_FILES: readonly string[] = ALL_SOURCE_FILES.filter(
  (rel) => !isUnderAny(rel, EVENT_CONTENT_SCAN_EXEMPT)
);

describe('Layer 3 / Scan B — no provider literal outside the vendor boundary or the connect surface', () => {
  it('SYNC_PATH_FILES is a SUBSET of the scanned surface (none of it opts out)', () => {
    for (const rel of SYNC_PATH_FILES) {
      expect(ALL_SOURCE_FILES, `SYNC_PATH_FILES names ${rel}, which no longer exists`).toContain(
        rel
      );
      expect(
        PROVIDER_SCAN_FILES,
        `${rel} is a declared sync-path file but falls inside a Scan B exemption — it would be ` +
          `scanned by nothing.`
      ).toContain(rel);
    }
    // The walk really is tree-wide, not merely SYNC_PATH_FILES re-derived.
    expect(
      PROVIDER_SCAN_FILES.length,
      'The scanned set is no larger than SYNC_PATH_FILES — the directory walk contributed ' +
        'nothing, so a new file anywhere under apps/api/src would again go unscanned.'
    ).toBeGreaterThan(SYNC_PATH_FILES.length);
    // A concrete file the walk found and no list ever pinned.
    expect(PROVIDER_SCAN_FILES).toContain('jobs/worker.ts');
    // Newly covered surface, named in the file docblock — the walk really did widen.
    expect(PROVIDER_SCAN_FILES).toContain('notifications/channels/templates/index.ts');
    // BAL-396 fix round 2, Finding 3 — a GENUINE `.tsx` witness. `templates/index.ts` above is
    // the ONE `.ts` file in that directory; on its own it proved nothing about the other 50
    // `.tsx` templates (that was the defect this fix closes). This one is `.tsx`.
    expect(PROVIDER_SCAN_FILES).toContain(
      'notifications/channels/templates/calendar-reconnect-required.tsx'
    );
    expect(PROVIDER_SCAN_FILES).toContain('services/consultation-events/reconcile-by-tag.ts');
    // And the matrix, which names every provider by design, is out.
    expect(PROVIDER_SCAN_FILES).not.toContain(MATRIX_REL);
  });

  it('reads every subject, and no read is empty (guards a dead scan)', () => {
    for (const rel of PROVIDER_SCAN_FILES) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(0);
    }
  });

  it('the provider matcher fires on a file that DOES name providers (positive control)', () => {
    // `routes/calendar/auth.ts` carries `z.enum(['google', 'microsoft'])`. It is EXEMPT from
    // Scan B (the connect surface legitimately names both providers), but the matcher itself
    // must still fire on it, or the absence assertions below would prove nothing.
    expect(providerNamesIn(readRaw('routes/calendar/auth.ts'))).toEqual(['google', 'microsoft']);
  });

  it(
    '⚠ BAL-396 fix round 2 — the font-stack idioms are stripped, but a real provider literal ' +
      'sitting right next to one still fires (regression control for the .tsx false positive ' +
      'the widened walk surfaced)',
    () => {
      // The exact two idioms found in templates/shared.tsx and templates/review-email-shared.tsx.
      expect(providerNamesIn('fonts.googleapis.com/css2?family=DM+Sans')).toEqual([]);
      expect(providerNamesIn("'DM Sans', -apple-system, BlinkMacSystemFont")).toEqual([]);
      // The exemption is a substring removal, not a name removal — a genuine `google` / `apple`
      // sitting right next to the idiom must still trip the scan.
      expect(providerNamesIn('fonts.googleapis.com google')).toEqual(['google']);
      expect(providerNamesIn('-apple-system apple')).toEqual(['apple']);
    }
  );

  it(
    'the known-safe substrings really occur in the widened .tsx surface (guards a dead ' +
      'exemption — if these files ever stop containing the idiom, the exemption above would ' +
      'be exempting nothing)',
    () => {
      for (const rel of [
        'notifications/channels/templates/shared.tsx',
        'notifications/channels/templates/review-email-shared.tsx',
      ]) {
        const raw = codeLines(readRaw(rel)).toLowerCase();
        expect(
          KNOWN_SAFE_PROVIDER_SUBSTRINGS.some((safe) => raw.includes(safe)),
          `${rel} no longer contains a KNOWN_SAFE_PROVIDER_SUBSTRINGS idiom — narrow the exemption`
        ).toBe(true);
      }
    }
  );

  it.each([...PROVIDER_SCAN_FILES])('%s names no calendar provider', (rel) => {
    expect(
      providerNamesIn(readRaw(rel)),
      `${rel} names a calendar provider. Provider conditionality is banned outside ` +
        `lib/apiroc/ and routes/calendar/ (ADR-1021, 18 Aug 2026 amendment §1). A vendor lands ` +
        `inside vendorBusyProvider.listBusyBlocks and nowhere else. AMEND THE ADR FIRST.`
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

describe('Layer 3 / Scan E — no event-content read outside the consultation-event boundary', () => {
  it('scans the full tree; CONSULTATION_EVENT_DIR is the one exemption', () => {
    expect(ALL_SOURCE_FILES).toContain('services/consultation-events/reconcile-by-tag.ts');
    expect(EVENT_CONTENT_SCAN_FILES).not.toContain(
      'services/consultation-events/reconcile-by-tag.ts'
    );
    // Scan E is STRICTLY WIDER than the old shared boundary: lib/apiroc/ and routes/calendar/
    // — Scan B's exemptions — are themselves INSIDE Scan E's scanned set.
    expect(EVENT_CONTENT_SCAN_FILES).toContain('lib/apiroc/oauth.ts');
    expect(EVENT_CONTENT_SCAN_FILES).toContain('routes/calendar/auth.ts');
    // BAL-396 fix round 2, Finding 3 — a genuine `.tsx` witness (see Scan B's note above).
    expect(EVENT_CONTENT_SCAN_FILES).toContain(
      'notifications/channels/templates/calendar-reconnect-required.tsx'
    );
  });

  it('reads every subject, and no read is empty (guards a dead scan)', () => {
    for (const rel of EVENT_CONTENT_SCAN_FILES) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(0);
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

  // ── E1 — the two differencing/expansion markers are banned TREE-WIDE, no exemption ──────

  it(
    '⚠ E1 — NO file, anywhere, contains updatedAfter or expandRecurrences (not even inside ' +
      'CONSULTATION_EVENT_DIR)',
    () => {
      const offenders = ALL_SOURCE_FILES.filter(
        (rel) => markersInCode(readRaw(rel), DELTA_SHAPE_MARKERS).length > 0
      );
      expect(
        offenders,
        `These files reference updatedAfter or expandRecurrences. ADR-1021's 2026-08-15 ` +
          `amendment rejected timestamp-differenced / recurrence-expanded event reads EVERYWHERE, ` +
          `including inside services/consultation-events/ — that exemption covers a full read of ` +
          `Balo's own tagged events, never a delta one. AMEND THE ADR FIRST; do not allowlist:\n  ` +
          offenders.join('\n  ')
      ).toEqual([]);
    }
  );

  // ── E2 — events.list is banned everywhere except CONSULTATION_EVENT_DIR ──────────────────

  it('E2 — no file outside CONSULTATION_EVENT_DIR contains events.list', () => {
    const offenders = EVENT_CONTENT_SCAN_FILES.filter((rel) =>
      markersInCode(readRaw(rel), ['events.list']).includes('events.list')
    );
    expect(
      offenders,
      `These files read events.list outside services/consultation-events/. Availability must ` +
        `reach a vendor only through vendorBusyProvider.listBusyBlocks — a windowed free/busy ` +
        `read, never an event listing (apiroc skill, Constraint 4). AMEND THE ADR FIRST; do not ` +
        `allowlist:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  // ── E3 — the shape gate: an events.list inside the exemption must be filtered + paginated ─

  const consultationEventFiles = ALL_SOURCE_FILES.filter((rel) =>
    rel.startsWith(CONSULTATION_EVENT_DIR)
  );
  const consultationEventListFiles = consultationEventFiles.filter((rel) =>
    markersInCode(readRaw(rel), ['events.list']).includes('events.list')
  );

  it('E4 — non-vacuity: the exemption directory exists, is scanned, and actually uses events.list', () => {
    expect(consultationEventFiles.length).toBeGreaterThan(0);
    expect(
      consultationEventListFiles.length,
      'services/consultation-events/ contains no events.list call at all — the shape gate ' +
        'below would be asserting over an empty set and proving nothing.'
    ).toBeGreaterThan(0);
  });

  it.each([...consultationEventListFiles])(
    'E3 — %s reads events.list only tag-filtered AND paginated to exhaustion',
    (rel) => {
      const found = markersInCode(readRaw(rel), ['metadataFilters', 'nextPageToken']);
      expect(
        found,
        `${rel} calls events.list but is missing ${['metadataFilters', 'nextPageToken']
          .filter((m) => !found.includes(m))
          .join(
            ' and '
          )}. Inside services/consultation-events/, a listing read must be BOTH tag-filtered ` +
          `(metadataFilters) and paginated to exhaustion (follows nextPageToken) — never a bare ` +
          `listing. AMEND THE ADR FIRST.`
      ).toEqual(['metadataFilters', 'nextPageToken']);
    }
  );

  // ── E5 — positive control, retained verbatim ─────────────────────────────────────────────

  it("E5 — the shape gate's own matcher fires on a bare (unfiltered, unpaginated) listing", () => {
    const bareListing = [
      'export async function listAll(acct: string, cal: string) {',
      '  return client.events.list(acct, cal, {});',
      '}',
    ].join('\n');
    expect(markersInCode(bareListing, ['events.list'])).toEqual(['events.list']);
    expect(markersInCode(bareListing, ['metadataFilters', 'nextPageToken'])).toEqual([]);
  });

  // ── E6 — the two exemption sets are disjoint; every file is covered by at least one ban ──

  it('⚠ E6 — Scan B and Scan E exemptions are DISJOINT', () => {
    for (const entry of EVENT_CONTENT_SCAN_EXEMPT) {
      expect(
        PROVIDER_SCAN_EXEMPT,
        `${entry} is exempt from BOTH Scan B and Scan E — that is a hole, not a boundary.`
      ).not.toContain(entry);
    }
  });

  it('E6 — services/consultation-events/ is scanned by Scan B (it must name no provider)', () => {
    expect(consultationEventFiles.length).toBeGreaterThan(0);
    for (const rel of consultationEventFiles) {
      expect(PROVIDER_SCAN_FILES, `${rel} is unscanned by BOTH bans`).toContain(rel);
    }
  });

  it('E6 — lib/apiroc/ and routes/calendar/ are scanned by Scan E (they must read no event content)', () => {
    for (const dir of ['lib/apiroc/', 'routes/calendar/']) {
      const files = ALL_SOURCE_FILES.filter((rel) => rel.startsWith(dir));
      expect(files.length).toBeGreaterThan(0);
      for (const rel of files) {
        expect(EVENT_CONTENT_SCAN_FILES, `${rel} is unscanned by BOTH bans`).toContain(rel);
      }
    }
  });

  it('E6 — every source file is covered by at least one of the two bans', () => {
    const uncovered = ALL_SOURCE_FILES.filter(
      (rel) => !PROVIDER_SCAN_FILES.includes(rel) && !EVENT_CONTENT_SCAN_FILES.includes(rel)
    );
    expect(
      uncovered,
      `These files are exempt from BOTH Scan B and Scan E — an exemption has swallowed a hole ` +
        `instead of a boundary:\n  ${uncovered.join('\n  ')}`
    ).toEqual([]);
  });

  it.each([...EVENT_CONTENT_SCAN_FILES])('%s reads no event content', (rel) => {
    expect(
      markersInCode(readRaw(rel), EVENT_CONTENT_MARKERS),
      `${rel} reads calendar EVENT CONTENT. Availability must reach a vendor only through ` +
        `vendorBusyProvider.listBusyBlocks, which is a windowed free/busy read — busy slots, no ` +
        `titles (apiroc skill, Constraint 4). Full event reads are sanctioned only for Balo's ` +
        `OWN tagged consultation events, in services/consultation-events/. AMEND THE ADR FIRST.`
    ).toEqual([]);
  });
});

describe('Layer 3 / Scan C — availability reaches a vendor only as a windowed free/busy read', () => {
  it('the port makes a FREE/BUSY call (positive control — it is no longer a stub)', () => {
    expect(codeLines(readRaw('services/availability/vendor-busy.ts'))).toContain('freeBusy.get');
  });

  it('and reads no events there', () => {
    expect(
      markersInCode(readRaw('services/availability/vendor-busy.ts'), [
        ...EVENT_CONTENT_MARKERS,
        'events.create',
        'events.get',
      ])
    ).toEqual([]);
  });

  it('the shared loader is the ONE place the port is called (BAL-236 — extracted from the two former consumers)', () => {
    expect(codeLines(readRaw('services/availability/load-resolver-inputs.ts'))).toContain(
      'vendorBusyProvider.listBusyBlocks'
    );
    expect(
      markersInCode(readRaw('services/availability/load-resolver-inputs.ts'), [
        'freeBusy',
        'getApirocClient',
      ])
    ).toEqual([]);
  });

  /**
   * ⚠ THE TITLE ABOVE IS A CLAIM ABOUT THE WHOLE TREE, SO SCAN IT AS ONE. The first assertion
   * only proves the loader DOES call the port, and the next only proves two NAMED files do
   * not — a fourth file anywhere under `apps/api/src` could call it directly and both would
   * still pass. Scan B and Scan E do not cover this: they ban provider LITERALS and event-CONTENT
   * reads, not a bypass of the Balo-side port. `ALL_SOURCE_FILES` is already computed, so the
   * uniqueness claim costs one filter.
   */
  it('⚠ the port has EXACTLY ONE call site, tree-wide (not merely "not in these two files")', () => {
    const callers = ALL_SOURCE_FILES.filter((rel) =>
      codeLines(readRaw(rel)).includes('vendorBusyProvider.listBusyBlocks')
    );
    expect(
      callers,
      `The vendor free/busy port must be reached through the ONE shared loader. A second call ` +
        `site re-opens the drift the BAL-236 extraction closed: each copy decides its own ` +
        `fail-closed behaviour, and only one of them is scanned. AMEND THE ADR FIRST.`
    ).toEqual(['services/availability/load-resolver-inputs.ts']);
  });

  it('every consumer reads the SHARED loader, not its own vendor call (BAL-236)', () => {
    for (const rel of [
      'services/availability/resolve-and-cache.ts',
      'services/availability/window-availability.ts',
      // ⚠ BAL-236's own NEW third consumer. Omitting it left the ticket that added it as the
      // one file the scan did not look at.
      'services/availability/expert-slots.ts',
    ]) {
      expect(codeLines(readRaw(rel))).toContain('loadResolverInputs(');
      expect(
        markersInCode(readRaw(rel), [
          'vendorBusyProvider.listBusyBlocks',
          'freeBusy',
          'getApirocClient',
        ])
      ).toEqual([]);
    }
  });

  /**
   * ⚠ THE BYPASS THE SUBSTRING SCANS CANNOT SEE. `loadResolverInputs`'s 4th parameter,
   * `busyBlocksOverride`, short-circuits the vendor read entirely — it exists ONLY for
   * `resolve-and-cache.ts`'s seed-only `ResolveAndCacheOptions.busyBlocks`. Passing `[]` from
   * any other caller yields `busyOutcome = { ok: true, value: [] }`, so the booking gate would
   * answer "bookable" and the public route `ok` OVER an expert's real external commitments —
   * with every scan above still green, because the call site names `loadResolverInputs(`, not
   * the port. This is exactly the "do not re-inline `[]` at either call site" regression
   * `vendor-busy.ts` exists to prevent.
   *
   * ⚠ ARGUMENTS ARE COUNTED BY A PAREN-DEPTH WALK, NOT A REGEX. The obvious pattern
   * (`/loadResolverInputs\([^)]*,[^)]*,[^)]*,/s`) is quantified overlapping alternation of the
   * kind SonarCloud S5852 fails the gate on, and it would also mis-count any argument that
   * itself contains a `)`. The walk is linear and exact.
   */
  it('⚠ only the seed path may pass a busyBlocks override (the 4-argument form)', () => {
    const withOverride = ALL_SOURCE_FILES.filter(
      (rel) =>
        // The loader's own 4-parameter DECLARATION is not a call site.
        rel !== 'services/availability/load-resolver-inputs.ts' &&
        maxCallArity(codeLines(readRaw(rel)), 'loadResolverInputs(') >= 4
    );
    expect(
      withOverride,
      `A 4-argument \`loadResolverInputs(…, busyBlocksOverride)\` SKIPS the vendor read ` +
        `entirely and every other scan in this file stays green. It is sanctioned ONLY for ` +
        `resolve-and-cache.ts's seed path. AMEND THE ADR FIRST.`
    ).toEqual(['services/availability/resolve-and-cache.ts']);
  });
});

/**
 * The largest number of top-level arguments any `<open>` call in `code` is given, or 0 when the
 * call does not appear. Walks parenthesis depth and counts depth-1 commas; string and template
 * literals are not interpreted, which is safe here because the scanned call takes identifiers
 * and `Date`s. Deliberately regex-free (S5852) and linear in `code.length`.
 */
function maxCallArity(code: string, open: string): number {
  let best = 0;
  let from = code.indexOf(open);
  while (from !== -1) {
    let depth = 1;
    let args = 0;
    let sawToken = false;
    for (let i = from + open.length; i < code.length && depth > 0; i += 1) {
      const ch = code[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === ',' && depth === 1) args += 1;
      else if (depth === 1 && ch !== undefined && ch.trim() !== '') sawToken = true;
    }
    if (sawToken) best = Math.max(best, args + 1);
    from = code.indexOf(open, from + open.length);
  }
  return best;
}

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
 * `apps/api` by construction — see limitation (1) in the file docblock).
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

function occurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
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
