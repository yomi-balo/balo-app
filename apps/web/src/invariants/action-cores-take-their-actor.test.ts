import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-275 §9.2 (N10) — structural invariant for the five behaviour-preserving extractions in
 * `projects/[requestId]/_actions/_shared/*-core.ts`.
 *
 * The whole point of the extraction (§6.1 of the BAL-275 plan) is that the `requireOnboardedUser()`
 * gate stays byte-for-byte in the Server Action, and everything below it — including the ACTOR —
 * moves into a `_shared/<name>-core.ts` module that takes a `SessionUser` as a plain parameter. A
 * core that could instead re-derive "who is calling" from the request/cookie itself would silently
 * defeat the whole point of BAL-275's dev fast-forward: the fast-forward calls `runX(derivedActor,
 * input)` directly, never through the Server Action's own gate, so if a core secretly re-acquired
 * the REAL caller's identity (via `getSession()` and friends) instead of trusting its `user`
 * parameter, the fast-forward would silently act as the Balo-staff OPERATOR instead of the derived
 * expert/client actor it was asked to impersonate — a privilege-widening bug with no compiler error,
 * because `SessionUser` would still type-check.
 *
 * ⚠⚠ THE WALK IS UNFILTERED, DELIBERATELY — memory `project_bal404_engagement_admin_capability_shipped`
 * / the BAL-404 fix-round F2 finding this ticket's plan names by hand (§9.2, point 1). BAL-404's
 * FIRST version ran its scan through an allow-list BEFORE the `PINNED_FILES` set-equality assertion,
 * so a brand-new offending module dropped into the scanned directory was filtered out before the walk
 * ever saw it — the claim that `PINNED_FILES` was asserted "set-equal to the walk" was false, because
 * the walk itself had already been narrowed. Two independent reviewers proved it by dropping such a
 * file in and watching the suite stay green. `scanRouteSources(SHARED_DIR, 'shared', [])` below passes
 * an EMPTY exclusion list, so every non-test file `_actions/_shared/` contains is collected — the
 * five cores AND the five pre-existing helpers (`deadlock.ts`, `close-request-fanout.ts`,
 * `decline-track-stage.ts`, `assign-owner-fanout.ts`, `proposal-request-analytics.ts`) — and ONLY
 * THEN is the `*-core.ts` name filter applied, in-memory, on the already-collected set. A sixth
 * `*-core.ts` file dropped into this directory without being added to `PINNED_CORES` is collected by
 * the walk and fails the set-equality assertion loudly; it cannot be filtered out before the scan
 * runs, because nothing filters the scan itself.
 *
 * If this test fails:
 *   - a core references one of the banned identity primitives → move whatever needs the REAL caller
 *     back into the Server Action (the gate), or reconsider whether this extraction should exist;
 *   - a core lost its `run<X>(user: SessionUser, …)` shape → the action can no longer delegate the
 *     actor the fast-forward derives;
 *   - one of the five actions stopped calling `requireOnboardedUser()` or stopped importing its core
 *     → the byte-for-byte gate-stays-in-the-action contract (BAL-275 §6.1) broke;
 *   - a NEW `_shared/*-core.ts` file isn't in `PINNED_CORES` yet → add it, and confirm its action
 *     still gates before delegating.
 */

const SHARED_DIR = resolveRouteDir([
  'src/app/(dashboard)/projects/[requestId]/_actions/_shared',
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions/_shared',
]);
const ACTIONS_DIR = resolveRouteDir([
  'src/app/(dashboard)/projects/[requestId]/_actions',
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions',
]);

/**
 * The five core files this ticket ships, spelled out explicitly (not derived from a directory
 * listing at test time) so a module silently disappearing from the scan — a rename, a move, a
 * future `.filter` that narrows the walk again — fails LOUDLY instead of vanishing.
 */
const PINNED_CORES: readonly string[] = [
  'shared/accept-proposal-core.ts',
  'shared/mark-thread-read-core.ts',
  'shared/save-proposal-draft-core.ts',
  'shared/submit-eoi-core.ts',
  'shared/submit-proposal-core.ts',
];

/** The five Server Actions this ticket modified, and the core each must import + delegate to. */
const ACTION_TO_CORE_IMPORT: ReadonlyMap<string, string> = new Map([
  ['submit-eoi.ts', './_shared/submit-eoi-core'],
  ['save-proposal-draft.ts', './_shared/save-proposal-draft-core'],
  ['submit-proposal.ts', './_shared/submit-proposal-core'],
  ['accept-proposal.ts', './_shared/accept-proposal-core'],
  ['mark-thread-read.ts', './_shared/mark-thread-read-core'],
]);
const PINNED_ACTIONS: readonly string[] = [...ACTION_TO_CORE_IMPORT.keys()];

/**
 * Every primitive through which a core could re-acquire the REAL caller's identity instead of
 * trusting the `user: SessionUser` parameter it was handed. `requireOnboardedUser(` / `requireUser(`
 * / `withAuth(` are this route tree's own gate helpers; `getSession(` / `getCurrentUser(` are the
 * lower-level primitives those gates (and several other shipped actions) are built on — banning only
 * the three wrapper names would leave a core free to read the session directly and route around them.
 *
 * ⚠ S4 (security fix-round): `cookies(` / `headers(` are the Next.js primitives underneath ALL of
 * the above — a core reading `balo_session` straight off the cookie jar (or re-deriving identity
 * from a request header) would re-acquire the REAL caller while never calling any of the named
 * wrappers, passing every other assertion here. No core does this today; banned so one never can.
 */
const FORBIDDEN_IDENTITY_PRIMITIVES: readonly string[] = [
  'requireOnboardedUser(',
  'requireUser(',
  'getSession(',
  'getCurrentUser(',
  'withAuth(',
  'cookies(',
  'headers(',
];

