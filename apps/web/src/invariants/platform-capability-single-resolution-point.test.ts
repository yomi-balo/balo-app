import { describe, expect, it } from 'vitest';
import {
  findWorkspaceRoot,
  occurrences,
  scanWorkspaceSources,
  WORKSPACE_TREES,
} from './_source-scan';

/**
 * BAL-560 / ADR-1029 / ADR-1035 §A1.2 — structural invariant: **THE PLATFORM AXIS HAS ONE
 * RESOLUTION POINT, AND EVERY GATE GOES THROUGH IT WITH THE OVERRIDE ATTACHED.**
 *
 * `users.platform_capabilities` replaces the platform-role bundle per user. That is only true if
 * (a) nothing resolves the ROLE-ONLY predicate outside `@balo/shared`, (b) the override-aware
 * predicate has exactly the caller set this ticket reviewed, (c) nothing outside a tiny writer/
 * reader set touches the column or the session field, and (d) every file producing a
 * `SessionUser` in one of the FIVE SPELLINGS THIS PIN WATCHES is classified — row-backed (must
 * seal), argued-absent (must not), or a pass-through (builds nothing). Break any one and an
 * override silently fails OPEN to the role bundle on exactly one path — the hardest class of bug
 * to notice, because every other path keeps behaving correctly.
 *
 * ⚠⚠ **PIN D IS NEAR-VACUOUS AND IS KEPT ANYWAY.** `PLATFORM_ROLE_CAPABILITIES` has **zero**
 * production consumers today — it appears only in its own module, the barrel and tests — so the
 * ticket's AC "no call site reads `PLATFORM_ROLE_CAPABILITIES` directly" was ALREADY TRUE before
 * this PR. An invariant written against that half alone passes for the wrong reason. **The teeth
 * are in PIN A, PIN B, PIN C and the seal-point pin**: before this PR there were SIX production
 * callers of `platformRoleHasCapability` that would have bypassed the override entirely, plus a
 * seventh gate that hand-built a narrow actor and dropped it. Pin D is retained because "still
 * zero" is a fact worth holding, not because it is doing the work.
 *
 * ⚠⚠ **PIN B IS NOT ENOUGH ON ITS OWN, WHICH IS WHY `threadsTheOverride` EXISTS.** A gate that
 * calls `platformActorHasCapability` but passes no override behaves EXACTLY like the old
 * role-only one and would satisfy a caller-set pin while being permanently blind. Each seam is
 * therefore additionally asserted to NAME the override it threads.
 *
 * ⚠⚠ **DOCBLOCK MENTIONS DO NOT COUNT.** `codeLinesOf` strips comment lines, so
 * `route-config.ts`, `nav-registry.ts`, `engagement.ts` and `authorize-meeting-cancel.ts` naming
 * these symbols in prose neither breaks nor satisfies any pin. Verified at the time of writing.
 *
 * ⚠⚠ **THE WALK IS UNFILTERED OVER FIRST-PARTY SOURCE**, the same discipline as
 * `fast-forward-capability-dev-only.test.ts` (whose walk primitives this file shares, via
 * `_source-scan.ts`): every non-test `.ts`/`.tsx` file under `apps/*` and `packages/*` is
 * collected FIRST, and only then is each substring filter applied in memory. A new caller
 * dropped in anywhere — including `apps/api`, which is always a production process — is
 * collected and fails set equality loudly.
 *
 * If this test fails, DO NOT widen a list to make it green without reading which pin broke:
 *   · PIN A grew  → a gate went back to the ROLE-ONLY predicate and now ignores every override.
 *   · PIN B grew  → an eighth gate resolves the axis directly; route it through an app seam.
 *   · PIN C grew  → something reads the column or the session field outside the one writer;
 *                   hand it a ROW and let `session-platform-capabilities.ts` do the encoding.
 *   · a seam lost `threadsTheOverride` → the conversion went cosmetic; the gate is blind again.
 *   · the seal-point set changed → a new file produces a `SessionUser`. Classify it: spread
 *                   `sealedPlatformCapabilities(...)` if it builds from a row, or earn a written
 *                   argued-absent / pass-through entry. ⚠ The pin is LEXICAL and watches exactly
 *                   the five spellings in `SESSION_USER_CONSTRUCTION_TOKENS` — it is not, and
 *                   cannot be, a claim about every conceivable spelling.
 */

