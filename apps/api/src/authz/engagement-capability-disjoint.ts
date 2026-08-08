/**
 * BAL-413 / ADR-1046 §6 — TYPE-LEVEL INVARIANT
 *
 * The ENTIRE `EngagementCapability` union is DISJOINT from the membership `Capability`
 * union. Enforced by the COMPILER, not by a lint rule (ADR-1046 §1). The consequence the
 * ADR actually cares about: `hasCapability(actor, 'host_meetings', { companyId })` — and
 * the same call with `'manage_engagement'` — does not type-check.
 *
 * ⚠ WHY THIS FILE LIVES IN `apps/api/src` AND IS IMPORTED BY NOTHING.
 * `@balo/shared` has NO `typecheck` script, so root `pnpm typecheck` never compiles it —
 * an assertion placed there is VACUOUSLY GREEN, and a type assertion in a `*.test.ts` is
 * doubly vacuous (vitest's esbuild strips types without checking them).
 * `apps/api/tsconfig.json` sets `"include": ["src/**\/*"]` with `"typecheck": "tsc --noEmit"`,
 * so EVERY file under `apps/api/src` is type-checked by the gate whether or not anything
 * imports it. Being imported by nothing is intentional and is safe HERE and nowhere else.
 *
 * A plain `.ts` — not a `.test.ts` — is used on purpose. `apps/api`'s `include` does also
 * match test files, but a reader cannot tell from a `.test.ts` whether an assertion is
 * held by `tsc` or by vitest, and vitest would strip it. The file name and this docblock
 * have to make the holding gate unambiguous.
 *
 * ⚠⚠ NON-VACUITY PROOF — a reviewer MUST be able to run this in under a minute:
 *   1. In `packages/shared/src/authz/index.ts`, add `HOST_MEETINGS: 'host_meetings',`
 *      to the `CAPABILITIES` object (i.e. deliberately VIOLATE the invariant).
 *   2. Run `pnpm --filter api typecheck`.
 *   3. It MUST FAIL, with BOTH:
 *        · TS2344 on `_EngagementTokensAreNotCapabilities`
 *          ("Type 'host_meetings' does not satisfy the constraint 'never'"), and
 *        · TS2578 "Unused '@ts-expect-error' directive" on the HOST_MEETINGS line below.
 *   4. Revert step 1 and re-run — it MUST pass again.
 * If step 3 PASSES, this gate is dead and the PR must not merge.
 * (Use `--filter api`, NOT `--filter web`: web's script is `check-types`, api's is
 * `typecheck`; a wrong filter or task name exits 0 vacuously. `apps/web`'s package name
 * is also the bare `web`, not `@balo/web`.)
 *
 * The captured failing output for this PR is in `.proof-bal-413.md` and the PR description.
 *
 * ⚠ THE LITERAL AC #1 / AC #12 SUBJECT LIVES ELSEWHERE, ON PURPOSE. `hasCapability`
 * itself is `apps/web`-only and `import 'server-only'`, so it is unreachable from here.
 * What IS asserted here is the same `Capability` TYPE that `hasCapability`'s `capability`
 * parameter is declared as — so these lines are load-bearing for that call site too. The
 * literal mirror, against the real `hasCapability`, is
 * `apps/web/src/invariants/engagement-capability-not-membership.test.ts`, held by
 * `pnpm --filter web check-types`. Both gates were falsified; neither is decorative.
 */
import {
  CAPABILITIES,
  ENGAGEMENT_CAPABILITIES,
  HOST_ROLES,
  hostRoleHasCapability,
  roleHasCapability,
  type Capability,
  type EngagementCapability,
} from '@balo/shared/authz';

/** Compiles only while `T` is exactly `never`. */
type AssertNever<T extends never> = T;

/** AC #14 — WHOLE-UNION disjointness, generalised: fails if ANY token leaks either way. */
export type _EngagementTokensAreNotCapabilities = AssertNever<
  Extract<EngagementCapability, Capability>
>;
export type _CapabilitiesAreNotEngagementTokens = AssertNever<
  Extract<Capability, EngagementCapability>
>;

/**
 * AC #1 / AC #12 — the call-site form, expressed against the exact types the real seams
 * consume. NEVER CALLED: it exists only so the compiler sees the expressions.
 * ⚠ Keep each asserted call on ONE line — `@ts-expect-error` applies to the next line only.
 */
export function __engagementCapabilityTypeInvariants(): void {
  // @ts-expect-error AC #1 — 'host_meetings' is NOT a membership Capability.
  roleHasCapability('owner', ENGAGEMENT_CAPABILITIES.HOST_MEETINGS);
  // @ts-expect-error AC #12 — 'manage_engagement' is NOT a membership Capability.
  roleHasCapability('owner', ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT);
  // @ts-expect-error The reverse — a membership token is not an EngagementCapability.
  hostRoleHasCapability(HOST_ROLES.DELIVERING_EXPERT, CAPABILITIES.MANAGE_MEMBERS);
}
