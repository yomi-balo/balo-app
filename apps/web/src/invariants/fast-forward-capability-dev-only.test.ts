import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-275 §9.2 (N9) — structural invariant: the platform capability token
 * `FAST_FORWARD_REQUEST` (`packages/shared/src/authz/platform.ts`) has EXACTLY ONE consumer
 * anywhere under `apps/web/src`, and that consumer — the dev fast-forward's entry gate,
 * `apps/web/src/app/dev/_actions/fast-forward.ts` — carries all three of its load-bearing
 * clauses (§4.2): the production refusal FIRST, an authenticated+onboarded session, and the
 * platform-capability check itself.
 *
 * WHY THIS MATTERS: `FAST_FORWARD_REQUEST` confers nothing in production only because no
 * reachable production call site resolves it (the token's own docblock in `platform.ts` states
 * this as its production-inertness argument). That argument is only TRUE while the token has
 * exactly one consumer and that consumer refuses before production ever reaches the capability
 * check. A second consumer anywhere — even a read-only one — would widen a dev-only act-on-behalf
 * mechanism (§16 point 8 of the BAL-275 plan) onto a surface this ticket never reviewed for it.
 *
 * ⚠⚠ THE WALK IS UNFILTERED, DELIBERATELY — the same discipline as
 * `action-cores-take-their-actor.test.ts` (N10) and its own citation of the BAL-404 fix-round F2
 * finding: a scan that is narrowed to an allow-list BEFORE the set-equality assertion can pass
 * vacuously on a file the allow-list happened not to name. `scanRouteSources(SRC_DIR, '', [])`
 * below passes an EMPTY prefix and an EMPTY exclusion list, so every non-test `.ts`/`.tsx` file
 * under `apps/web/src` is collected, and ONLY THEN is the `FAST_FORWARD_REQUEST` substring
 * filter applied, in-memory, on the already-collected set. A second consumer dropped in anywhere
 * — a page, a component, another Server Action — is collected by the walk and fails the
 * set-equality assertion loudly; it cannot be filtered out before the scan runs, because nothing
 * filters the scan itself.
 *
 * If this test fails:
 *   - a second file references `FAST_FORWARD_REQUEST` → either that reference is a mistake
 *     (route it through the existing gate instead of re-resolving the capability), or the
 *     widening is deliberate, in which case update `EXPECTED_CONSUMERS` here AND re-read
 *     `platform.ts`'s docblock, because its "confers nothing in production" argument now needs
 *     re-justifying against a second call site;
 *   - `fast-forward.ts` lost one of its three gate clauses → the entry gate no longer refuses
 *     production / an unauthenticated session / a non-staff session the way §4.2 requires.
 */

const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);

const TOKEN = 'FAST_FORWARD_REQUEST';
const EXPECTED_CONSUMER = 'app/dev/_actions/fast-forward.ts';

/**
 * §4.2's three gate clauses, verbatim, in the order they must run. Pinned as exact substrings
 * (memory `feedback_monitor_strings_need_verbatim_pin`) — not a looser "mentions the env check"
 * check, which would pass on a clause checking it the wrong way around.
 *
 * ⚠ S1 FIX-ROUND (security finding S1): the first clause used to be the deny-list
 * `process.env.NODE_ENV === 'production'`, which fails OPEN on an unset/misspelt/overridden
 * `NODE_ENV`. It was replaced with the allow-list form already used by
 * `apps/api/src/services/seed/truncate.ts`. Re-pinned to that new literal — the invariant must
 * track whichever form is actually live in `fast-forward.ts`, never the old one.
 *
 * The "contains all three gate clauses" test below destructures this array by NAME
 * (`envClause` / `identityClause` / `capabilityClause`), so its order assertions read as
 * "identity resolution must run after the environment refusal" rather than as bare array
 * indices.
 */
const GATE_CLAUSES: readonly string[] = [
  'FAST_FORWARD_ALLOWED_NODE_ENVS.includes(',
  'requireOnboardedUser(',
  'hasPlatformCapability(',
];

/** `export async function ...` — every Server Action this file exports. */
const EXPORTED_ACTION_TOKEN = 'export async function';
/** The ONE call site every exported action must route through before doing anything else. */
const GATE_CALL_TOKEN = 'await resolveFastForwardOperator()';
/**
 * Non-vacuity pin for the count assertion below — today there are exactly 3 exported actions
 * and exactly 3 gate calls. A fourth of either without a matching fourth of the other must fail.
 */
const EXPECTED_GATE_CALL_COUNT = 3;

