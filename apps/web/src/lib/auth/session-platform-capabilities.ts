import { isPlatformCapability, type PlatformCapability } from '@balo/shared/authz';
import type { SessionUser } from './session';

/**
 * BAL-560 — the THREE operations on `SessionUser.platformCapabilities`, and the only code in
 * `apps/web` that names the field outside the one read seam.
 *
 * ⚠ WHY A MODULE RATHER THAN A LINE AT EACH SEAL POINT. Six `SessionUser` constructions plus a
 * drift comparison plus a sync patch have to agree on ONE encoding (absent ⇔ no override). A
 * single missed site fails OPEN to the role bundle on exactly one auth path — the hardest class
 * of bug to notice, because five of six sign-in routes would behave correctly. Every call site
 * hands this module a ROW (or a session user) and never the property, so a rename cannot be
 * half-applied and the invariant's reader-set stays small enough to pin exactly.
 *
 * NO `'server-only'` — it is pure, and its only `SessionUser` import is TYPE-only (the
 * `lib/authz/platform.ts` precedent, which is what keeps that module Edge- and client-safe).
 * `isPlatformCapability` comes from `@balo/shared/authz`, which is pure and dependency-free by
 * contract, so the value import does not change that property.
 */

/** A row or session user carrying the raw override. `unknown` — neither jsonb nor a cookie validates. */
interface CarriesPlatformCapabilities {
  readonly platformCapabilities?: unknown;
}

/**
 * THE one normalisation, applied to BOTH the value that gets SEALED and the value that gets
 * KEYED for drift. `null` means "no override — inherit the role bundle".
 *
 * ⚠⚠ **FILTERED AND DE-DUPLICATED, AND BOTH HALVES ARE LOAD-BEARING (fix round 1, security F1 /
 * review finding 4).**
 *
 * FILTER: a token that is not on the axis confers nothing — `resolvePlatformCapabilities` drops
 * it on the read path regardless — so sealing it spends cookie bytes on a value that cannot
 * grant anything.
 *
 * DE-DUPLICATE: this is the one that closes a real LOCKOUT. The axis holds 17 distinct tokens,
 * but nothing stopped a row from carrying `['view_platform_admin', 'view_platform_admin', …]`
 * any number of times; a measured 26-entry override seals to 4097 bytes — ONE byte past the
 * 4096-byte browser cliff (30 entries is 4289) — at which point the browser SILENTLY DISCARDS
 * the `Set-Cookie` and the user is locked out with no server-side error. The measurements are
 * computed in `session-cookie-size.test.ts:244-245`; everywhere else quotes them. The DB CHECK
 * `users_platform_capabilities_staff_array` bounds the column at 17 entries; this is the same
 * bound enforced on the value that actually reaches the cookie.
 *
 * ⚠⚠ **IT IS SHARED WITH `platformOverrideKeyOf` ON PURPOSE, AND FILTERING WITHOUT THAT WOULD BE
 * A REGRESSION, NOT A FIX.** `checkSessionDrift` compares the key of the SEALED session against
 * the key of the RAW DB row. If the seal path normalised and the key path did not, a row holding
 * a duplicate or an unknown token would produce a key that the session it was sealed from can
 * never match — `sync-needed` on every render, forever: an infinite redirect storm traded for
 * the lockout. Routing both through this one function is what makes the two sides converge.
 */
function normalizedOverrideOf(source: CarriesPlatformCapabilities): PlatformCapability[] | null {
  const stored = source.platformCapabilities;
  if (!Array.isArray(stored)) return null;
  return [...new Set(stored.filter(isPlatformCapability))];
}

/**
 * The `SessionUser` fragment to SPREAD into a freshly-built session user. `{}` — the field
 * ABSENT — whenever the source has no usable array (D4). Never `{ platformCapabilities: null }`.
 *
 * The array it seals is NORMALISED (see `normalizedOverrideOf`), never the raw stored value.
 * No cast: the filter is a type guard, so the result is `PlatformCapability[]` by narrowing
 * rather than by assertion.
 */
