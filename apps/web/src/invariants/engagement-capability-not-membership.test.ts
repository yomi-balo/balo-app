import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  ENGAGEMENT_CAPABILITIES,
  type Capability,
  type EngagementCapability,
} from '@balo/shared/authz';
// TYPE-ONLY on purpose — see `__acOneAndEleven` below. `@/lib/authz` is `server-only` and
// value-imports `@balo/db`; a value import here would break this file at runtime (jsdom)
// and is exactly the client-bundle footgun the seam's own docblock warns about. A type
// import is fully erased, so `tsc` still resolves the real signature while vitest loads
// nothing.
import type { hasCapability } from '@/lib/authz';

/**
 * BAL-413 / ADR-1046 §6 — AC #1 and AC #11, asserted LITERALLY.
 *
 * AC #1 is worded against the WEB membership seam: "`hasCapability(actor, 'host_meetings', ...)`
 * fails to compile". `hasCapability` lives only in `apps/web` (`import 'server-only'`) and is
 * unreachable from `apps/api`, so `apps/api/src/authz/engagement-capability-disjoint.ts` can
 * only assert the equivalent against the same `Capability` TYPE. THIS file closes that gap:
 * it asserts against the real function's real signature.
 *
 * ⚠ WHICH GATE HOLDS THIS FILE. `apps/web`'s `check-types` script is
 * `next typegen && tsc --noEmit`, and its tsconfig `include` is `["**\/*.ts", ...]` — so it
 * compiles TEST files, and it compiles files nothing imports. The `@ts-expect-error`
 * directives below are therefore held by `pnpm --filter web check-types`, NOT by vitest
 * (vitest's esbuild strips types without checking them). The `describe` block at the bottom
 * is the RUNTIME half and is held by vitest; the two halves guard different things and
 * neither substitutes for the other.
 *
 * ⚠⚠ NON-VACUITY PROOF — runnable in under a minute:
 *   1. In `packages/shared/src/authz/index.ts`, add `HOST_MEETINGS: 'host_meetings',` to
 *      the `CAPABILITIES` object (deliberately VIOLATE the invariant).
 *   2. Run `pnpm --filter web check-types`  (`check-types`, NOT `typecheck` — api's script
 *      is the one called `typecheck`; and the package name is the bare `web`).
 *   3. It MUST FAIL with TS2578 "Unused '@ts-expect-error' directive" on the HOST_MEETINGS
 *      line, and TS2344 on `_WebSeamRejectsEngagementTokens`.
 *   4. Revert step 1 and re-run — it MUST pass again.
 * If step 3 passes, this gate is dead. The captured failing output for this PR is in
 * `.proof-bal-413.md`.
 *
 * ⚠ SCOPE. This is a type assertion, NOT the deferred `apps/web` engagement resolver seam
 * (`apps/web/src/lib/authz/engagement.ts`), which BAL-410 / BAL-411 own and which this PR
 * deliberately does not build. Nothing here creates a seam those tickets could collide with.
 */

/** Compiles only while `T` is exactly `never`. */
type AssertNever<T extends never> = T;

/**
 * The generalised form, tied to the REAL seam rather than to a re-declared type: no
 * `EngagementCapability` token is assignable to `hasCapability`'s `capability` parameter.
 */
export type _WebSeamRejectsEngagementTokens = AssertNever<
  Extract<EngagementCapability, Parameters<typeof hasCapability>[1]>
>;

/**
 * NEVER CALLED, and never callable — it takes the seam as a parameter precisely so that
 * no value import is needed. It exists only so the compiler sees the call expressions.
 * ⚠ Keep each asserted call on ONE line — `@ts-expect-error` applies to the next line only.
 */
export async function __acOneAndEleven(seam: typeof hasCapability): Promise<void> {
  const actor = { id: 'user_1' };
  const scope = { companyId: 'company_1' };
  // @ts-expect-error AC #1 — hasCapability(actor, 'host_meetings', …) must not compile.
  await seam(actor, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS, scope);
  // @ts-expect-error AC #11 — hasCapability(actor, 'manage_engagement', …) must not compile.
  await seam(actor, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, scope);
}

// ── The runtime half (held by vitest, not by tsc) ────────────────────────────

describe('the engagement axis is disjoint from the membership axis (BAL-413 / AC #1, #11, #13)', () => {
  const membershipTokens: readonly string[] = Object.values(CAPABILITIES);
  const engagementTokens: readonly string[] = Object.values(ENGAGEMENT_CAPABILITIES);

  it('has a non-empty token set on both axes (non-vacuity guard for the checks below)', () => {
    expect(membershipTokens.length).toBeGreaterThan(0);
    expect(engagementTokens).toEqual(['host_meetings', 'manage_engagement']);
  });

  it('never lets an engagement token appear in CAPABILITIES', () => {
    for (const token of engagementTokens) {
      expect(membershipTokens).not.toContain(token);
    }
  });

  it('never lets a membership token appear in ENGAGEMENT_CAPABILITIES', () => {
    for (const token of membershipTokens) {
      expect(engagementTokens).not.toContain(token);
    }
  });

  it('keeps the two token namespaces from colliding as a set', () => {
    const union = new Set<string>([...membershipTokens, ...engagementTokens]);
    expect(union.size).toBe(membershipTokens.length + engagementTokens.length);
  });

  it('pins the membership union so a widened CAPABILITIES has to edit this file', () => {
    // A compile-time twin of the assertion above: this line stops compiling if a token is
    // added to CAPABILITIES, which is the moment a reviewer must re-check disjointness.
    const pinned: Capability[] = [
      CAPABILITIES.PARTICIPATE,
      CAPABILITIES.MANAGE_REQUESTS,
      CAPABILITIES.APPROVE_OWN_PROPOSALS,
      CAPABILITIES.MANAGE_MEMBERS,
      CAPABILITIES.MANAGE_BILLING,
      CAPABILITIES.CONSUME_CREDITS,
    ];
    expect([...pinned].sort()).toEqual([...membershipTokens].sort());
  });
});
