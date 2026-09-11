import 'server-only';

import {
  expertsRepository,
  type ApplicationReviewFilter,
  type ApplicationReviewList,
} from '@balo/db';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { APPLICATION_LIST_LIMIT, DECIDED_WINDOW_DAYS } from './application-list-view';

/**
 * BAL-549 — the authorization seam between `/admin/applications`'s page and
 * `expertsRepository.listApplicationsForReview`. The `admin/lookup` `load-lookup.ts` shape:
 * re-resolve `VIEW_PLATFORM_ADMIN` here, immediately before the call, and return a typed
 * `forbidden` DTO with ZERO repository calls when the check fails — defence in depth over the
 * page-level gate, which already redirects/`notFound()`s before this is ever called.
 */

export type ApplicationsPageDTO =
  | ({ readonly ok: true } & ApplicationReviewList)
  | { readonly ok: false; readonly reason: 'forbidden' };

export async function loadApplications(
  user: SessionUser,
  filter: ApplicationReviewFilter
): Promise<ApplicationsPageDTO> {
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    log.warn('Admin applications load reached without VIEW_PLATFORM_ADMIN', { userId: user.id });
    return { ok: false, reason: 'forbidden' };
  }

  const decidedSince = new Date(Date.now() - DECIDED_WINDOW_DAYS * 86_400_000);
  const result = await expertsRepository.listApplicationsForReview({
    filter,
    decidedSince,
    limit: APPLICATION_LIST_LIMIT,
  });

  return { ok: true, ...result };
}