export function sealedPlatformCapabilities(source: CarriesPlatformCapabilities): {
  platformCapabilities?: PlatformCapability[];
} {
  const normalized = normalizedOverrideOf(source);
  return normalized === null ? {} : { platformCapabilities: normalized };
}

/**
 * Patch an EXISTING session user from a fresh DB row (the session-sync route).
 *
 * ⚠ THE `delete` ARM IS NOT SYMMETRY FOR ITS OWN SAKE. A REVOKED override must LEAVE the
 * cookie. An assign-only patch would let a cleared override survive for the full seven days on
 * a session that keeps passing the drift check on every other field — the precise failure D9
 * exists to prevent, inverted.
 */
export function applyPlatformCapabilitiesToSessionUser(
  user: Pick<SessionUser, 'platformCapabilities'>,
  source: CarriesPlatformCapabilities
): void {
  const sealed = sealedPlatformCapabilities(source);
  if (sealed.platformCapabilities === undefined) {
    delete user.platformCapabilities;
    return;
  }
  user.platformCapabilities = sealed.platformCapabilities;
}

/**
 * The comparison KEY for drift. Mirrors `activeWorkspaceKeyOf`
 * (`lib/workspaces/session-workspace.ts`) — the repo's own pattern for "the single reader of the
 * session's X shape": `checkSessionDrift` then compares two primitives and nothing
 * hand-destructures an array (it also yields a plain `string | null`, which narrows without a
 * non-null assertion — memory `reference_sonar_nonnull_false_positive`).
 *
 * `null` for absent / SQL NULL / any non-array, so "the cookie has no field" and "the column is
 * NULL" are ONE state and a pre-BAL-560 cookie does not report permanent drift.
 *
 * SORTED: a pure REORDER is not drift. An order-sensitive comparison would still converge (the
 * sync route patches session←DB verbatim, so one round makes them identical), but it would
 * spend a redirect on a non-change.
 *
 * ⚠⚠ **NORMALISED THROUGH `normalizedOverrideOf`, THE SAME FUNCTION THE SEAL PATH USES — this is
 * what makes filtering at seal time SAFE (fix round 1, review finding 4).** One side is a SEALED
 * session (already normalised) and the other is a RAW DB row (not). Comparing a normalised
 * session against a raw row would report drift forever on any row carrying a duplicate or an
 * unknown token: sync → patch → still different → sync, an infinite redirect storm. Both sides
 * go through one normaliser, so the keys converge on the first render. Do not "simplify" either
 * side to read the raw value.
 *
 * ⚠ NAMED `platformOverrideKeyOf`, NOT `platformCapabilitiesKeyOf`, DELIBERATELY. The
 * invariant's field pin (`invariants/platform-capability-single-resolution-point.test.ts`,
 * PIN C) collects every non-test file whose CODE contains the lowercase substring
 * `platformCapabilities`. A keyer spelled with that substring would put `session-sync.ts` into
 * the pinned reader set for a purely cosmetic reason and blunt the pin's meaning ("who touches
 * the field"). The two sibling exports are safe for the same reason —
 * `sealedPlatformCapabilities` / `applyPlatformCapabilitiesToSessionUser` carry a CAPITAL `P`
 * and do not contain the substring. Do not rename any of the three without re-deriving PIN C.
 */
export function platformOverrideKeyOf(source: CarriesPlatformCapabilities): string | null {
  const normalized = normalizedOverrideOf(source);
  if (normalized === null) return null;
  // ⚠ THE COMPARATOR IS NOT OPTIONAL. A bare `.sort()` coerces every element to a string and
  // orders by UTF-16 code unit — SonarCloud rates that a RELIABILITY bug (S2871, "Provide a
  // compare function to avoid sorting elements alphabetically"), and ONE of them is enough to
  // drop the new-code reliability rating to D and fail the quality gate. These are lowercase
  // snake_case tokens, so `localeCompare` is stable and locale-independent over the alphabet.
  // Same shape as `sortIds` in `packages/db/src/repositories/_shared/consultation-projection.ts`.
  return JSON.stringify([...normalized].sort((a, b) => a.localeCompare(b)));
}