/** A — after BAL-560, NOTHING outside `@balo/shared` resolves the ROLE-ONLY predicate. */
const ROLE_ONLY_PREDICATE = 'platformRoleHasCapability';
const ROLE_ONLY_CALLERS: readonly string[] = [
  'packages/shared/src/authz/platform.ts', // the definition + platformActorHasCapability's NULL arm
  'packages/shared/src/authz/index.ts', // the barrel re-export
];

/** B — the OVERRIDE-AWARE predicate's exact caller set. */
const ACTOR_PREDICATE = 'platformActorHasCapability';
const ACTOR_CALLERS: readonly string[] = [
  'packages/shared/src/authz/platform.ts', // the definition
  'packages/shared/src/authz/index.ts', // the barrel
  'apps/web/src/lib/authz/platform.ts', // the WEB seam (session-sourced, D6)
  'apps/api/src/authz/platform.ts', // the API seam (live-row-sourced, D6)
  'apps/web/src/middleware.ts', // the EDGE gate — the ONE argued app-level direct caller
];

/**
 * C — the COLUMN / SESSION FIELD's exact reader+writer set.
 *
 * ⚠ EIGHT, and `session-sync.ts` is DELIBERATELY NOT AMONG THEM. It compares through
 * `platformOverrideKeyOf`, whose name carries no lowercase `platformCapabilities` substring —
 * see that function's docblock. The two sibling helpers (`sealedPlatformCapabilities`,
 * `applyPlatformCapabilitiesToSessionUser`) carry a capital `P` for the same reason, which is why
 * the six seal points and gate #7 are absent from this set too: none of them NAMES the field,
 * they hand a ROW to the one encoder. That is the property this pin is measuring.
 */
const OVERRIDE_FIELD = 'platformCapabilities';
const OVERRIDE_TOUCHERS: readonly string[] = [
  'packages/db/src/schema/users.ts', // the column
  'packages/db/src/repositories/users.ts', // the findForSessionSync projection
  'apps/web/src/lib/auth/session.ts', // the session field
  'apps/web/src/lib/auth/session-platform-capabilities.ts', // the ONE session writer/keyer
  'apps/web/src/lib/authz/platform.ts', // the web seam's read
  'apps/api/src/authz/platform.ts', // the api seam's read
  'apps/web/src/middleware.ts', // the EDGE gate reads it directly
  // ⚠ ADDED IN FIX ROUND 1 (review finding 3), AND IT IS A READ OF THE **ROW**, NOT OF A SESSION.
  // `resolveTestUser` refuses the E2E login outright when the derived fixture row carries a
  // non-NULL override, because merely declining to SEAL one is undone by drift-sync on the first
  // dashboard render. It is a two-sided NULL comparison, not a capability resolution — it never
  // asks what the override GRANTS — so it does not belong behind the encoder or the seam. This
  // pin catching it is the pin working: a new toucher has to be argued for, and here is the
  // argument.
  'apps/web/src/app/api/auth/test-login/route.ts',
];

/**
 * C2 — the SNAKE_CASE COLUMN NAME (fix round 1, review finding 12).
 *
 * PIN C watches the camelCase TypeScript property; a reader that reaches the column through raw
 * SQL — `sql`SELECT platform_capabilities …`` or a `db.execute` — names it in snake_case and
 * evades that pin entirely. The ticket's AC is worded about `users.platform_capabilities`, which
 * is this spelling, so it gets its own pin: exactly ONE non-test file may name the column, and it
 * is the schema that declares it.
 */
const OVERRIDE_COLUMN = 'platform_capabilities';
const OVERRIDE_COLUMN_NAMERS: readonly string[] = ['packages/db/src/schema/users.ts'];

