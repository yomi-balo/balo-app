import 'server-only';

import { platformLookupRepository } from '@balo/db';
import type { LookupResult } from '@balo/shared/lookup';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

/**
 * BAL-551 — the authorization seam between the page and `platformLookupRepository`. This is
 * the ONE module in the codebase permitted to pass `authorizedPlatformStaff: true` — it
 * resolves `VIEW_PLATFORM_ADMIN` itself, immediately before the call, and returns a typed
 * `forbidden` DTO with ZERO repository calls when the check fails.
 *
 * `@balo/db` never reads a platform role (ADR-1029 / ADR-1035): the flag is the caller's
 * PROOF, not a request the repository re-derives.
 */

export type LookupPageDTO =
  | {
      readonly ok: true;
      readonly results: readonly LookupResult[];
      readonly truncated: boolean;
      readonly tooShort: boolean;
    }
  | { readonly ok: false; readonly reason: 'forbidden' };

export async function loadLookup(user: SessionUser, rawQuery: string): Promise<LookupPageDTO> {
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    log.warn('Admin lookup load reached without VIEW_PLATFORM_ADMIN', { userId: user.id });
    return { ok: false, reason: 'forbidden' };
  }

  // An empty query is the Recent view, which is client-side — short-circuit before the
  // repository so there is nothing to fetch and nothing to log.
  if (rawQuery.trim() === '') {
    return { ok: true, results: [], truncated: false, tooShort: false };
  }

  const { results, truncated, tooShort } = await platformLookupRepository.search({
    query: rawQuery,
    authorizedPlatformStaff: true,
  });
  return { ok: true, results, truncated, tooShort };
}
