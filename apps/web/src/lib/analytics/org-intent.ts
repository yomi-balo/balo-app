import 'server-only';

import { trackServerAndFlush, ORG_INTENT_SERVER_EVENTS } from '@/lib/analytics/server';
import type { DomainClass } from '@balo/shared/domains';

/**
 * Emit the ADR-1038 (S2 / BAL-369) `org_created_at_intent` analytics event —
 * fired ONCE, post-commit, when a typed org is instantiated at the onboarding
 * Intent step (a company promote, or an agency provision/solo). Server event —
 * NOT in the `vi.mock('@/lib/analytics')` client-export list.
 */
export function emitOrgCreatedAtIntent(
  partyType: 'company' | 'agency',
  domainClass: DomainClass,
  userId: string
): void {
  trackServerAndFlush(ORG_INTENT_SERVER_EVENTS.CREATED_AT_INTENT, {
    party_type: partyType,
    domain_class: domainClass,
    distinct_id: userId,
  });
}