/**
 * E — the NEW TOKEN's exact naming set (fix round 1, review finding 1).
 *
 * The token's own docblock claims it "is INERT in this ticket … pinned as a fact rather than
 * trusted" and points at THIS file. Before this pin that sentence was false: the invariant
 * contained zero references to the token. It is true now — exactly one non-test file names
 * `MANAGE_STAFF_CAPABILITIES`, and that file is its own definition plus the `super_admin` entry
 * of the role map. A second namer means something RESOLVES it, which is BAL-561's work and needs
 * the docblock's inertness claim re-argued rather than quietly widened.
 */
const NEW_TOKEN = 'MANAGE_STAFF_CAPABILITIES';
const NEW_TOKEN_VALUE = 'manage_staff_capabilities';
const NEW_TOKEN_NAMERS: readonly string[] = ['packages/shared/src/authz/platform.ts'];

/**
 * ⚠⚠ **THE WIRE-VALUE SET IS TWO, AND THE SECOND ENTRY IS A STORAGE RULE, NOT A RESOLUTION**
 * (fix round 3, R2).
 *
 * The CONSTANT spelling stays at ONE — that is the inertness claim, and it is what a resolver
 * would reach for. The wire VALUE now has a second namer because the
 * `users_platform_capabilities_staff_array` CHECK writes the literal into SQL:
 *
 *   NOT platform_capabilities @> '["manage_staff_capabilities"]'::jsonb
 *
 * ⚠ THAT IS DELIBERATELY NOT A WIDENING OF THE PIN'S MEANING. The pin asks "does anything
 * RESOLVE this token — does anything ask what it GRANTS". A CHECK constraint asks the opposite
 * question: which rows may STORE it (only a `super_admin` row may). It confers nothing, runs in
 * Postgres rather than in any gate, and cannot make the token live. The schema is also the one
 * place the rule CAN live: an override is deliberately unclamped on the read path, so refusing
 * the escalation in the resolver would reintroduce clamping.
 *
 * ⚠ A THIRD wire-value namer, or a SECOND constant namer, still means something resolves it —
 * BAL-561's work — and needs the docblock's inertness claim re-argued rather than quietly
 * widened. Do not add an entry here for a `.ts` gate.
 */
const NEW_TOKEN_VALUE_NAMERS: readonly string[] = [
  'packages/shared/src/authz/platform.ts', // the definition
  'packages/db/src/schema/users.ts', // the CHECK's SQL literal — a storage rule
];

/** D — the ROLE MAP's exact reader set (near-vacuous today; see the docblock). */
const ROLE_MAP = 'PLATFORM_ROLE_CAPABILITIES';
const ROLE_MAP_READERS: readonly string[] = [
  'packages/shared/src/authz/platform.ts',
  'packages/shared/src/authz/index.ts',
];

/**
 * Every way a `SessionUser` is PRODUCED in `apps/web` (D9 / OBJ-3).
 *
 * ⚠⚠ **WIDENED IN FIX ROUND 1 (review finding 2) BECAUSE THE ORIGINAL PAIR FAILED OPEN, AND IT
 * WAS DEMONSTRATED.** The pin used to watch only the two object-literal spellings below, so a
 * real file that built and returned a `SessionUser` as `): SessionUser {` — a legal, ordinary
 * spelling — was invisible to it: the reviewer dropped exactly such a file into the tree and the
 * invariant stayed 10/10 green. A lexical pin is only as good as its spelling list, and that is
 * a property this list has to state honestly rather than imply.
 *
 * ⚠ THIS LIST IS THE CLAIM. These four spellings are what is watched; `satisfies SessionUser`
 * is included although it matches nothing today, so the day someone reaches for it the file is
 * caught rather than silently exempt. A production spelling NOT on this list is NOT watched —
 * if you add one, add it here and re-derive the three classified sets below.
 */
const SESSION_USER_CONSTRUCTION_TOKENS: readonly string[] = [
  'session.user = {',
  ': SessionUser = {',
  '): SessionUser {',
  '): Promise<SessionUser> {',
  'satisfies SessionUser',
];

