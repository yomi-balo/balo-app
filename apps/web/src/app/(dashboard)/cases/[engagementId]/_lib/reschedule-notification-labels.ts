import 'server-only';

import {
  agenciesRepository,
  companiesRepository,
  expertsRepository,
  usersRepository,
} from '@balo/db';
import {
  expertPartyDisplayName,
  personDisplayName,
  personWithOrgLabel,
} from '@balo/shared/parties';

/**
 * BAL-409 / BAL-411 — the display labels every reschedule/reschedule-proposal notification
 * payload needs, resolved ONE way. The two-field core (`clientCompanyName`, `expertPartyLabel`)
 * is extracted VERBATIM from `_actions/reschedule-consultation.ts` (BAL-409's original, inline
 * copy) so `propose-reschedule.ts` and `respond-to-reschedule-proposal.ts` share it rather than
 * re-deriving the same column-projected reads a third and fourth time (jscpd — memory
 * `reference_sonar_duplication_not_caught_locally`).
 *
 * `expertPersonLabel` is ADDITIVE — the RETROSPECTIVE "Dana @ CloudPeak" form
 * (`personWithOrgLabel`, the `resolve-counterparty.ts` precedent), for `reschedule_proposal.sent`
 * ONLY. Computed from the SAME two reads, so a caller that does not need it (the accept/decline
 * paths, which reuse the two-field core) pays no extra query for carrying it.
 *
 * Column-projected reads only, the SAME shape `close-case-effects.ts`'s `publishCaseClosed`
 * uses — never a full row. NEVER THROWS: a notification publish is best-effort and must not
 * fail an already-committed write; every caller wraps this in its own `.catch()` fallback.
 */
export async function resolveNotificationLabels(
  companyId: string,
  expertProfileId: string
): Promise<{ clientCompanyName: string; expertPartyLabel: string; expertPersonLabel: string }> {
  const [company, profile] = await Promise.all([
    companiesRepository.findNameById(companyId),
    expertsRepository.findDisplayProfileById(expertProfileId),
  ]);
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);
  const agencyName = agency?.name ?? null;
  const firstName = expertUser?.firstName ?? null;
  const lastName = expertUser?.lastName ?? null;
  const expertPerson = personDisplayName(firstName, lastName, 'Your expert');
  return {
    clientCompanyName: company?.name ?? 'your company',
    expertPartyLabel: expertPartyDisplayName({
      type: profile?.type ?? 'freelancer',
      agencyName,
      firstName,
      lastName,
    }),
    expertPersonLabel: personWithOrgLabel(expertPerson, agencyName),
  };
}
