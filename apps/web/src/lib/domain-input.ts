/**
 * Pure, client-safe domain-input normalisation + format validation (BAL-347).
 *
 * NO `server-only`, NO `@balo/db` — imported by BOTH the client add-domain form
 * (inline validation before submit) AND the server add-domain action's Zod schema, so
 * the forgiving cleanup + hostname-format rule live in exactly ONE place (no Sonar
 * new-code duplication, no drift between the client hint and the server guard).
 */

export const DOMAIN_EMPTY_MESSAGE = 'Enter a domain to add.';
export const DOMAIN_INVALID_FORMAT_MESSAGE =
  "That doesn't look like a domain. Enter it like acme.com — no https:// or @.";

/**
 * Canonicalise pasted domain input: trim, lowercase, strip a leading `https://` /
 * `http://`, strip a leading `@`, and drop anything from the first `/`. The path strip
 * uses `indexOf` (not a `/…$/` regex) to avoid a super-linear ReDoS hotspot (S5852).
 */
export function cleanDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/^@+/, '');
  const slash = value.indexOf('/');
  return slash === -1 ? value : value.slice(0, slash);
}

// Hostname shape: dot-separated labels of [a-z0-9] (hyphens allowed internally), at
// least two labels. Delimiter-anchored labels keep this linear (no catastrophic
// backtracking); callers bound the input length as defence-in-depth.
const DOMAIN_FORMAT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** True when `domain` (already cleaned) matches the hostname format. */
export function isValidDomainFormat(domain: string): boolean {
  return DOMAIN_FORMAT.test(domain);
}

export type DomainValidation = { ok: true; domain: string } | { ok: false; error: string };

/**
 * Clean + validate raw domain input in one call — the client form uses this for its
 * inline error, and the shape mirrors the server Zod schema exactly.
 */
export function validateDomainInput(raw: string): DomainValidation {
  const cleaned = cleanDomainInput(raw);
  if (cleaned.length === 0) {
    return { ok: false, error: DOMAIN_EMPTY_MESSAGE };
  }
  if (!isValidDomainFormat(cleaned)) {
    return { ok: false, error: DOMAIN_INVALID_FORMAT_MESSAGE };
  }
  return { ok: true, domain: cleaned };
}
