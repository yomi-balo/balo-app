import 'server-only';

import { cache } from 'react';
import {
  usersRepository,
  companiesRepository,
  partyMembershipsRepository,
  representationsRepository,
} from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import {
  deriveWorkspaces,
  type DerivedWorkspaces,
  type MembershipCompanyInput,
  type RepresentedCompanyInput,
  type StoredWorkspaceChoice,
  type WorkspaceDerivationInput,
} from '@balo/shared/workspaces';

type SessionSyncUser = Awaited<ReturnType<typeof usersRepository.findForSessionSync>>;

/**
 * Approved expert profile = the row exists AND `approvedAt` is set (CLAUDE.md auth model —
 * expert status is derived, never a stored flag). Both columns come from the SAME
 * left-joined `expert_profiles` row, so this can never disagree with `expertProfileId`.
 */
function hasApprovedExpertProfile(user: SessionSyncUser): boolean {
  if (user === null) return false;
  return user.expertProfileId !== null && user.expertApprovedAt !== null;
}

export interface WorkspaceDerivationMaterials {
  readonly input: WorkspaceDerivationInput;
  readonly stored: StoredWorkspaceChoice;
}

/**
 * BAL-494 — the async fetch-and-call wrapper's READ half. Issues the five reads (four in
 * parallel, the fifth conditional) and shapes them into the pure core's input types, WITHOUT
 * calling `deriveWorkspaces` itself. Exported (not just an internal helper) so
 * `switch-workspace.ts` can recompute the derivation against a NEW stored choice — after
 * persisting the switch — from the SAME already-fetched materials, costing no second round
 * of DB reads (memory: React `cache()` dedupes by argument within one request tree, so a
 * second call here with the same `userId` replays the memoized reads instead of re-querying).
 *
 * Same shape as `@balo/shared/authz`'s engagement axis: pure core in `@balo/shared`, thin
 * per-app resolver here.
 *
 * ⚠ `now` is derived INSIDE this function and is NEVER a parameter — see the two reasons in
 * the plan: (a) `liveRepresentation(now)` is the whole of representation-expiry enforcement,
 * so a caller-supplied `now` would bypass expiry outright; (b) a `now` parameter would defeat
 * the `cache()` memo (a fresh `Date` per call is a fresh cache key).
 *
 * Errors are NOT caught here — a failed authorization derivation must not fail open, and
 * `checkSessionDrift` (the main caller of `deriveWorkspacesForUser` below) has no try/catch
 * either.
 */
export const loadWorkspaceDerivationMaterials = cache(
  async (userId: string): Promise<WorkspaceDerivationMaterials> => {
    const now = new Date();

    const [sessionSyncUser, eligibleCompanies, userWithCompany, activeRepresentations] =
      await Promise.all([
        usersRepository.findForSessionSync(userId),
        partyMembershipsRepository.listCapabilityEligibleCompanies(
          userId,
          CAPABILITIES.PARTICIPATE
        ),
        usersRepository.findWithCompany(userId),
        representationsRepository.findActiveForActor(userId, now),
      ]);

    // ⚠ EXPLICIT PROJECTION ONLY — `findWithCompany` is a relational `with:` hydration that
    // materialises whole `companies` rows (stripeCustomerId, creditBalance included). Never
    // spread a row; project exactly what a workspace needs (memory
    // `reference_drizzle_with_hydration_leaks_secrets`).
    const memberships: MembershipCompanyInput[] = (userWithCompany?.companyMemberships ?? []).map(
      (m) => ({
        companyId: m.company.id,
        name: m.company.name,
        isPersonal: m.company.isPersonal,
        role: m.role,
      })
    );
    const membershipCompanyIds = new Set(memberships.map((m) => m.companyId));

    // The representation arm's filter — scope='org' AND capabilities carries PARTICIPATE.
    // `findActiveForActor` already filters `capabilities` to the representable allowlist and
    // liveness (deleted_at / revoked / expiry), so only scope + PARTICIPATE remain here.
    const orgParticipateCompanyIds = new Set(
      activeRepresentations
        .filter((r) => r.scope === 'org' && r.capabilities.includes(CAPABILITIES.PARTICIPATE))
        .map((r) => r.onBehalfOfCompanyId)
    );

    // Read 5 — CONDITIONAL, short-circuits to a no-op ([] input) when every represented
    // company is already covered by a membership row (the steady-state case: BAL-313 ships
    // no writer, so `orgParticipateCompanyIds` is always empty in production).
    const idsNeedingSummary = [...orgParticipateCompanyIds].filter(
      (id) => !membershipCompanyIds.has(id)
    );
    const summaries =
      idsNeedingSummary.length === 0
        ? []
        : await companiesRepository.findSummariesByIds(idsNeedingSummary);
    const summaryByCompanyId = new Map(summaries.map((s) => [s.id, s]));

    const representedCompanies: RepresentedCompanyInput[] = [...orgParticipateCompanyIds]
      .map((companyId) => {
        const fromMembership = memberships.find((m) => m.companyId === companyId);
        if (fromMembership !== undefined) {
          return {
            companyId,
            name: fromMembership.name,
            isPersonal: fromMembership.isPersonal,
          };
        }
        const summary = summaryByCompanyId.get(companyId);
        return summary === undefined
          ? undefined
          : { companyId, name: summary.name, isPersonal: summary.isPersonal };
      })
      .filter((r): r is RepresentedCompanyInput => r !== undefined);

    const input: WorkspaceDerivationInput = {
      hasApprovedExpertProfile: hasApprovedExpertProfile(sessionSyncUser),
      memberships,
      eligibleCompanyIds: eligibleCompanies.map((c) => c.id),
      representedCompanies,
    };

    const stored: StoredWorkspaceChoice = {
      activeMode: sessionSyncUser?.activeMode ?? 'client',
      activeCompanyId: sessionSyncUser?.activeCompanyId ?? null,
    };

    return { input, stored };
  }
);

/**
 * The public read entry point most callers want: the READ half above, then the pure
 * `deriveWorkspaces` core applied to it. Wrapped in its own `cache()` (same technique as
 * `session-sync.ts`) so the dashboard layout, the page body and the drift check share ONE
 * derivation per request tree.
 */
export const deriveWorkspacesForUser = cache(
  async (userId: string): Promise<DerivedWorkspaces | null> => {
    const { input, stored } = await loadWorkspaceDerivationMaterials(userId);
    return deriveWorkspaces(input, stored);
  }
);
