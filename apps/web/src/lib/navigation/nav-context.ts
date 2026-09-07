import 'server-only';

import { cache } from 'react';
import { companiesRepository } from '@balo/db';
import {
  CAPABILITIES,
  PLATFORM_CAPABILITIES,
  platformRoleHasCapability,
  roleHasCapability,
} from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import type { NavCapability, NavContext, NavWorkspaceType } from '@/components/layout/nav-registry';
import { log } from '@/lib/logging';

/**
 * ADR-1053 expand/contract, read in the INVERSE direction. `SessionUser.activeWorkspace` is
 * OPTIONAL (absent on every cookie sealed before BAL-494, 7-day TTL), so reading it here would
 * silently mis-scope nav until drift-sync repopulates. `activeMode` is the PROJECTION of that
 * workspace and is always present, so the projection is inverted HERE — once, server-side — and
 * `activeMode` never reaches the registry. THIS IS A WORKSPACE-SCOPING GATE, NEVER A
 * CAPABILITY/AUTHORIZATION GATE: `nav-registry.ts`'s own `resolveNavItems` docblock calls
 * `workspaceTypes.includes(context.workspaceType)` one of its four "gates", so claiming this
 * projection gates nothing would contradict the code it feeds. It scopes WHICH entries are even
 * candidates for a workspace; it never decides whether an actor is authorized to see one.
 */
export function navWorkspaceTypeOf(user: SessionUser | null): NavWorkspaceType {
  return user?.activeMode === 'expert' ? 'expert' : 'company';
}

/**
 * BAL-503 — THE per-request company read for nav + settings chrome. `cache()`d and keyed on the
 * companyId STRING.
 *
 * ⚠ Keyed on a string DELIBERATELY, not on the `SessionUser` object. `getCurrentUser()` re-reads
 * the sealed cookie and returns a FRESH object on every call, so an object-keyed `cache()` would
 * miss between layouts and dedupe nothing — it would look like a fix and do nothing.
 *
 * Collapses what were three reads of the SAME row on one `/settings/billing` render:
 * `(dashboard)/layout.tsx`'s `buildNavContext`, `settings/layout.tsx`'s `resolveSettingsChrome`,
 * and the billing page's own workspace-scope gate.
 *
 * ⚠ Lives HERE rather than in its own module because the BAL-495 invariant
 * (`nav-registry-capability-gated.test.ts`, Scan B) asserts this file still references
 * `companiesRepository` — moving the read out would fail that guard.
 */
export const readCompanyForRequest = cache(async (companyId: string) =>
  companiesRepository.findById(companyId)
);

/**
 * BAL-347 → BAL-495 → BAL-534. THE MEMBERSHIP CONTRIBUTION, byte-for-byte the outcome of the
 * previous single-branch resolver: `MANAGE_MEMBERS` for an `owner`/`admin` of a NON-personal
 * company, withheld otherwise.
 *
 * ⚠ The personal-company suppression is applied by WITHHOLDING the token, never by exporting an
 * `isPersonal` flag the registry could re-derive (orchestrator decision 3).
 * ⚠ Its `catch` returns only THIS contribution's empty set — it can no longer discard an
 * already-resolved platform token, which is the whole point of the BAL-534 split.
 */
async function resolveMembershipNavCapabilities(
  user: SessionUser
): Promise<readonly NavCapability[]> {
  if (!roleHasCapability(user.companyRole, CAPABILITIES.MANAGE_MEMBERS)) return [];
  try {
    const company = await readCompanyForRequest(user.companyId);
    if (company === undefined || company.isPersonal) return [];
    return [CAPABILITIES.MANAGE_MEMBERS];
  } catch (error) {
    // ⚠ MESSAGE PRESERVED VERBATIM — log dashboards/alerts key on this string.
    log.warn('Failed to resolve company for nav gating', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * BAL-534 — THE PLATFORM CONTRIBUTION (ADR-1035 axis). Synchronous and I/O-free: it reads the
 * session's `platformRole` through the ONE platform predicate, so it cannot throw and cannot be
 * lost to the company read's `catch` above.
 *
 * ⚠ Every Balo user is provisioned into a PERSONAL company, and most staff are plain members of
 * it — which is exactly why this is a separate contribution and not another line inside the
 * membership branch. Appending to that branch would have kept the old behaviour of returning
 * `[]` for a staff member before this token was ever considered.
 */
function resolvePlatformNavCapabilities(user: SessionUser): readonly NavCapability[] {
  return platformRoleHasCapability(user.platformRole, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ? [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]
    : [];
}

/** The nav grant set: the UNION of the two independent contributions, membership first. */
async function resolveNavCapabilities(user: SessionUser | null): Promise<readonly NavCapability[]> {
  if (user === null) return [];
  return [
    ...(await resolveMembershipNavCapabilities(user)),
    ...resolvePlatformNavCapabilities(user),
  ];
}

export async function buildNavContext(user: SessionUser | null): Promise<NavContext> {
  return {
    workspaceType: navWorkspaceTypeOf(user),
    capabilities: await resolveNavCapabilities(user),
  };
}