const RUN_EXPORT_TOKEN = 'export async function run';
const ACTOR_PARAM_TOKEN = 'user: SessionUser';
const GATE_TOKEN = 'requireOnboardedUser()';

function scanSharedTree(): ScannedFile[] {
  // UNFILTERED — every file `_actions/_shared/` contains, not a pre-narrowed allow-list.
  return scanRouteSources(SHARED_DIR, 'shared', []);
}

function scanActionsTree(): ScannedFile[] {
  // UNFILTERED at the walk level too — the `_shared/` subtree is included by the recursive walk;
  // this suite only NEEDS the five pinned action files, but nothing narrows what gets scanned.
  return scanRouteSources(ACTIONS_DIR, 'actions', []);
}

describe('invariant: BAL-275 action cores take their actor as a parameter, never re-acquire it', () => {
  const sharedFiles = scanSharedTree();
  const coreFiles = sharedFiles.filter((file) => file.rel.endsWith('-core.ts'));
  const coreRelPaths = coreFiles.map((file) => file.rel);

  const actionsTree = scanActionsTree();
  const actionFiles = actionsTree.filter((file) =>
    PINNED_ACTIONS.includes(file.rel.slice('actions/'.length))
  );

  it('collects the trees (guards against a vacuous pass)', () => {
    expect(SHARED_DIR).not.toBe('');
    expect(ACTIONS_DIR).not.toBe('');
    // The unfiltered `_shared/` walk also picks up five PRE-EXISTING non-core helpers
    // (deadlock.ts, close-request-fanout.ts, decline-track-stage.ts, assign-owner-fanout.ts,
    // proposal-request-analytics.ts) — if the walk only ever found the five cores, that would be
    // a sign something upstream IS pre-filtering by name, which is exactly the BAL-404 bug this
    // test exists to rule out.
    expect(sharedFiles.length).toBeGreaterThan(PINNED_CORES.length);
  });

  it('collects exactly the five pinned cores from the UNFILTERED walk (both directions + length)', () => {
    expect(coreRelPaths.sort()).toEqual([...PINNED_CORES].sort());
    expect(coreRelPaths).toHaveLength(5);
  });

  it('collects exactly the five pinned actions', () => {
    const paths = actionFiles.map((file) => file.rel.slice('actions/'.length)).sort();
    expect(paths).toEqual([...PINNED_ACTIONS].sort());
    expect(actionFiles).toHaveLength(5);
  });

  it('each core exports a run<X>(user: SessionUser, …) function (non-vacuity: the real shape is found)', () => {
    for (const file of coreFiles) {
      expect(file.code, `${file.rel} must export an async run<X> function`).toContain(
        RUN_EXPORT_TOKEN
      );
      expect(file.code, `${file.rel} must take the actor as user: SessionUser`).toContain(
        ACTOR_PARAM_TOKEN
      );
    }
  });

  it('no core references a primitive that could re-acquire the REAL caller identity', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const token of FORBIDDEN_IDENTITY_PRIMITIVES) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These BAL-275 core modules reference a primitive that could re-acquire the caller's ` +
        `identity instead of trusting the passed-in actor. A core must NEVER call ` +
        `requireOnboardedUser / requireUser / getSession / getCurrentUser / withAuth:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('each pinned action gates with requireOnboardedUser() AND imports its own core', () => {
    for (const file of actionFiles) {
      const rel = file.rel.slice('actions/'.length);
      expect(file.code, `${rel} must call requireOnboardedUser()`).toContain(GATE_TOKEN);
      const coreImport = ACTION_TO_CORE_IMPORT.get(rel);
      expect(coreImport, `${rel} must be in ACTION_TO_CORE_IMPORT`).toBeDefined();
      if (coreImport !== undefined) {
        expect(file.code, `${rel} must import ${coreImport}`).toContain(coreImport);
      }
    }
  });

  it('⚠ guards the guard: a decoy core with getSession( is flagged; a decoy action missing requireOnboardedUser() is flagged', () => {
    const decoyCore: ScannedFile = {
      rel: 'shared/decoy-core.ts',
      code: [
        "import type { SessionUser } from '@/lib/auth/session';",
        "import { getSession } from '@/lib/auth/session';",
        '',
        'export async function runDecoy(user: SessionUser, input: unknown): Promise<unknown> {',
        '  const real = await getSession();',
        '  return real ?? user;',
        '}',
      ].join('\n'),
      raw: '',
    };
    // The decoy still satisfies the POSITIVE shape (run<X> + user: SessionUser) — that is the
    // point: a core can look right and still be wrong, which is exactly why the identity-primitive
    // ban is a SEPARATE assertion from the shape assertion.
    expect(decoyCore.code).toContain(RUN_EXPORT_TOKEN);
    expect(decoyCore.code).toContain(ACTOR_PARAM_TOKEN);
    const offenders = FORBIDDEN_IDENTITY_PRIMITIVES.filter((token) =>
      decoyCore.code.includes(token)
    );
    expect(offenders, `decoy core not caught: ${decoyCore.code}`).toEqual(['getSession(']);

    const decoyAction: ScannedFile = {
      rel: 'actions/decoy-action.ts',
      code: [
        "'use server';",
        "import { runDecoy } from './_shared/decoy-core';",
        '',
        'export async function decoyAction(input: unknown): Promise<unknown> {',
        '  return runDecoy(FAKE_USER, input);',
        '}',
      ].join('\n'),
      raw: '',
    };
    expect(
      decoyAction.code.includes(GATE_TOKEN),
      'decoy action was not supposed to contain the gate'
    ).toBe(false);
  });
});
