// ── Username generation utilities ────────────────────────────────
// Pure functions for auto-generating expert profile usernames from
// first/last name at draft creation time.

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

/** Check if a character is a lowercase alphanumeric (a-z, 0-9) */
function isAlphanumeric(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57); // a-z or 0-9
}

/**
 * Lowercase a name segment, replace non-alphanumeric characters with hyphens,
 * collapse consecutive hyphens, and trim leading/trailing hyphens.
 */
export function sanitizeNameSegment(name: string): string {
  const lower = name.toLowerCase();
  let result = '';
  let lastWasHyphen = false;

  for (const ch of lower) {
    if (isAlphanumeric(ch)) {
      result += ch;
      lastWasHyphen = false;
    } else if (!lastWasHyphen) {
      result += '-';
      lastWasHyphen = true;
    }
  }

  // Trim leading/trailing hyphens
  let start = 0;
  let end = result.length;
  while (start < end && result[start] === '-') start++;
  while (end > start && result[end - 1] === '-') end--;

  return result.slice(start, end);
}

/**
 * Validate a candidate username against format, length, and reserved-word rules.
 * Format: must start and end with alphanumeric, middle can include hyphens.
 */
export function isValidUsername(username: string): boolean {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return false;
  }
  // Must start and end with alphanumeric
  if (!isAlphanumeric(username[0]!) || !isAlphanumeric(username[username.length - 1]!)) {
    return false;
  }
  // All chars must be alphanumeric or hyphen
  for (const ch of username) {
    if (!isAlphanumeric(ch) && ch !== '-') {
      return false;
    }
  }
  if (RESERVED_USERNAMES.has(username)) {
    return false;
  }
  return true;
}

/** Trim trailing hyphens from a string */
function trimTrailingHyphens(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '-') end--;
  return s.slice(0, end);
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
    base = trimTrailingHyphens(base.slice(0, USERNAME_MAX));
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
    const trimmed = trimTrailingHyphens(base.slice(0, maxBase));
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
