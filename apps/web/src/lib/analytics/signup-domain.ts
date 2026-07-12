import 'server-only';

import { trackServerAndFlush, SIGNUP_DOMAIN_SERVER_EVENTS } from '@/lib/analytics/server';
import type { DomainClass } from '@balo/shared/domains';

/**
 * Emit the ADR-1038 signup domain classification (S1 / BAL-368). Fired ONCE per
 * signup from `runDomainJoinAndEmit` (post-commit by construction). Server event —
 * NOT in the `vi.mock('@/lib/analytics')` client-export list.
 */
export function emitSignupDomainClassified(domainClass: DomainClass, userId: string): void {
  trackServerAndFlush(SIGNUP_DOMAIN_SERVER_EVENTS.CLASSIFIED, {
    domain_class: domainClass,
    distinct_id: userId,
  });
}