/** Seal points backed by a real DB row — each MUST spread the one encoder. */
const SEAL_POINTS_ROW_BACKED: readonly string[] = [
  'apps/web/src/app/api/auth/callback/route.ts',
  'apps/web/src/lib/auth/actions/sign-in.ts',
  'apps/web/src/lib/auth/impersonation-target.ts',
];

/**
 * ⚠⚠ **THE PER-FILE COUNT (fix round 3, R6). "CONTAINS A SEAL" IS NOT "SEALS EVERY BUILD".**
 *
 * The row-backed check used to assert only that each of the three files CONTAINS
 * `sealedPlatformCapabilities(` somewhere. A SECOND `SessionUser` construction added to any of
 * them — a new branch in `callback/route.ts` for a different WorkOS flow, a second literal in
 * `sign-in.ts` — would seal nothing and still pass, because the file's first construction keeps
 * the needle present. That is the D9 failure this whole pin exists to prevent, wearing the one
 * disguise the pin could not see: an override failing OPEN to the role bundle on exactly one
 * sign-in path while the other five behave.
 *
 * So the claim is now numeric and per file: CONSTRUCTIONS === SEALS === the number written here.
 * Same shape as `SESSION_USER_PASS_THROUGH_PROOFS` below, and for the same reason.
 *
 * ⚠ IF ONE OF THESE COUNTS CHANGES, A SESSION USER IS BEING BUILT IN A NEW PLACE. Do not bump the
 * number to make the suite green — go and look at the new construction and give it the encoder.
 * The equality is what carries the meaning; the literal is the non-vacuity guard that stops
 * `0 === 0` passing for a file that builds nothing at all.
 */
const SEAL_POINT_BUILD_COUNTS: readonly { readonly file: string; readonly count: number }[] = [
  { file: 'apps/web/src/app/api/auth/callback/route.ts', count: 1 },
  { file: 'apps/web/src/lib/auth/actions/sign-in.ts', count: 1 },
  { file: 'apps/web/src/lib/auth/impersonation-target.ts', count: 1 },
];

/**
 * Seal points that deliberately seal NOTHING, each with its argument written at the call site.
 * The first two mint `platform_role: 'user'`, which the `users_platform_capabilities_staff_array`
 * CHECK forbids from carrying an override at all. The third mints its role from a CLOSED persona
 * map so no database state can widen a test session — an override is an OPEN set that can widen
 * as well as narrow, so sealing one there would reintroduce exactly what the map prevents.
 */
const SEAL_POINTS_ARGUED_ABSENT: readonly string[] = [
  'apps/web/src/lib/auth/actions/sign-up.ts',
  'apps/web/src/lib/auth/actions/verify-email.ts',
  'apps/web/src/app/api/auth/test-login/route.ts',
];

/**
 * PASS-THROUGHS — they PRODUCE a `SessionUser` but BUILD none from a database row, so there is
 * nothing for them to seal and `sealedPlatformCapabilities` would be wrong in them:
 *   · `impersonation.ts`   — `markSessionAsImpersonated` SPREADS `...user` and adds three
 *                            impersonation fields; the override rides along untouched (plan S7).
 *   · `require-admin.ts`   — `requireAdmin()` returns the ALREADY-SEALED `session.user`.
 *   · `session.ts`         — `requireUser()` / `requireOnboardedUser()`, same.
 *
 * ⚠⚠ EACH ONE CARRIES A **POSITIVE, COUNT-PINNED PROOF** THAT IT IS STILL A PASS-THROUGH (fix
 * round 2, V1). An earlier cut asserted only that these files contain NO object-literal
 * construction, checked against the two `LITERAL_CONSTRUCTION_TOKENS` below — and that FAILED
 * OPEN, as the delta review demonstrated: replacing `require-admin.ts`'s `return session.user;`
 * with a row-shaped `return { … }` that seals no override left this suite 13/13 green.
 * TypeScript is no backstop, because `platformCapabilities` is OPTIONAL on `SessionUser`, so the
 * missing field compiles.
 *
 * Widening the negative list with `'return {'` would NOT work and was rejected: two of these
 * three files legitimately contain a return literal — `markSessionAsImpersonated` returns
 * `{ ...user, … }` (a spread, which carries the override), and `getCompanyContext` in
 * `session.ts` returns a three-field object that is not a `SessionUser` at all. A ban list would
 * have to carve both out, and would still only catch spellings it already knows.
 *
 * So the check is INVERTED. Each file declares the exact text that makes it a pass-through and
 * HOW MANY times that text must appear, and the suite asserts the count. The count is what gives
 * it teeth: `session.ts` has TWO pass-through returns (`requireUser` and `requireOnboardedUser`),
 * so a refactor that rebuilds the session user in just ONE of them takes the count to 1 and fails
 * — which a bare `toContain` would have missed. A positive proof cannot be evaded by reaching for
 * a construction spelling nobody listed.
 */
