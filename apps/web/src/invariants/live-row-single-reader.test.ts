import { describe, expect, it } from 'vitest';
import { occurrences, resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-568 — structural invariant: **THE PER-REQUEST LIVE-ROW READ HAPPENS THROUGH EXACTLY ONE
 * FUNCTION, AND THAT FUNCTION IS `React.cache()`'d.**
 *
 * ⚠⚠ WHY A SOURCE INVARIANT AND NOT A RUNTIME ONE. The ruling asks for a MECHANISM, not a
 * convention: the 22 platform-gated staff actions must not pay two round trips for the same row.
 * `React.cache()` supplies the dedupe — but it is a NO-OP outside a React request scope, vitest
 * included, so the dedupe itself is not unit-testable. What IS testable, and what actually keeps
 * the mechanism intact, is that every per-request consumer goes through the one cached reader.
 * A convention with nothing enforcing it is not a mechanism; this file is the enforcement.
 *
 * ⚠ THE WALK IS UNFILTERED AND THE PINS ARE COMPARED, NEVER USED TO FILTER (the BAL-404 lesson).
 * Every non-test `.ts`/`.tsx` under `apps/web/src` is collected, and the set of modules calling
 * `usersRepository.findForSessionSync(` is compared against the exact expected set.
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

/** The ONE cached reader. */
const CACHED_READER = 'readLiveUserRow(';
/** The raw repository read it wraps. */
const RAW_READ = 'usersRepository.findForSessionSync(';

/** The module that defines the cached reader — the one place allowed to call the raw read. */
const READER_MODULE = 'lib/auth/live-user.ts';

/**
 * Per-request consumers of the live row. Each MUST call the cached reader and MUST NOT call the
 * raw repository read, so all three share one round trip.
 */
const CACHED_CONSUMERS: readonly string[] = [
  // Every dashboard render.
  'lib/auth/session-sync.ts',
  // Every mutating Server Action, via `requireUser` / `withAuth` / `getCurrentUser`.
  'lib/auth/account-liveness.ts',
  // Every platform-gated staff action.
  'lib/authz/live-platform-capability.ts',
  // Every dashboard render, again — the workspace derivation reads the SAME row alongside three
  // others. It held its own `cache()` entry before BAL-568, so a render paid two round trips.
  'lib/workspaces/derive-workspaces.ts',
];

/**
 * The modules allowed to call `usersRepository.findForSessionSync(` DIRECTLY, each for a stated
 * reason. This is the complete set, asserted by exact equality — not a filter.
 */
const RAW_READ_ALLOWED: readonly { rel: string; reason: string }[] = [
  {
    rel: READER_MODULE,
    reason: 'It IS the cached reader — the one wrapper every other consumer goes through.',
  },
  {
    rel: 'app/api/auth/session-sync/route.ts',
    reason:
      'The Route Handler that REPAIRS the cookie. It must read the row it is about to write from, in its own request, and it is the only writer here — routing it through a per-request cache shared with a render would be a category error.',
  },
  {
    rel: 'lib/auth/actions/impersonation.ts',
    reason:
      'A deliberate rare-path re-read of BOTH the actor and the target. Routing it through the per-request cache would change nothing behaviourally and would break the `findForSessionSync(actor.id)` proof string that `platform-capability-live-gate.test.ts` pins this file on.',
  },
  {
    rel: 'app/dev/_lib/resolve-step-actor.ts',
    reason:
      'DEV-ONLY (the fast-forward harness, gated by FAST_FORWARD_ALLOWED_NODE_ENVS and pinned by fast-forward-capability-dev-only.test.ts). It deliberately re-resolves the actor from scratch rather than sharing any caller state, which is the property that keeps it from skipping a gate the real action would apply.',
  },
];
const RAW_READ_ALLOWED_RELS: readonly string[] = RAW_READ_ALLOWED.map((entry) => entry.rel);

describe('invariant: one cached live-row reader for the request (BAL-568)', () => {
  const scanned = scanRouteSources(SRC_DIR, '', []);
  const fileOf = (rel: string): ScannedFile | undefined =>
    scanned.find((candidate) => candidate.rel === rel);
  const rawReaders = scanned.filter((f) => f.code.includes(RAW_READ)).map((f) => f.rel);

  it('C1: scans the tree (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1000);
    expect(rawReaders.length).toBeGreaterThan(0);
  });

  it('C2: the cached reader exists and is React.cache()-wrapped', () => {
    const reader = fileOf(READER_MODULE);
    expect(reader, `${READER_MODULE} must exist`).toBeDefined();
    if (reader === undefined) return;
    expect(reader.code).toContain("import { cache } from 'react';");
    expect(reader.code).toContain('export const readLiveUserRow = cache(');
    expect(occurrences(reader.code, RAW_READ), 'the reader wraps exactly one raw read').toBe(1);
  });

  it('C3: ⚠ the cached reader must NOT import ./session — that edge would be a cycle', () => {
    const reader = fileOf(READER_MODULE);
    expect(reader).toBeDefined();
    if (reader === undefined) return;
    // `session.ts` imports the liveness gate, which imports this module. The reverse edge would
    // close the loop at the most load-bearing seam in the app.
    expect(reader.code).not.toContain("from './session'");
    expect(reader.code).not.toContain("from '@/lib/auth/session'");
  });

  it('C4: every per-request consumer reads through the cached reader, and never raw', () => {
    expect(CACHED_CONSUMERS).toHaveLength(4);
    for (const rel of CACHED_CONSUMERS) {
      const file = fileOf(rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(file.code.includes(CACHED_READER), `${rel} must call ${CACHED_READER}`).toBe(true);
      expect(
        occurrences(file.code, RAW_READ),
        `${rel} must not call ${RAW_READ} directly — it would be a SECOND round trip for the ` +
          'same row, which is exactly what the cached reader exists to prevent.'
      ).toBe(0);
    }
  });

  it('C5: the set of DIRECT raw readers is exactly the allowed set, both directions', () => {
    expect([...rawReaders].sort(REL_COMPARATOR)).toEqual(
      [...RAW_READ_ALLOWED_RELS].sort(REL_COMPARATOR)
    );
    expect(rawReaders).toHaveLength(4);
    for (const entry of RAW_READ_ALLOWED) {
      expect(
        entry.reason.length,
        `${entry.rel}: the reason must be a real sentence`
      ).toBeGreaterThan(20);
    }
  });
});
