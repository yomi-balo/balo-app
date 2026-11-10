import {
  hostRoleHasCapability,
  type EngagementCapability,
  type HostRole,
} from '@balo/shared/authz';

/**
 * A `hasExpertDeliveryCapability` stand-in that answers through the REAL token map in
 * `@balo/shared/authz`. `hostRoleOf` says which host role each actor holds (`null` = not a
 * holder); which tokens that role carries is never restated here, so a holder-set change in
 * `ENGAGEMENT_ROLE_CAPABILITIES` reaches every test that uses this.
 */
export function capabilityOverTokenMap(
  hostRoleOf: (actorId: string) => HostRole | null
): (actor: { id: string }, capability: EngagementCapability) => Promise<boolean> {
  return async (actor, capability) => {
    const hostRole = hostRoleOf(actor.id);
    return hostRole !== null && hostRoleHasCapability(hostRole, capability);
  };
}