const SESSION_USER_PASS_THROUGH_PROOFS: readonly {
  readonly file: string;
  /** The verbatim text proving this file hands back an EXISTING session user. */
  readonly proof: string;
  /** How many times it must appear. Pinned to a literal — a count is the part with teeth. */
  readonly count: number;
}[] = [
  // Returns `{ ...user, isImpersonating, … }` — a SPREAD, so the override rides along untouched.
  { file: 'apps/web/src/lib/auth/impersonation.ts', proof: '...user,', count: 1 },
  // `requireAdmin()` hands back the already-sealed `session.user`.
  { file: 'apps/web/src/lib/auth/require-admin.ts', proof: 'return session.user;', count: 1 },
  // `requireUser()` AND `requireOnboardedUser()` — two of them, which is why the count matters.
  { file: 'apps/web/src/lib/auth/session.ts', proof: 'return user;', count: 2 },
];

const SESSION_USER_PASS_THROUGHS: readonly string[] = SESSION_USER_PASS_THROUGH_PROOFS.map(
  (entry) => entry.file
);

/**
 * The two spellings that BUILD a session user from a literal, as opposed to returning one.
 *
 * ⚠ DELIBERATELY NARROWER THAN `SESSION_USER_CONSTRUCTION_TOKENS`, and NOT the load-bearing part
 * of the pass-through check — see the ⚠⚠ note above. It is kept as a cheap second signal; the
 * count-pinned proofs are what actually hold the classification.
 */
const LITERAL_CONSTRUCTION_TOKENS: readonly string[] = ['session.user = {', ': SessionUser = {'];

const SEALER = 'sealedPlatformCapabilities(';

/** Each seam, and the text proving its conversion threads the override rather than being cosmetic. */
const THREADING_SEAMS: readonly {
  readonly file: string;
  readonly mustContain: readonly string[];
}[] = [
  {
    file: 'apps/web/src/lib/authz/platform.ts',
    mustContain: ['platformActorHasCapability(', 'user.platformCapabilities'],
  },
  {
    file: 'apps/api/src/authz/platform.ts',
    mustContain: ['platformActorHasCapability(', 'actor.platformCapabilities'],
  },
  {
    file: 'apps/web/src/middleware.ts',
    mustContain: ['platformActorHasCapability(', 'user.platformCapabilities'],
  },
  // The drift half: without these two the override goes stale for the full 7-day cookie
  // lifetime while the role stays in sync — worse than syncing neither.
  {
    file: 'apps/web/src/lib/auth/session-sync.ts',
    mustContain: ['platformOverrideKeyOf('],
  },
  {
    file: 'apps/web/src/app/api/auth/session-sync/route.ts',
    mustContain: ['applyPlatformCapabilitiesToSessionUser('],
  },
  // ⚠ THE TWO HAND-BUILT ACTORS. Every other seam above passes a whole `SessionUser`; these two
  // construct the actor object themselves from a LIVE row, so each must encode that row's
  // override itself or it silently resolves the role bundle alone — the conversion being
  // cosmetic in the one place it matters most.
  //
  // Gate #7 (addendum A1) — the impersonation entry point, the original of the shape.
  {
    file: 'apps/web/src/lib/auth/actions/impersonation.ts',
    mustContain: [SEALER],
  },
  // ⚠ ADDED IN FIX ROUND 3 (R5). `actorHoldsPlatformCapability` generalised gate #7's shape for
  // the fourteen mutating Server Actions converted in fix rounds 1 and 3, and it builds its own
  // actor object the same way — so it is a THREADING SEAM the pin was not watching. It is
  // invisible to PIN C by design (it names `sealedPlatformCapabilities`, capital `P`, not the
  // field), which is exactly why it needs an entry here: nothing else in this file would notice
  // it dropping the override and falling back to the role bundle for every staff mutation in
  // the app.
  {
    file: 'apps/web/src/lib/authz/live-platform-capability.ts',
    mustContain: [SEALER],
  },
];