/** Occurrences of `needle` in `haystack` — same pattern as `balo-panel-capability-gated.test.ts`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function scanFullTree(): ScannedFile[] {
  // UNFILTERED — every non-test source file under apps/web/src, not a pre-narrowed allow-list.
  return scanRouteSources(SRC_DIR, '', []);
}

describe('invariant: FAST_FORWARD_REQUEST has exactly one consumer, and it gates dev-only (BAL-275)', () => {
  const scanned = scanFullTree();
  const mentioningFiles = scanned
    .filter((file) => file.code.includes(TOKEN))
    .map((file) => file.rel);

  it('scans the full apps/web/src surface (guards against a vacuous pass)', () => {
    expect(SRC_DIR).not.toBe('');
    // The whole app is many hundreds of source files; a walk that found nothing (a bad
    // SRC_DIR resolution) would pass every assertion below for the wrong reason.
    expect(scanned.length).toBeGreaterThan(80);
  });

  it('the set of files mentioning FAST_FORWARD_REQUEST is EXACTLY the entry-gate file (both directions + length)', () => {
    expect(mentioningFiles.sort()).toEqual([EXPECTED_CONSUMER]);
    expect(mentioningFiles).toHaveLength(1);
  });

  it('the entry-gate file contains all three gate clauses, IN ORDER, and every exported action reaches the gate (non-vacuity: each is asserted individually)', () => {
    const gateFile = scanned.find((file) => file.rel === EXPECTED_CONSUMER);
    expect(gateFile, `${EXPECTED_CONSUMER} must be in the scan set`).toBeDefined();
    if (gateFile === undefined) return;

    for (const clause of GATE_CLAUSES) {
      expect(gateFile.code, `${EXPECTED_CONSUMER} must contain: ${clause}`).toContain(clause);
    }

    // S2 (order): the three `toContain` checks above pass no matter WHERE each clause sits —
    // a gate that resolved identity/capability before the environment refusal would still pass
    // them. Assert the actual document order with `indexOf` instead.
    const [envClause, identityClause, capabilityClause] = GATE_CLAUSES;
    if (envClause === undefined || identityClause === undefined || capabilityClause === undefined) {
      throw new Error('GATE_CLAUSES must have exactly three entries');
    }
    const envIndex = gateFile.code.indexOf(envClause);
    const identityIndex = gateFile.code.indexOf(identityClause);
    const capabilityIndex = gateFile.code.indexOf(capabilityClause);
    expect(envIndex, `${envClause} must be present`).toBeGreaterThanOrEqual(0);
    expect(
      identityIndex,
      `"${identityClause}" must run AFTER "${envClause}" — the environment refusal must come first`
    ).toBeGreaterThan(envIndex);
    expect(
      capabilityIndex,
      `"${capabilityClause}" must run AFTER "${identityClause}" — identity must be resolved before the capability check`
    ).toBeGreaterThan(identityIndex);

    // S2 (coverage): the assertions above only prove the clauses exist SOMEWHERE in the file,
    // not that EVERY exported action reaches them — a fourth exported action added without the
    // `resolveFastForwardOperator()` call would leave everything above green. Pin both counts
    // to the literal 3 (non-vacuity — two counts merely equal to EACH OTHER would pass at
    // 0 === 0 just as readily as at the real 3 === 3), then require the two counts to match.
    const exportCount = countOccurrences(gateFile.code, EXPORTED_ACTION_TOKEN);
    const gateCallCount = countOccurrences(gateFile.code, GATE_CALL_TOKEN);
    expect(exportCount, `expected exactly ${EXPECTED_GATE_CALL_COUNT} exported actions`).toBe(
      EXPECTED_GATE_CALL_COUNT
    );
    expect(gateCallCount, `expected exactly ${EXPECTED_GATE_CALL_COUNT} gate calls`).toBe(
      EXPECTED_GATE_CALL_COUNT
    );
    expect(
      exportCount,
      'every exported action must reach the gate exactly once — no extra export, no extra call'
    ).toBe(gateCallCount);
  });

  it('⚠ guards the guard: three decoys, each missing exactly one clause, are each flagged', () => {
    const decoys: readonly { readonly label: string; readonly code: string }[] = [
      {
        label: 'missing the production check',
        code: [
          'async function resolveFastForwardOperator() {',
          '  const user = await requireOnboardedUser();',
          '  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)) return null;',
          '  return user;',
          '}',
        ].join('\n'),
      },
      {
        label: 'missing requireOnboardedUser(',
        code: [
          'async function resolveFastForwardOperator() {',
          "  if (!FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')) return null;",
          '  const user = await getSession();',
          '  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)) return null;',
          '  return user;',
          '}',
        ].join('\n'),
      },
      {
        label: 'missing hasPlatformCapability(',
        code: [
          'async function resolveFastForwardOperator() {',
          "  if (!FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')) return null;",
          '  const user = await requireOnboardedUser();',
          '  return user;',
          '}',
        ].join('\n'),
      },
    ];

    for (const decoy of decoys) {
      const missing = GATE_CLAUSES.filter((clause) => !decoy.code.includes(clause));
      expect(missing.length, `decoy "${decoy.label}" not caught: ${decoy.code}`).toBeGreaterThan(0);
    }
  });

  it('⚠ guards the guard: a second file mentioning FAST_FORWARD_REQUEST would break set equality', () => {
    const decoyMentioning = [...mentioningFiles, 'app/somewhere-else/leaked-capability.ts'].sort();
    expect(decoyMentioning).not.toEqual([EXPECTED_CONSUMER]);
    expect(decoyMentioning).toHaveLength(2);
  });
});
