import 'server-only';

import { expertsRepository, partyMembershipsRepository, type EligibleAgency } from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';

/**
 * The agencies whose Projects the viewer may oversee: those where a live membership grants
 * `manage_members` (the holder set BAL-626 uses to administer an engagement), and which have
 * at least one linked expert profile besides the viewer's own. A solo agency can never gain a
 * member, so it never offers the lens. Departed teammates still count: their link persists.
 * Name order is kept.
 */
export async function loadOversightAgencies(user: SessionUser): Promise<EligibleAgency[]> {
  const eligible = await partyMembershipsRepository.listCapabilityEligibleAgencies(
    user.id,
    CAPABILITIES.MANAGE_MEMBERS
  );
  if (eligible.length === 0) return [];

  const others = await expertsRepository.countOtherLinkedProfiles(
    eligible.map((agency) => agency.id),
    user.id
  );
  return eligible.filter((agency) => (others.get(agency.id) ?? 0) > 0);
}