describe('invariant: the platform capability axis has ONE resolution point (BAL-560)', () => {
  const scanned = scanWorkspaceSources();
  const filesNaming = (needle: string): string[] =>
    scanned.filter((file) => file.code.includes(needle)).map((file) => file.rel);

  /** Every file matching ANY watched `SessionUser`-producing spelling, and the classified union. */
  const producingSessionUsers = (): string[] =>
    scanned
      .filter((file) => SESSION_USER_CONSTRUCTION_TOKENS.some((token) => file.code.includes(token)))
      .map((file) => file.rel);
  const EXPECTED_PRODUCERS: readonly string[] = [
    ...SEAL_POINTS_ROW_BACKED,
    ...SEAL_POINTS_ARGUED_ABSENT,
    ...SESSION_USER_PASS_THROUGHS,
  ];

  it('scans the full workspace — both trees, thousands of files (guards against a vacuous pass)', () => {
    expect(findWorkspaceRoot()).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1500);

    // Every declared tree, PLUS `apps/api/src` by name: three of the seven converted gates live
    // there and it is ALWAYS a production process, so a walk covering `apps/web` and `packages`
    // only would look exactly as green as a correct one.
    const requiredPrefixes = [...WORKSPACE_TREES.map((tree) => `${tree}/`), 'apps/api/src/'];
    expect(requiredPrefixes, 'two trees plus the api prefix').toHaveLength(3);
    for (const prefix of requiredPrefixes) {
      const reached = scanned.filter((file) => file.rel.startsWith(prefix)).length;
      expect(reached, `the walk must reach ${prefix}`).toBeGreaterThan(50);
    }
  });

  it('PIN A: the ROLE-ONLY predicate is named by exactly the definition and the barrel (both directions + length)', () => {
    const found = filesNaming(ROLE_ONLY_PREDICATE).sort();
    expect(found).toEqual([...ROLE_ONLY_CALLERS].sort());
    expect(found).toHaveLength(2);
  });

  it('PIN B: the OVERRIDE-AWARE predicate has exactly the reviewed caller set (both directions + length)', () => {
    const found = filesNaming(ACTOR_PREDICATE).sort();
    expect(found).toEqual([...ACTOR_CALLERS].sort());
    expect(found).toHaveLength(5);
  });

  it('PIN C: the column / session field is touched by exactly the one writer and the readers (both directions + length)', () => {
    const found = filesNaming(OVERRIDE_FIELD).sort();
    expect(found).toEqual([...OVERRIDE_TOUCHERS].sort());
    expect(found).toHaveLength(8);
  });

  it('PIN C2: the snake_case COLUMN name is written by exactly the schema that declares it', () => {
    const found = filesNaming(OVERRIDE_COLUMN).sort();
    expect(found).toEqual([...OVERRIDE_COLUMN_NAMERS].sort());
    expect(found).toHaveLength(1);
  });

  it('PIN E: MANAGE_STAFF_CAPABILITIES is named by exactly its own definition — it is INERT', () => {
    // Both spellings: the CONSTANT and its wire VALUE. A raw-string resolution
    // (`=== 'manage_staff_capabilities'`) would evade a constant-only pin, and the wire value is
    // what a jsonb override and a sealed cookie actually carry.
    const byConstant = filesNaming(NEW_TOKEN).sort();
    expect(byConstant).toEqual([...NEW_TOKEN_NAMERS].sort());
    expect(byConstant).toHaveLength(1);

    // ⚠ TWO for the wire value, and the second is the CHECK's SQL literal — a STORAGE rule, not
    // a resolution. See `NEW_TOKEN_VALUE_NAMERS` for why that does not weaken the inertness
    // claim, and why a THIRD entry would.
    const byValue = filesNaming(NEW_TOKEN_VALUE).sort();
    expect(byValue).toEqual([...NEW_TOKEN_VALUE_NAMERS].sort());
    expect(byValue).toHaveLength(2);
  });

  it('PIN D: the role map has no production reader (near-vacuous, kept deliberately — see docblock)', () => {
    const found = filesNaming(ROLE_MAP).sort();
    expect(found).toEqual([...ROLE_MAP_READERS].sort());
    expect(found).toHaveLength(2);
  });

  it('every converted seam THREADS the override — the conversion is not cosmetic', () => {
    // Non-vacuity: the table is the size claimed, so an emptied table cannot pass this loop.
    expect(THREADING_SEAMS).toHaveLength(7);
    for (const seam of THREADING_SEAMS) {
      const file = scanned.find((candidate) => candidate.rel === seam.file);
      expect(file, `${seam.file} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      for (const needle of seam.mustContain) {
        expect(file.code, `${seam.file} must contain: ${needle}`).toContain(needle);
      }
    }
  });

  it('SEAL POINTS: exactly nine files produce a SessionUser, and each one is classified', () => {
    const producing = producingSessionUsers();
    expect(producing.sort()).toEqual([...EXPECTED_PRODUCERS].sort());
    expect(producing).toHaveLength(9);

    for (const rel of SEAL_POINTS_ROW_BACKED) {
      const file = scanned.find((candidate) => candidate.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      expect(file?.code, `${rel} is row-backed and MUST seal the override`).toContain(SEALER);
    }
    // ⚠ AND IT MUST SEAL **EVERY** BUILD, NOT JUST ONE (fix round 3, R6). See
    // `SEAL_POINT_BUILD_COUNTS` for why "contains a seal" fails open on a second construction.
    expect(SEAL_POINT_BUILD_COUNTS.map((entry) => entry.file)).toEqual([...SEAL_POINTS_ROW_BACKED]);
    for (const { file: rel, count } of SEAL_POINT_BUILD_COUNTS) {
      const file = scanned.find((candidate) => candidate.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      const builds = SESSION_USER_CONSTRUCTION_TOKENS.reduce(
        (total, token) => total + occurrences(file.code, token),
        0
      );
      const seals = occurrences(file.code, SEALER);
      expect(builds, `${rel} must build exactly ${count} SessionUser(s)`).toBe(count);
      expect(
        seals,
        `${rel} builds ${builds} SessionUser(s) but seals the override ${seals} time(s). ` +
          `EVERY row-backed construction must spread sealedPlatformCapabilities(...) — a new ` +
          `branch that omits it fails OPEN to the role bundle on exactly that one path.`
      ).toBe(builds);
    }
    for (const rel of SEAL_POINTS_ARGUED_ABSENT) {
      const file = scanned.find((candidate) => candidate.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      expect(
        file?.code,
        `${rel} is argued-absent and must NOT seal — re-read its call-site argument first`
      ).not.toContain(SEALER);
    }
    // ⚠ A pass-through that stops handing back an EXISTING session user is no longer a
    // pass-through, and would then owe a seal decision. The count-pinned positive proof is what
    // keeps the label honest — see this list's docblock for why the negative check alone failed
    // open (fix round 2, V1).
    expect(SESSION_USER_PASS_THROUGH_PROOFS).toHaveLength(3);
    for (const { file: rel, proof, count } of SESSION_USER_PASS_THROUGH_PROOFS) {
      const file = scanned.find((candidate) => candidate.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(
        occurrences(file.code, proof),
        `${rel} is classified a PASS-THROUGH: it must hand back an existing session user ` +
          `(${proof}) exactly ${count} time(s). If it now BUILDS one from a row, it owes a seal ` +
          `decision — spread sealedPlatformCapabilities(...) and reclassify it as row-backed.`
      ).toBe(count);
      for (const token of LITERAL_CONSTRUCTION_TOKENS) {
        expect(
          file.code,
          `${rel} is classified a PASS-THROUGH but builds a SessionUser literal (${token})`
        ).not.toContain(token);
      }
    }
  });

  it('⚠ guards the guard: a leak into ANY pin breaks set equality AND increments the length', () => {
    const cases: readonly {
      readonly label: string;
      readonly found: readonly string[];
      readonly expected: readonly string[];
    }[] = [
      { label: 'PIN A', found: filesNaming(ROLE_ONLY_PREDICATE), expected: ROLE_ONLY_CALLERS },
      { label: 'PIN B', found: filesNaming(ACTOR_PREDICATE), expected: ACTOR_CALLERS },
      { label: 'PIN C', found: filesNaming(OVERRIDE_FIELD), expected: OVERRIDE_TOUCHERS },
      { label: 'PIN D', found: filesNaming(ROLE_MAP), expected: ROLE_MAP_READERS },
      { label: 'PIN C2', found: filesNaming(OVERRIDE_COLUMN), expected: OVERRIDE_COLUMN_NAMERS },
      { label: 'PIN E', found: filesNaming(NEW_TOKEN), expected: NEW_TOKEN_NAMERS },
      {
        label: 'PIN E (value)',
        found: filesNaming(NEW_TOKEN_VALUE),
        expected: NEW_TOKEN_VALUE_NAMERS,
      },
    ];
    expect(cases).toHaveLength(7);

    for (const leak of [
      'apps/api/src/routes/leaked-platform-capability.ts',
      'packages/db/src/repositories/leaked-platform-capability.ts',
      'apps/web/src/app/somewhere-else/leaked-platform-capability.ts',
    ]) {
      for (const probe of cases) {
        const decoy = [...probe.found, leak].sort();
        expect(decoy, `${probe.label}: a leak at ${leak} must break set equality`).not.toEqual(
          [...probe.expected].sort()
        );
        expect(decoy).toHaveLength(probe.expected.length + 1);
      }
    }
  });

  it('⚠ guards the guard: a TENTH SessionUser producer breaks the seal-point pin', () => {
    const decoy = [
      ...producingSessionUsers(),
      'apps/web/src/app/api/auth/leaked-seal-point.ts',
    ].sort();

    expect(decoy).not.toEqual([...EXPECTED_PRODUCERS].sort());
    expect(decoy).toHaveLength(10);
  });

  it('⚠ guards the guard: EVERY watched spelling is one the filter genuinely matches', () => {
    // Non-vacuity for the spelling list itself. Four of the five spellings match real files
    // today; `satisfies SessionUser` matches none, and is included deliberately so the day
    // someone reaches for it the file is caught rather than silently exempt. Asserting that
    // distinction here stops a typo'd spelling — which would match nothing, forever — hiding in
    // the list and being mistaken for coverage.
    expect(SESSION_USER_CONSTRUCTION_TOKENS).toHaveLength(5);
    const matching = SESSION_USER_CONSTRUCTION_TOKENS.filter((token) =>
      scanned.some((file) => file.code.includes(token))
    );
    expect(matching).toEqual([
      'session.user = {',
      ': SessionUser = {',
      '): SessionUser {',
      '): Promise<SessionUser> {',
    ]);
    expect(matching).toHaveLength(4);
  });

  it('⚠ guards the guard: a row-backed seal point that does NOT seal is flagged', () => {
    // A synthetic seal point built exactly like `sign-in.ts` but WITHOUT the encoder. The
    // positive control for the `SEALER` assertion above: without this, that assertion could be
    // passing because every file trivially contains the substring somewhere.
    const decoyCode = [
      'const session = await getSession();',
      'session.user = {',
      '  id: user.id,',
      '  platformRole: user.platformRole,',
      '  companyId: membership.company.id,',
      '};',
    ].join('\n');

    expect(SESSION_USER_CONSTRUCTION_TOKENS.some((token) => decoyCode.includes(token))).toBe(true);
    expect(decoyCode).not.toContain(SEALER);
  });
});
