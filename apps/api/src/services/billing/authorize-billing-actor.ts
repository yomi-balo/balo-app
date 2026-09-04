import { partyMembershipsRepository } from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';

/**
 * BAL-522 — the ROUTE-layer `MANAGE_BILLING` gate for `POST /credit/billing-email`.
 * `hasCapability` is `apps/web`-only (`import 'server-only'`), so the api spelling is
 * `getMemberRole` + `roleHasCapability` — the same pure map (ADR-1029), the same fail-closed
 * semantics. Exemplars: `services/meetings/authorize-meeting-cancel.ts:173-174`,
 * `services/credit-session/drawdown.ts:40`.
 *
 * This is the FIRST api-side `MANAGE_BILLING` route gate. The sibling credit routes document
 * that the web layer gated it across `requireInternalAuth` (`routes/credit/purchase-intent.ts`);
 * that stays true for them — this route adds a second, server-side gate because it MUTATES a
 * durable, audited company value. The transactional half lives in
 * `companiesRepository.setBillingEmail` (D4), which re-gates a THIRD time inside its own
 * transaction — the TOCTOU-safe one.
 */
export async function actorHoldsManageBilling(
  companyId: string,
  actorUserId: string
): Promise<boolean> {
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, actorUserId);
  return role !== undefined && roleHasCapability(role, CAPABILITIES.MANAGE_BILLING);
}
