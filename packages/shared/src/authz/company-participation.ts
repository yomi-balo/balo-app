/**
 * ⚠ THE COMPANY-LEVEL `PARTICIPATE` RULE (ADR-1029 MEMBERSHIP AXIS) — ONE DEFINITION.
 *
 * Extracted by BAL-566 (D14) from `authorizeEngagementConversation`'s client arm
 * (`apps/web/src/lib/conversations/authorize-conversation-context.ts`), where it was written
 * inline as `getMemberRole('company', …)` + `roleHasCapability(role, PARTICIPATE)`. The
 * dashboard's Up next card needs the SAME question answered before it reads a single meeting,
 * and BAL-567 plans a third consumer — so the rule lives here, once, and callers consume it.
 *
 * ⚠⚠ THIS IS **NOT** A NEW AXIS AND ADDS NO TOKEN. It is the membership axis's existing
 * `PARTICIPATE` capability, resolved at COMPANY scope. The role string is still interpreted in
 * exactly one place — `roleHasCapability` in `./index` (HARD CONSTRAINT B) — and this module
 * delegates to it rather than re-reading a role.
 *
 * ⚠ TRI-STATE, NOT BOOLEAN, ON PURPOSE. The conversation gate treats "a member whose role does
 * not carry `PARTICIPATE`" (deny, `no_capability`) differently from "not a member at all" (fall
 * through to the EXPERT arm). Collapsing the two into `false` would silently route a
 * capability-less company member into the expert-side visibility check.
 *
 * ⚠ THE LOOKUP IS HANDED `actorUserId` PER CALL, NEVER CAPTURED — the same confused-deputy
 * guard as `AgencyRoleLookup` (`./expert-side-visibility`). A one-argument `(companyId) => …`
 * closure could be built for one actor and reused for another, and nothing would structurally
 * bind the two ids. Every call site is therefore
 * `(companyId, actorId) => partyMembershipsRepository.getMemberRole('company', companyId, actorId)`.
 *
 * ⚠ THE LOOKUP MUST FILTER SOFT-DELETED MEMBERSHIPS. `partyMembershipsRepository.getMemberRole`
 * does (`selectLiveRole`). A lookup that returned a removed member's stale role would let a
 * 7-day session cookie outlive the removal.
 *
 * ⚠ CIRCULAR IMPORT, DELIBERATE — the `./engagement` precedent (BAL-413 flag F8). This module
 * imports `CAPABILITIES` / `roleHasCapability` from `./index`, which re-exports this module.
 * Value-safe: nothing here calls into `./index` at module-init time.
 *
 * PURE: no `@balo/db`, no I/O of its own, no logging — client-bundle-safe.
 */
import { CAPABILITIES, roleHasCapability } from './index';

/**
 * Resolve `actorUserId`'s LIVE membership role in `companyId`, or `undefined` when they hold
 * none. Both arguments are supplied per call — see the module docblock.
 */
export type CompanyRoleLookup = (
  companyId: string,
  actorUserId: string
) => Promise<string | undefined>;

/**
 * - `participant` — a live member whose role grants `PARTICIPATE`.
 * - `member_without_participate` — a live member whose role grants no `PARTICIPATE` (no shipped
 *   company role reaches this today; an unknown role string does).
 * - `not_a_member` — no live membership in the company.
 */
export type CompanyParticipation = 'participant' | 'member_without_participate' | 'not_a_member';

/** THE company-level `PARTICIPATE` decision. See the module docblock. */
export async function resolveCompanyParticipation(
  companyId: string,
  actorUserId: string,
  lookupCompanyRole: CompanyRoleLookup
): Promise<CompanyParticipation> {
  const role = await lookupCompanyRole(companyId, actorUserId);
  if (role === undefined) return 'not_a_member';
  return roleHasCapability(role, CAPABILITIES.PARTICIPATE)
    ? 'participant'
    : 'member_without_participate';
}
