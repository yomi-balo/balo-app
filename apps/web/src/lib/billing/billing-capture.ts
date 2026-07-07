/**
 * View-model types for the client billing-details capture step (BAL-323), threaded
 * from the request-detail page into the KickoffBoard's client row.
 *
 * Deliberately client-safe: NO value import from @balo/db (that barrel pulls in the
 * postgres driver and breaks the web build when it reaches a client bundle). The
 * page maps the DB row into {@link CapturedBillingDetails} on the server; only these
 * plain shapes cross the RSC → client boundary. `@balo/shared/authz` (imported
 * below) is likewise pure — zero postgres/tls transitive deps — so it stays
 * bundle-safe.
 */

import { roleHasCapability, CAPABILITIES } from '@balo/shared/authz';

/** A company member's role, as carried on the session. */
export type CompanyRole = 'owner' | 'admin' | 'member';

/**
 * Whether a company member may assert the company's legal billing identity — the
 * single source of truth for the interim owner/admin gate, shared by the page (to
 * gate both the affordance AND the `details` payload) and the Server Action (the
 * authoritative re-check).
 *
 * BAL-345 authz seam: the pure static map (`@balo/shared/authz`) is now the single
 * source of truth for role→capability. This seam gates billing on the dedicated
 * `manage_billing` capability (NOT `manage_members`) — ADR-1029's future `finance`
 * role manages billing WITHOUT managing members, so the two must not be coupled.
 * The async server seam `hasCapability(actor, 'manage_billing', { companyId })`
 * (apps/web/src/lib/authz) resolves the same capability from this map for live
 * gates; billing uses this sync helper, which is client-safe (pure, no `@balo/db`)
 * so it stays a bundle-safe import of the map. `owner`/`admin` hold `MANAGE_BILLING`,
 * matching the prior owner/admin gate exactly.
 */
export function canManageBilling(role: CompanyRole): boolean {
  return roleHasCapability(role, CAPABILITIES.MANAGE_BILLING);
}

/** The captured company billing identity, for the read-only success view + edit prefill. */
export interface CapturedBillingDetails {
  legalName: string;
  countryCode: string;
  taxId: string | null;
  address: string | null;
  billingEmail: string;
}

/**
 * Billing-capture context for the client's kickoff row. Non-null ONLY for the
 * client lens (experts/admin never capture the client's billing identity).
 *
 * - `canManage` — the acting member may submit/edit (company role `owner`/`admin`);
 *   a plain `member` sees the "what happens next" notice instead of the form.
 * - `details` — the company's existing billing row (for the read-only/edit view),
 *   or `null` when nothing has been captured yet (the first-time path).
 */
export interface KickoffBillingCapture {
  companyId: string;
  canManage: boolean;
  details: CapturedBillingDetails | null;
}
