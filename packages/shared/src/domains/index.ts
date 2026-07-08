/**
 * Domain identity helpers (BAL-344 / ADR-1031) — normalisation + blocklist
 * membership for the domain→party mapping.
 *
 * A PURE, transport-agnostic module — NO `db` import, NO I/O, NO analytics. It
 * lives in `@balo/shared` behind the `@balo/shared/domains` subpath export (NOT
 * the package root, which pulls in pino) precisely so it can be imported by BOTH
 * the server-side `@balo/db` capture repository AND the future BAL-345 match path
 * without dragging the postgres driver into any client bundle.
 */

import { FREEMAIL_DOMAINS, DISPOSABLE_DOMAINS } from './blocklists';

export { FREEMAIL_DOMAINS, DISPOSABLE_DOMAINS };

/**
 * Canonicalise a domain string: trim, lowercase, strip a leading '@', drop a
 * trailing dot. Returns '' for empty/whitespace. Does NOT reduce sub-domains to
 * the registrable domain (no PSL/eTLD+1 in this slice — matching is BAL-345); the
 * full host is stored as-is. Deliberate simplification: corporate signups use the
 * apex domain, and the blocklist is an exact-set membership test.
 */
export function normalizeDomain(input: string): string {
  // Leading '@' strip is anchored (`^`) so it is linear. Trailing-dot strip is a
  // bounded scan rather than `/\.+$/` — a greedy end-anchored quantifier is a
  // super-linear ReDoS hotspot (SonarCloud S5852); this while-loop is O(n).
  const lowered = input.trim().toLowerCase().replace(/^@+/, '');
  let end = lowered.length;
  while (end > 0 && lowered[end - 1] === '.') {
    end--;
  }
  return lowered.slice(0, end);
}

/**
 * Extract the normalised domain part of an email (after the LAST '@'), or null
 * if the input has no local@domain shape. No full RFC validation — WorkOS has
 * already validated the address; this only splits + normalises.
 */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  if (domain === '' || !domain.includes('.')) return null;
  return domain;
}

/**
 * True when the domain must NOT be auto-captured as a corporate identity:
 * freemail OR disposable. Pure, allocation-free set lookups.
 */
export function isBlockedDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (d === '') return true; // empty is not a capturable corporate domain
  return FREEMAIL_DOMAINS.has(d) || DISPOSABLE_DOMAINS.has(d);
}
