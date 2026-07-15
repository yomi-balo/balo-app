/**
 * Server→client mapping for the proposal-sharing surfaces (BAL-386). The client
 * "Shared with" card receives ONLY these plain, serialisable fields — the raw
 * token and its hash NEVER cross to the client. Kept free of any `@balo/db`
 * value import so a client component can import the type without pulling the DB
 * barrel into its bundle (`reference_balo_db_client_bundle_footgun`).
 */

export interface SharedLinkView {
  id: string;
  recipientEmail: string;
  /** `link.createdAt` as an ISO string — formatted on the client. */
  sharedOnIso: string;
  /** `link.lastAccessedAt` as an ISO string, or `null` when never opened. */
  lastAccessedIso: string | null;
  /** `link.expiresAt` as an ISO string — each link has its own expiry (BAL-386). */
  expiresAtIso: string;
}

/**
 * A person's display name for retrospective attribution: "{first} {last}" when
 * present, falling back to a neutral, gender-neutral label. Shared by the share
 * Server Action (sharer) and the public shared view (sharer header). The fallback is
 * deliberately NOT the email: this name surfaces on the PUBLIC provenance strip and in
 * the recipient's email, so the sharer's own address must never leak to an external
 * recipient.
 */
export function shareDisplayName(person: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const full = [person.firstName, person.lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return full.length > 0 ? full : 'a colleague';
}
