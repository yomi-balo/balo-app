import 'server-only';

import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { hasEngagementCapability } from '@/lib/authz/engagement';

/**
 * Who may mark a CASE's action items done (or reopen them) — the ONE definition, read by the
 * Server Action that writes and by both loaders (case surface, case recap) that decide whether
 * the checkbox is interactive, so the affordance and the write can never disagree.
 *
 * Each lens is checked on its own axis (CLAUDE.md — never widen one axis to cover another):
 *  - `client` → MEMBERSHIP: `participate` on the case's company.
 *  - `expert` → ENGAGEMENT: `manage_engagement` on the case context — the delivering expert ∪
 *    their agency `owner`/`admin`. An agency colleague with role `expert` can READ the case
 *    (`actorHasExpertSideVisibility`) but does not hold this act right (ADR-1046 §7).
 *
 * ⚠ CAPABILITY ONLY. It does not discharge the READ obligation (`resolveCaseAccess` /
 * `authorizeCaseMutation` do) and it does not check the case is open — callers AND that in
 * ahead of the call so a closed case resolves no capability read.
 */
export async function mayToggleCaseActionItems(
  actor: { id: string },
  subject: { lens: 'client' | 'expert'; engagementId: string; companyId: string }
): Promise<boolean> {
  if (subject.lens === 'client') {
    return hasCapability(actor, CAPABILITIES.PARTICIPATE, { companyId: subject.companyId });
  }
  return hasEngagementCapability(actor, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
    contextType: 'case',
    contextId: subject.engagementId,
  });
}
