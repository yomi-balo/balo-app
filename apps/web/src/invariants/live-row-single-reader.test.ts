import { describe, expect, it } from 'vitest';
import { occurrences, resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-568 — structural invariant: **THE LIVE-ROW READ GOES THROUGH EXACTLY ONE FUNCTION.**
 * One READER. Not one read.
 *
 * ⚠⚠ THE DISTINCTION IS THE WHOLE POINT, AND AN EARLIER VERSION OF THIS HEADER GOT IT BACKWARDS
 * (corrected 2026-09-19, human review of PR #325). It claimed this file enforced a "read once"
 * MECHANISM via `React.cache()`. It does not, and `React.cache()` does not either:
 *
 *   · `React.cache()` memoizes **only inside a server-component render pass** — MEASURED under the
 *     `react-server` build by `lib/auth/live-user.react-server.test.ts`, which renders through the
 *     Flight server and pins both halves (two reads outside a render, ONE inside one). ⚠ The
 *     sibling `lib/auth/live-user.test.ts` cannot pin that half: under the default vitest project
 *     React's `cache` is a client-build pass-through, so its two-read assertion pins only that
 *     `readLiveUserRow` adds no memo of its own.
 *   · A Server Action runs BEFORE that render begins; a Route Handler never runs inside one. On
 *     both, every seam call is its own query.
 *   · So the 22 platform-gated staff actions **do** pay two primary-key reads (the liveness gate,
 *     then `actorHoldsPlatformCapability`). That is an ACCEPTED cost (user ruling, 2026-09-19),
 *     not a defect — do not restructure the read or add a request-scoped cache to "fix" it.
 *
 * ⚠ WHAT THIS FILE **DOES** ENFORCE, AND WHY IT IS STILL WORTH HAVING: every per-request consumer
 * reaches the row through `readLiveUserRow`, and nothing outside a small argued set calls
 * `usersRepository.findForSessionSync(` directly. That is a real property — it is what makes the
 * read swappable, cacheable or instrumentable in ONE place, and it is what would make a future
 * genuine dedupe a one-file change. It is a single point of access, not a count of round trips.
 *
 * ⚠ THE WALK IS UNFILTERED AND THE PINS ARE COMPARED, NEVER USED TO FILTER (the BAL-404 lesson).
 * Every non-test `.ts`/`.tsx` under `apps/web/src` is collected, and the set of modules calling
 * `usersRepository.findForSessionSync(` is compared against the exact expected set.
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

/** The ONE reader every per-request consumer goes through. */
const CACHED_READER = 'readLiveUserRow(';
/** The raw repository read it wraps. */
const RAW_READ = 'usersRepository.findForSessionSync(';

/** The module that defines the reader — the one place allowed to call the raw read. */
const READER_MODULE = 'lib/auth/live-user.ts';

/**
 * Per-request consumers of the live row. Each MUST go through the shared reader and MUST NOT call
 * the raw repository read — so the access point stays single, and (on a RENDER pass, where
 * `React.cache()` is live) they share one round trip.
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
    reason: 'It IS the shared reader — the one wrapper every other consumer goes through.',
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

describe('invariant: ONE reader function for the live row (BAL-568)', () => {
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

  it('C4: every per-request consumer reads through the shared reader, and never raw', () => {
    expect(CACHED_CONSUMERS).toHaveLength(4);
    for (const rel of CACHED_CONSUMERS) {
      const file = fileOf(rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(file.code.includes(CACHED_READER), `${rel} must call ${CACHED_READER}`).toBe(true);
      expect(
        occurrences(file.code, RAW_READ),
        `${rel} must not call ${RAW_READ} directly — the live row has ONE access point, which is ` +
          'what keeps it swappable and instrumentable in one file. (On a render pass it is also ' +
          'what lets these consumers share a round trip; outside one they do not — see the ' +
          'header.)'
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
