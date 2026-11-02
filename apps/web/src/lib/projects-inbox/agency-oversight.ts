import 'server-only';

import { expertsRepository, partyMembershipsRepository, type EligibleAgency } from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';

/**
 * The agencies whose Projects the viewer may oversee: those where a live membership grants
 * `manage_members` (the holder set BAL-626 uses to administer an engagement), and which have
 * delivery by someone besides the viewer: another expert profile links the agency, or a project
 * pinned to it is delivered by another expert profile (so a departed teammate's work keeps the
 * lens). An agency-of-one never offers the lens, since all of its pinned work is the viewer's
 * own. Name order is kept.
 */
export async function loadOversightAgencies(user: SessionUser): Promise<EligibleAgency[]> {
  const eligible = await partyMembershipsRepository.listCapabilityEligibleAgencies(
    user.id,
    CAPABILITIES.MANAGE_MEMBERS
  );
  if (eligible.length === 0) return [];

  const withOtherDelivery = await expertsRepository.findAgenciesWithOtherDelivery(
    eligible.map((agency) => agency.id),
    user.id
  );
  return eligible.filter((agency) => withOtherDelivery.has(agency.id));
}
