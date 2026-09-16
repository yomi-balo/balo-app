import {
  decodeSealedPlatformCapabilities,
  encodeSealedPlatformCapabilities,
  isPlatformCapability,
  type PlatformCapability,
  type SealedPlatformCapabilityIndexes,
} from '@balo/shared/authz';
import type { SessionUser } from './session';

/**
 * BAL-560 — the operations on `SessionUser.platformCapabilities` (seal, patch, and the two
 * drift keyers below), and the only code in `apps/web` that names the field outside the one
 * read seam.
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
 * DE-DUPLICATE: this is the one that closes a real LOCKOUT. The axis holds a small fixed set of
 * distinct tokens, but nothing stopped a row from carrying `['view_platform_admin', 'view_platform_admin', …]`
 * any number of times; a measured 26-entry RAW-STRING override seals to 4097 bytes — one byte
 * past the 4096-byte browser cliff — at which point the browser SILENTLY DISCARDS the
 * `Set-Cookie` and the user is locked out with no server-side error. The measurement is in
 * `session-cookie-size.test.ts`, the test titled "PROOF OF THE REASON (F1): a DUPLICATE-heavy
 * override blows the cliff RAW, and is bounded by the encoder". The DB CHECK
 * `users_platform_capabilities_staff_array` bounds the column at 64 entries — deliberate slack
 * rather than the axis size (fix round 3, R8) — and THIS is the mechanism that actually bounds
 * the value reaching the cookie, because it collapses to a subset of the distinct tokens
 * whatever the column holds.
 *
 * ⚠⚠ **THIS NORMALISER FEEDS BOTH THE SEAL PATH AND (VIA `storedPlatformOverrideKeyOf`) THE
 * STORED-ROW DRIFT KEY, ON PURPOSE, AND FILTERING WITHOUT THAT WOULD BE A REGRESSION, NOT A
 * FIX.** `checkSessionDrift` compares `sealedPlatformOverrideKeyOf(session.user)` — which keys
 * through `decodeSealedPlatformCapabilities`, NOT through this function — against
 * `storedPlatformOverrideKeyOf(dbUser)`, which keys through THIS function. The two sides
 * converge not because they share a normaliser (they no longer do — BAL-558 split the keyer in
 * two), but because SEAL→DECODE IS AN EXACT ROUND TRIP: encoding a normalised set of tokens and
 * decoding it back yields the same set, pinned by the round-trip and convergence tests in
 * `session-platform-capabilities.test.ts` and `platform-capability-seal.test.ts`. A row holding
 * a duplicate or an unknown token is normalised HERE, on the way into the seal; the sealed
 * cookie therefore never carries what the raw row would have keyed to, and the two keyers agree
 * on the first render.
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
 * ⚠ BAL-558 — SEALS SEAL-ORDER INDEXES, NOT TOKEN STRINGS. The array it seals is NORMALISED (see
 * `normalizedOverrideOf`) and then run through `encodeSealedPlatformCapabilities`, never the raw
 * stored value and never a token string: token strings cost ~490 bytes on the tightest cookie
 * (`balo_admin_session`) and pushed a 19-token override past the 3500-byte safe budget. See
 * `packages/shared/src/authz/platform.ts`'s `PLATFORM_CAPABILITY_SEAL_ORDER` docblock for the
 * wire-format contract this encoding depends on.
 */
export function sealedPlatformCapabilities(source: CarriesPlatformCapabilities): {
  platformCapabilities?: SealedPlatformCapabilityIndexes;
} {
  const normalized = normalizedOverrideOf(source);
  return normalized === null
    ? {}
    : { platformCapabilities: encodeSealedPlatformCapabilities(normalized) };
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
 * The shared comparison-KEY primitive. Given a set of TOKENS (or `null` for "no override"),
 * produces the canonical drift key.
 *
 * `null` for absent / SQL NULL / any non-array, so "the cookie has no field" and "the column is
 * NULL" are ONE state and a pre-BAL-560 cookie does not report permanent drift.
 *
 * SORTED: a pure REORDER is not drift. An order-sensitive comparison would still converge (the
 * sync route patches session←DB verbatim, so one round makes them identical), but it would
 * spend a redirect on a non-change.
 */
function overrideKeyOf(tokens: readonly PlatformCapability[] | null): string | null {
  if (tokens === null) return null;
  // ⚠ THE COMPARATOR IS NOT OPTIONAL. A bare `.sort()` coerces every element to a string and
  // orders by UTF-16 code unit — SonarCloud rates that a RELIABILITY bug (S2871, "Provide a
  // compare function to avoid sorting elements alphabetically"), and ONE of them is enough to
  // drop the new-code reliability rating to D and fail the quality gate. These are lowercase
  // snake_case tokens, so `localeCompare` is stable and locale-independent over the alphabet.
  // Same shape as `sortIds` in `packages/db/src/repositories/_shared/consultation-projection.ts`.
  return JSON.stringify([...tokens].sort((a, b) => a.localeCompare(b)));
}

/**
 * BAL-558 — TWO KEYERS, NOT ONE. Before this ticket a single `platformOverrideKeyOf` keyed both
 * the sealed session (strings) and the raw DB row (strings) through one normaliser. Now the
 * sealed session carries INDEXES and the DB row still carries STRINGS, so each side needs its
 * own normaliser feeding the same `overrideKeyOf` primitive:
 *
 *   - `storedPlatformOverrideKeyOf(row)` = `overrideKeyOf(normalizedOverrideOf(row))` — the DB
 *     row side (strings).
 *   - `sealedPlatformOverrideKeyOf(user)` = `overrideKeyOf(decodeSealedPlatformCapabilities(...))`
 *     — the sealed session side (indexes, decoded back to tokens).
 *
 * ⚠⚠ WHY TWO KEYERS RATHER THAN ONE TOLERANT NORMALISER. A single keyer accepting both numbers
 * and strings creates two failure modes: (1) it would decode a hand-edited `[5]` DB row as
 * `view_platform_admin` on the key side while the seal side (strings-only) seals `[]` — the keys
 * never converge, so every render redirects forever (the BAL-560 finding-4 storm, inverted); (2)
 * it would key a legacy string-encoded cookie EQUAL to its row, so drift would never fire while
 * the reader denies it — a staff member permanently stuck with no powers. Splitting the keyers
 * by SOURCE makes each side use exactly the normaliser its reader uses, and the type signatures
 * make a crossed argument a compile-time error: a DB row's `string[] | null` is not assignable
 * to a sealed session's `number[] | undefined`.
 *
 * ⚠ NAMED WITHOUT THE LOWERCASE SUBSTRING `platformCapabilities`, DELIBERATELY, exactly like the
 * retired `platformOverrideKeyOf`. The invariant's field pin
 * (`invariants/platform-capability-single-resolution-point.test.ts`, PIN C) collects every
 * non-test file whose CODE contains that substring. A keyer spelled with it would put
 * `session-sync.ts` into the pinned reader set for a purely cosmetic reason and blunt the pin's
 * meaning ("who touches the field"). Do not rename either keyer without re-deriving PIN C.
 */
export function storedPlatformOverrideKeyOf(source: CarriesPlatformCapabilities): string | null {
  return overrideKeyOf(normalizedOverrideOf(source));
}

/** The sealed-session side of the drift comparison — decodes seal-order indexes back to tokens. */
export function sealedPlatformOverrideKeyOf(
  user: Pick<SessionUser, 'platformCapabilities'>
): string | null {
  const decoded = decodeSealedPlatformCapabilities(user.platformCapabilities);
  return overrideKeyOf(decoded);
}
