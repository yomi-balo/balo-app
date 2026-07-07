import 'server-only';

import { partyMembershipsRepository, type PartyType } from '@balo/db';
import { roleHasCapability, type Capability } from '@balo/shared/authz';

/**
 * hasCapability seam (BAL-345 §3.3, HARD CONSTRAINT B).
 *
 * The ONLY server-side gate that turns an actor + a party scope into an
 * allow/deny decision. It resolves the actor's LIVE membership role
 * (`partyMembershipsRepository.getMemberRole`, which filters `deletedAt IS NULL`)
 * and delegates the interpretation to the pure `@balo/shared/authz` map — the
 * single place a role string is ever read. NO `role ===` / `role IN (...)` check
 * exists at any BAL-345 call site; every gate flows through here.
 *
 * `server-only`: it performs a `@balo/db` read, so it must never reach a client
 * bundle. The pure constants are re-exported below for call-site ergonomics
 * (Server Actions import `CAPABILITIES` from here); client components that need
 * the pure map import `@balo/shared/authz` directly (e.g. `billing-capture.ts`).
 */

export {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  roleHasCapability,
  rolesWithCapability,
} from '@balo/shared/authz';
export type { Capability } from '@balo/shared/authz';

/** A capability check is scoped to exactly one party (company OR agency). */
export type CapabilityScope = { companyId: string } | { agencyId: string };

/**
 * True when `actor`'s LIVE membership role in the scoped party grants
 * `capability`. A non-member (no live membership) fails closed (`false`). The
 * `partyType` is branched from the scope discriminant so an agency scope never
 * silently reads a company membership.
 */
export async function hasCapability(
  actor: { id: string },
  capability: Capability,
  scope: CapabilityScope
): Promise<boolean> {
  const isCompany = 'companyId' in scope;
  const partyType: PartyType = isCompany ? 'company' : 'agency';
  const partyId = isCompany ? scope.companyId : scope.agencyId;
  const role = await partyMembershipsRepository.getMemberRole(partyType, partyId, actor.id);
  if (role === undefined) return false; // not a member ⇒ no capability
  return roleHasCapability(role, capability);
}
