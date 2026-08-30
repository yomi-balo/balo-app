import 'server-only';

import { cache } from 'react';
import { companiesRepository } from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
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
 * BAL-347 → BAL-495. Byte-for-byte the outcome of the deleted `resolveCanManageCompany`, with the
 * raw `companyRole !== 'owner' && companyRole !== 'admin'` comparison replaced by the ONE
 * role→capability map (ADR-1029 HARD CONSTRAINT B). Over `SessionUser['companyRole']`
 * (`owner|admin|member`) — and over any unknown value a stale cookie could carry —
 * `roleHasCapability(role, MANAGE_MEMBERS)` is true for exactly `owner` and `admin`.
 *
 * ⚠ The personal-company suppression is applied by WITHHOLDING the token, never by exporting an
 * `isPersonal` flag the registry could re-derive (orchestrator decision 3).
 */
async function resolveNavCapabilities(user: SessionUser | null): Promise<readonly NavCapability[]> {
  if (!user) return [];
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

export async function buildNavContext(user: SessionUser | null): Promise<NavContext> {
  return {
    workspaceType: navWorkspaceTypeOf(user),
    capabilities: await resolveNavCapabilities(user),
  };
}
