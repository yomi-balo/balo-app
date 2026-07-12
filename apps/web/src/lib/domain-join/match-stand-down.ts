import type { PartyType, PartyJoinSettings } from '@balo/db';

/**
 * The single evaluation of run-domain-join §4.3 steps 5a–5c. Returns the
 * stand-down reason, or `null` when the engine WOULD act (auto-join or file a
 * request) for a fresh, non-opted-out new user — i.e. the join flow will own the
 * company identity. Deliberately EXCLUDES the per-user opt-out (step 6): a
 * brand-new signup has none, and the resolve check has no userId.
 *
 * Single source of truth: `runDomainJoin` maps this reason → its granular outcome;
 * the onboarding resolve check derives the show/hide boolean from it. The two can
 * never diverge because both read this one function.
 *
 * Reachable as of BAL-369: a PERSONAL workspace still returns `'personal_owner'`
 * (⇒ the resolve check returns `new`, the create branch is shown), but once the
 * owning company is promoted to a shared organization at the onboarding Intent
 * step its `isPersonal` flips false and a same-domain match returns `null` — so
 * the onboarding resolve check and the detect engine both treat it as actionable,
 * because they read this one predicate.
 */
export type MatchStandDown = 'personal_owner' | 'directory_authority' | 'mode_off';

export function evaluateMatchStandDown(
  partyType: PartyType,
  settings: PartyJoinSettings
): MatchStandDown | null {
  if (partyType === 'company' && settings.isPersonal) return 'personal_owner'; // 5a
  if (settings.membershipAuthority === 'directory') return 'directory_authority'; // 5b
  if (settings.domainJoinMode === 'off') return 'mode_off'; // 5c
  return null; // auto | request → engine acts → join flow owns identity
}

/**
 * Convenience boolean for the onboarding resolve check: true only when the join
 * flow would own the company identity (engine acts) ⇒ offer the JOIN branch. A
 * personal-owner / directory / mode-off match ⇒ false ⇒ show the CREATE branch.
 */
export function isActionableDomainMatch(
  partyType: PartyType,
  settings: PartyJoinSettings
): boolean {
  return evaluateMatchStandDown(partyType, settings) === null;
}
