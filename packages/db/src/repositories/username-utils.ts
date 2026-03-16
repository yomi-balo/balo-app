// ── Username generation utilities ────────────────────────────────
// Pure functions for auto-generating expert profile usernames from
// first/last name at draft creation time.

export const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const RESERVED_USERNAMES = new Set([
  'admin',
  'support',
  'balo',
  'help',
  'api',
  'www',
  'app',
  'expert',
  'experts',
]);

/**
 * Lowercase a name segment, replace non-alphanumeric characters with hyphens,
 * collapse consecutive hyphens, and trim leading/trailing hyphens.
 */
export function sanitizeNameSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validate a candidate username against format, length, and reserved-word rules.
 */
export function isValidUsername(username: string): boolean {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return false;
  }
  if (!USERNAME_REGEX.test(username)) {
    return false;
  }
  if (RESERVED_USERNAMES.has(username)) {
    return false;
  }
  return true;
}

/**
 * Combine sanitized first + last name into a candidate base username.
 * Returns `null` if either name is missing/empty or the result fails validation.
 */
export function generateBaseUsername(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string | null {
  if (!firstName || !lastName) return null;

  const first = sanitizeNameSegment(firstName);
  const last = sanitizeNameSegment(lastName);

  // Both segments must produce at least one character
  if (!first || !last) return null;

  let base = `${first}-${last}`;

  // Truncate to max length while keeping it valid (don't end on a hyphen)
  if (base.length > USERNAME_MAX) {
    base = base.slice(0, USERNAME_MAX).replace(/-+$/, '');
  }

  if (!isValidUsername(base)) return null;

  return base;
}

/**
 * Given a base username and a set of already-taken usernames, find the next
 * available variant. Tries `base`, then `base-2`, `base-3`, etc.
 *
 * The `existing` array should contain all usernames that start with `base`
 * (fetched via a `LIKE 'base%'` query).
 */
export function pickNextAvailable(base: string, existing: string[]): string {
  const taken = new Set(existing);

  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix <= 10_000; suffix++) {
    const candidate = `${base}-${suffix}`;

    if (candidate.length <= USERNAME_MAX) {
      if (!taken.has(candidate)) return candidate;
      continue;
    }

    // Trim the base portion to make room for the suffix
    const maxBase = USERNAME_MAX - `-${suffix}`.length;
    const trimmed = base.slice(0, maxBase).replace(/-+$/, '');
    const trimmedCandidate = `${trimmed}-${suffix}`;

    if (!isValidUsername(trimmedCandidate)) {
      // Trimming made the username invalid (too short) — no point
      // continuing with larger suffixes that trim even more
      throw new Error(`Cannot generate valid username for base: ${base}`);
    }

    if (!taken.has(trimmedCandidate)) return trimmedCandidate;
  }

  throw new Error(`Could not find available username after 10000 attempts for base: ${base}`);
}
